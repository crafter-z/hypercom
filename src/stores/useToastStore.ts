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
  durationMs: number;
  createdAt: number;
}

export interface ToastPushInput {
  severity: ToastSeverity;
  messageKey?: string;
  message?: string;
  durationMs?: number;
}

interface ToastStoreState {
  toasts: ToastItem[];
  push: (input: ToastPushInput) => string;
  dismiss: (id: string) => void;
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

    push: (input) => {
      const id = genToastId();
      const durationMs =
        input.durationMs ?? (input.severity === 'error' ? ERROR_DURATION_MS : DEFAULT_DURATION_MS);
      const toast: ToastItem = {
        id,
        severity: input.severity,
        messageKey: input.messageKey,
        message: input.message,
        durationMs,
        createdAt: Date.now(),
      };
      set((state) => {
        state.toasts.push(toast);
        // Overflow: drop oldest beyond MAX_VISIBLE (they fade out via CSS).
        if (state.toasts.length > MAX_VISIBLE) {
          state.toasts.splice(0, state.toasts.length - MAX_VISIBLE);
        }
      });
      return id;
    },

    dismiss: (id) =>
      set((state) => {
        const idx = state.toasts.findIndex((t) => t.id === id);
        if (idx >= 0) state.toasts.splice(idx, 1);
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