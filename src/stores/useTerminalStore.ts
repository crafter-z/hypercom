import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { Encoding, TerminalLine, TerminalState } from '../types';
import { useAppStore } from './useAppStore';

/** 字节→行数换算：旧语义 maxLines = memoryLimitMb * 500；issue #6-2 改为每端口预算驱动。 */
const LINES_PER_BUDGET_MB = 500;

/**
 * 单行占用字节数：优先 rawData（Uint8Array 长度即真实字节数，O(1)）；
 * 无 rawData 的 TX/TOOL 行退回 content 的 UTF-8 字节数（近似，低频路径可接受）。
 */
function lineBytes(line: TerminalLine): number {
  if (line.rawData) return line.rawData.length;
  return new TextEncoder().encode(line.content).length;
}

/** 从配置取当前每端口预算（MB）→ 字节。undefined 才回退默认 200（0 是合法值，表示立即裁剪）。 */
function getPerPortBudgetBytes(): number {
  const mb = useAppStore.getState().config.memoryPerPortBudgetMb ?? 200;
  return mb * 1024 * 1024;
}

/** 从配置取当前总预算（MB）→ 字节。 */
function getTotalBudgetBytes(): number {
  const mb = useAppStore.getState().config.memoryLimitMb ?? 2048;
  return mb * 1024 * 1024;
}

interface TerminalStoreState {
  terminals: Record<string, TerminalState>;

  ensureTerminal: (portId: string) => void;
  setTerminalConnectedAt: (portId: string, ts: number) => void;
  /** 追加单行（TX/工具/回放）。返回 true = 触发过内存裁剪。 */
  appendTerminalLine: (portId: string, line: TerminalLine) => boolean;
  /** 批量追加成组 RX 行（RxPipeline rAF 批写）。返回 true = 触发过内存裁剪。 */
  appendTerminalLines: (portId: string, lines: TerminalLine[]) => boolean;
  setTerminalLines: (portId: string, lines: TerminalLine[]) => void;
  clearTerminal: (portId: string) => void;
  setTerminalConfig: (portId: string, patch: Partial<TerminalState>) => void;
  setTerminalEncoding: (portId: string, encoding: Encoding) => void;
}

/** 按「每端口预算（MB）× 500」派生行数上限（与旧 memoryLimitMb×500 同量纲）。 */
const getConfiguredMaxLines = (): number => {
  const budgetMb = useAppStore.getState().config.memoryPerPortBudgetMb ?? 200;
  return budgetMb * LINES_PER_BUDGET_MB || 10_000;
};

/**
 * 单端口内存裁剪核心（issue #6-2）：超出【每端口硬约束 maxBytes】或【总预算软
 * 兜底】任一限制后，一次性清除该端口最早的一半屏（批量裁剪，避免每帧裁剪引发
 * 的 re-key 风暴）。返回是否裁剪。纯 state 变更，无副作用——「因内存限制清屏」
 * 的通知由调用方（RxPipeline 接线层）在返回 true 时弹出。
 *
 * 优先级：单端口 200MB 硬约束优先；总预算 2048MB 软兜底——先触发谁先裁谁
 * （本端口正在接收数据、正是内存增长点，总预算超限时裁它最直接）。
 */
function trimIfOverBudget(term: TerminalState): boolean {
  const overPerPort = term.totalBytes > term.maxBytes;
  const overTotalBudget =
    useAppStore.getState().systemStatus.memoryUsedMb > 0 &&
    useAppStore.getState().systemStatus.memoryUsedMb * 1024 * 1024 >= getTotalBudgetBytes();
  if (!overPerPort && !overTotalBudget && term.lines.length <= term.maxLines) {
    return false;
  }

  // 一次性裁到 50%（半屏后的行数必然 ≤ maxLines）
  const keep = Math.max(1, Math.floor(term.lines.length / 2));
  term.lines.splice(0, term.lines.length - keep);
  // 重算字节记账（裁剪低频，O(n) 可接受；保持后续 append 的 O(1) 记账准确）
  term.totalBytes = 0;
  for (const line of term.lines) {
    term.totalBytes += lineBytes(line);
  }
  return true;
}

export const useTerminalStore = create<TerminalStoreState>()(
  immer((set) => ({
    terminals: {},

    ensureTerminal: (portId) => set((state) => {
      if (!state.terminals[portId]) {
        state.terminals[portId] = {
          lines: [],
          maxLines: getConfiguredMaxLines(),
          totalBytes: 0,
          maxBytes: getPerPortBudgetBytes(),
          scrollLocked: true,
          showTimestamp: true,
          displayFormat: 'string',
          encoding: 'ASCII',
          connectedAt: null,
        };
      }
    }),

    setTerminalConnectedAt: (portId, ts) => set((state) => {
      const term = state.terminals[portId];
      if (term) {
        term.connectedAt = ts;
      }
    }),

    appendTerminalLine: (portId, line) => {
      // 注意：immer recipe 返回非 undefined 会用返回值替换整个 state，
      // 因此裁剪结果必须经闭包变量带出，recipe 内只 return undefined。
      let trimmed = false;
      set((state) => {
        const term = state.terminals[portId];
        if (!term) return;
        term.lines.push(line);
        term.totalBytes += lineBytes(line);
        trimmed = trimIfOverBudget(term);
      });
      return trimmed;
    },

    // 批量追加成组 RX 行（RxPipeline rAF 批写用）：一次 set 完成，
    // push 全部后超限只做一次 splice——高频接收下避免逐行 produce 的开销。
    appendTerminalLines: (portId, lines) => {
      let trimmed = false;
      set((state) => {
        const term = state.terminals[portId];
        if (!term) return;
        term.lines.push(...lines);
        let added = 0;
        for (const line of lines) added += lineBytes(line);
        term.totalBytes += added;
        trimmed = trimIfOverBudget(term);
      });
      return trimmed;
    },

    // 批量替换缓冲区（弹出窗用主窗快照补历史）。保留最近 maxLines 行，
    // 与 appendTerminalLine 的上限语义一致；重算字节记账。
    setTerminalLines: (portId, lines) => set((state) => {
      const term = state.terminals[portId];
      if (!term) return;
      term.lines = lines.length > term.maxLines
        ? lines.slice(lines.length - term.maxLines)
        : lines;
      term.totalBytes = 0;
      for (const line of term.lines) term.totalBytes += lineBytes(line);
    }),

    clearTerminal: (portId) => set((state) => {
      const term = state.terminals[portId];
      if (term) {
        term.lines = [];
        term.totalBytes = 0;
      }
    }),

    setTerminalConfig: (portId, patch) => set((state) => {
      const term = state.terminals[portId];
      if (term) Object.assign(term, patch);
    }),

    setTerminalEncoding: (portId, encoding) => set((state) => {
      const term = state.terminals[portId];
      if (!term) return;
      term.encoding = encoding;
      // Re-decode existing lines from raw bytes so the switch is immediately visible.
      const label = encoding.toLowerCase() === 'ascii' ? 'utf-8' : encoding.toLowerCase();
      let decoder: TextDecoder;
      try { decoder = new TextDecoder(label, { fatal: false }); }
      catch { decoder = new TextDecoder('utf-8', { fatal: false }); }
      for (const line of term.lines) {
        if (line.rawData && line.rawData.length > 0 && (!line.parsedFields || line.parsedFields.length === 0)) {
          // rawData 已是 Uint8Array（issue #6-2），直接解码不再拷贝
          line.content = decoder.decode(line.rawData);
        }
      }
    }),
  }))
);
