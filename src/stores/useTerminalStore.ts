/**
 * useTerminalStore — per-tab terminal DISPLAY state (方案B, issue #14).
 *
 * Holds ONLY the display fields a terminal view needs to render (scroll lock,
 * timestamp visibility, display format, encoding, connection time). The line
 * buffer itself moved OUT of the store into `TerminalViewportManager`'s ring
 * buffer (`src/utils/terminal/`) — the store no longer reacts to data; the
 * renderer draws directly.
 *
 * Display-state updates are shallow and user-initiated — plain immutable
 * `set()` (no Immer middleware, no line arrays).
 */
import { create } from 'zustand';
import type { Encoding, TerminalState } from '../types';

export interface TerminalStoreState {
  terminals: Record<string, TerminalState>;

  /** Create display state for a port if absent (idempotent). */
  ensureTerminal: (portId: string) => void;
  setTerminalConnectedAt: (portId: string, ts: number) => void;
  /** Patch display fields (scrollLocked / showTimestamp / displayFormat …).
   *  NOTE: encoding must NOT be written here — use `setTerminalEncoding` so
   *  the renderer re-decodes (lazy-decode path). */
  setTerminalConfig: (portId: string, patch: Partial<TerminalState>) => void;
  /** Switch the encoding label; the renderer re-decodes visible rows on the
   *  next redraw (no store-side buffer walk — issue #14). */
  setTerminalEncoding: (portId: string, encoding: Encoding) => void;
}

const DEFAULT_TERMINAL_STATE = (): TerminalState => ({
  scrollLocked: true,
  showTimestamp: true,
  displayFormat: 'string',
  encoding: 'ASCII',
  connectedAt: null,
});

export const useTerminalStore = create<TerminalStoreState>((set) => ({
  terminals: {},

  ensureTerminal: (portId) =>
    set((state) => {
      if (state.terminals[portId]) return {};
      return { terminals: { ...state.terminals, [portId]: DEFAULT_TERMINAL_STATE() } };
    }),

  setTerminalConnectedAt: (portId, ts) =>
    set((state) => {
      const term = state.terminals[portId];
      if (!term || term.connectedAt === ts) return {};
      return { terminals: { ...state.terminals, [portId]: { ...term, connectedAt: ts } } };
    }),

  setTerminalConfig: (portId, patch) =>
    set((state) => {
      const term = state.terminals[portId];
      if (!term) return {};
      return { terminals: { ...state.terminals, [portId]: { ...term, ...patch } } };
    }),

  setTerminalEncoding: (portId, encoding) =>
    set((state) => {
      const term = state.terminals[portId];
      if (!term || term.encoding === encoding) return {};
      return { terminals: { ...state.terminals, [portId]: { ...term, encoding } } };
    }),
}));
