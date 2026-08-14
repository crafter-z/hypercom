import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { Encoding, TerminalLine, TerminalState } from '../types';
import { useAppStore } from './useAppStore';

/** 字节→行数换算：旧语义 maxLines = memoryLimitMb * 500；issue #6-2 改为每端口预算驱动。 */
const LINES_PER_BUDGET_MB = 500;

/**
 * 总预算软兜底裁剪冷却（issue：多串口压测日志只加载半页就被前半页刷新掉）：
 * `overTotalBudget` 读的是 5s 轮询的应用 RSS 采样，RSS 一旦 ≥ memoryLimitMb 就
 * 会持续满足——若无冷却，每个 append 批都会把该端口缓冲裁到 50%，高频接收下
 * 用户视野里"刚加载的半页又被前半页顶掉"的现象反复出现。加每端口冷却后，软
 * 兜底至多每 10s 触发一次（与 toast 节流同量级），硬约束（bytes/maxLines）不受影响。
 */
const SOFT_TRIM_COOLDOWN_MS = 10_000;
const lastSoftTrimAt = new Map<string, number>();

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
 * 内存裁剪核心（issue #6-2 + 热插拔压测修复）：返回是否裁剪。纯 state 变更，
 * 无副作用——「因内存限制清屏」的通知由调用方（RxPipeline 接线层）在返回 true
 * 时弹出。裁剪时机分两类：
 *
 * 1) 硬约束（本端口字节超 maxBytes / 行数超 maxLines）——立即裁，每次 append
 *    都检查，触发即裁到 50%。这是每端口真正的上限，必须无条件生效。
 * 2) 总预算软兜底（应用 RSS ≥ memoryLimitMb）——**不再每个 append 都裁**：
 *    - 只裁「本端口缓冲已相当可观」（totalBytes > maxBytes 的 50%）的端口——
 *      小缓冲不是 RSS 超限的元凶，裁它只会让用户看到"半页就被刷掉"。
 *    - 每端口冷却 `SOFT_TRIM_COOLDOWN_MS`（10s）内不重复软裁——RSS 采样是
 *      5s 一次、超限后会持续满足，无冷却则高频接收下每批都裁（半页反复被
 *      前半页顶掉的根因）。
 *
 * 优先级不变：每端口硬约束优先；总预算软兜底——先触发谁先裁谁。软兜底冷却
 * 用模块级 Map（portId → 上次软裁时间戳），与 toast 节流同量级、不随 store 快照。
 */
function trimIfOverBudget(portId: string, term: TerminalState): boolean {
  const overPerPort = term.totalBytes > term.maxBytes;
  const overTotalBudget =
    useAppStore.getState().systemStatus.memoryUsedMb > 0 &&
    useAppStore.getState().systemStatus.memoryUsedMb * 1024 * 1024 >= getTotalBudgetBytes();
  if (!overPerPort && !overTotalBudget && term.lines.length <= term.maxLines) {
    return false;
  }

  if (overTotalBudget && !overPerPort && term.lines.length <= term.maxLines) {
    // 软兜底路径：本端口缓冲不小 + 冷却窗口内未裁过才裁；否则跳过（下次 append
    // 再评估）。行数超 maxLines 的硬约束不受冷却限制。
    if (term.totalBytes <= term.maxBytes / 2) return false;
    const now = Date.now();
    const lastAt = lastSoftTrimAt.get(portId) ?? 0;
    if (now - lastAt < SOFT_TRIM_COOLDOWN_MS) return false;
    lastSoftTrimAt.set(portId, now);
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
        trimmed = trimIfOverBudget(portId, term);
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
        trimmed = trimIfOverBudget(portId, term);
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
