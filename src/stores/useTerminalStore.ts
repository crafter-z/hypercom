import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { TerminalState } from '../types';
import { useAppStore } from './useAppStore';

interface TerminalStoreState {
  terminals: Record<string, TerminalState>;

  ensureTerminal: (portId: string) => void;
  appendTerminalLine: (portId: string, line: TerminalState['lines'][number]) => void;
  clearTerminal: (portId: string) => void;
  setTerminalConfig: (portId: string, patch: Partial<TerminalState>) => void;
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
        };
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

    clearTerminal: (portId) => set((state) => {
      const term = state.terminals[portId];
      if (term) term.lines = [];
    }),

    setTerminalConfig: (portId, patch) => set((state) => {
      const term = state.terminals[portId];
      if (term) Object.assign(term, patch);
    }),
  }))
);
