/**
 * Toast notification store (Zustand + Immer).
 *
 * Owns ONLY the toast stack. Use `push` / `dismiss` from components,
 * or the convenience helpers `notifyError` / `notifySuccess` from anywhere
 * (hooks, services, etc.) to surface user-visible notifications.
 *
 * Severity labels and the generic fallback live under the `toast.*` i18n keys
 * (see `src/i18n.ts`).
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import i18n from '../i18n';

export type ToastSeverity = 'info' | 'success' | 'warning' | 'error';

export interface ToastItem {
  id: string;
  severity: ToastSeverity;
  /** i18n key — when set, the Toast component translates it. */
  messageKey?: string;
  /** Raw message — shown verbatim when `messageKey` is absent. */
  message?: string;
  /** Optional title — rendered by the notification center (bell popover). */
  title?: string;
  /** Auto-dismiss delay in ms. `0` = sticky: NO auto-dismiss (persists until
   *  dismissed or cleared). Defaults to DEFAULT_DURATION_MS (or ERROR_* for
   *  error severity) when omitted. */
  durationMs: number;
  createdAt: number;
}

export interface ToastPushInput {
  severity: ToastSeverity;
  messageKey?: string;
  message?: string;
  title?: string;
  durationMs?: number;
}

interface ToastStoreState {
  /** Live toast stack rendered by ToastContainer (capped at MAX_VISIBLE). */
  toasts: ToastItem[];
  /** Overflowed toasts (beyond MAX_VISIBLE). Nothing is dropped — the
   *  notification center shows live + stashed, newest first. */
  stashed: ToastItem[];
  /** Notification center popover visibility (bell in the StatusBar). */
  centerOpen: boolean;
  push: (input: ToastPushInput) => string;
  dismiss: (id: string) => void;
  /** Clears the live stack AND the stash. */
  clearAll: () => void;
  setCenterOpen: (open: boolean) => void;
}

const MAX_VISIBLE = 5;
const DEFAULT_DURATION_MS = 4000;
const ERROR_DURATION_MS = 6000;

// Toast id style mirrors the terminal line id pattern used in useTauri.ts
// (`line-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`).
let toastCounter = 0;
function genToastId(): string {
  toastCounter += 1;
  return `toast-${Date.now()}-${toastCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

export const useToastStore = create<ToastStoreState>()(
  immer((set) => ({
    toasts: [],
    stashed: [],
    centerOpen: false,

    push: (input) => {
      const id = genToastId();
      const durationMs =
        input.durationMs ?? (input.severity === 'error' ? ERROR_DURATION_MS : DEFAULT_DURATION_MS);
      const toast: ToastItem = {
        id,
        severity: input.severity,
        messageKey: input.messageKey,
        message: input.message,
        title: input.title,
        durationMs,
        createdAt: Date.now(),
      };
      set((state) => {
        state.toasts.push(toast);
        // Overflow: the oldest live toasts move into the notification-center
        // stash instead of being dropped — nothing is lost anymore.
        if (state.toasts.length > MAX_VISIBLE) {
          const overflowCount = state.toasts.length - MAX_VISIBLE;
          const overflowed = state.toasts.splice(0, overflowCount);
          state.stashed.push(...overflowed);
        }
      });
      return id;
    },

    dismiss: (id) =>
      set((state) => {
        const liveIdx = state.toasts.findIndex((t) => t.id === id);
        if (liveIdx >= 0) {
          state.toasts.splice(liveIdx, 1);
          return;
        }
        const stashIdx = state.stashed.findIndex((t) => t.id === id);
        if (stashIdx >= 0) state.stashed.splice(stashIdx, 1);
      }),

    clearAll: () =>
      set((state) => {
        state.toasts = [];
        state.stashed = [];
      }),

    setCenterOpen: (open) =>
      set((state) => {
        state.centerOpen = open;
      }),
  }))
);

// ==================== Convenience helpers ====================
// Use from non-React code (hooks, services) to surface failures without
// subscribing to the store. They go through getState() so they never trigger
// a re-render of the caller.

export function extractErrorMessage(e: unknown): string {
  if (e == null) return '';
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  // Tauri CommandError serializes to a plain string via manual serde::Serialize,
  // so the caught value is usually a string already. Guard for object shapes
  // just in case a service wraps it.
  if (typeof e === 'object' && 'message' in e) {
    const msg = (e as { message: unknown }).message;
    if (typeof msg === 'string') return msg;
  }
  try {
    return String(e);
  } catch {
    return '';
  }
}

/**
 * Surface an unknown error value as an error toast. The extracted message is
 * shown verbatim (Tauri CommandError strings like `"Serial error: PORT_NOT_FOUND"`
 * are already user-readable). If the message is empty/whitespace, the
 * translated `fallbackKey` (default `toast.fallback.operationFailed`) is used.
 */
export function notifyError(e: unknown, fallbackKey: string = 'toast.fallback.operationFailed'): void {
  const raw = extractErrorMessage(e).trim();
  const message = raw || i18n.t(fallbackKey);
  useToastStore.getState().push({ severity: 'error', message });
}

/**
 * Surface a success toast. The message is provided as an i18n key so the
 * rendered text follows the active language.
 */
export function notifySuccess(msgKey: string): void {
  useToastStore.getState().push({ severity: 'success', messageKey: msgKey });
}

/**
 * Surface a neutral informational toast (e.g. "nothing found" feedback for
 * an action that otherwise no-ops silently). Message is an i18n key.
 */
export function notifyInfo(msgKey: string): void {
  useToastStore.getState().push({ severity: 'info', messageKey: msgKey });
}