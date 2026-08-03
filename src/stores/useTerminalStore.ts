import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { Encoding, TerminalState } from '../types';
import { useAppStore } from './useAppStore';

interface TerminalStoreState {
  terminals: Record<string, TerminalState>;

  ensureTerminal: (portId: string) => void;
  setTerminalConnectedAt: (portId: string, ts: number) => void;
  appendTerminalLine: (portId: string, line: TerminalState['lines'][number]) => void;
  appendTerminalLines: (portId: string, lines: TerminalState['lines']) => void;
  setTerminalLines: (portId: string, lines: TerminalState['lines']) => void;
  clearTerminal: (portId: string) => void;
  setTerminalConfig: (portId: string, patch: Partial<TerminalState>) => void;
  setTerminalEncoding: (portId: string, encoding: Encoding) => void;
}

const getConfiguredMaxLines = (): number => {
  const memoryLimitMb = useAppStore.getState().config.memoryLimitMb;
  return memoryLimitMb * 500 || 10000;
};

export const useTerminalStore = create<TerminalStoreState>()(
  immer((set) => ({
    terminals: {},

    ensureTerminal: (portId) => set((state) => {
      if (!state.terminals[portId]) {
        state.terminals[portId] = {
          lines: [],
          maxLines: getConfiguredMaxLines(),
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

    appendTerminalLine: (portId, line) => set((state) => {
      const term = state.terminals[portId];
      if (term) {
        term.lines.push(line);
        if (term.lines.length > term.maxLines) {
          term.lines.shift();
        }
      }
    }),

    // 批量追加成组 RX 行（RxPipeline rAF 批写用）：一次 set 完成，
    // push 全部后超限只做一次 splice——高频接收下避免逐行 produce 的开销。
    appendTerminalLines: (portId, lines) => set((state) => {
      const term = state.terminals[portId];
      if (!term) return;
      term.lines.push(...lines);
      if (term.lines.length > term.maxLines) {
        term.lines.splice(0, term.lines.length - term.maxLines);
      }
    }),

    // 批量替换缓冲区（弹出窗用主窗快照补历史）。保留最近 maxLines 行，
    // 与 appendTerminalLine 的上限语义一致。
    setTerminalLines: (portId, lines) => set((state) => {
      const term = state.terminals[portId];
      if (!term) return;
      term.lines = lines.length > term.maxLines
        ? lines.slice(lines.length - term.maxLines)
        : lines;
    }),

    clearTerminal: (portId) => set((state) => {
      const term = state.terminals[portId];
      if (term) term.lines = [];
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
          line.content = decoder.decode(new Uint8Array(line.rawData));
        }
      }
    }),
  }))
);
