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
  /** Optional source serial port id — rendered as a chip by the notification
   *  center when the message originates from a serial port (issue #7-1). */
  portId?: string;
  /** Trusted source identity, assigned by the host rather than plugin arguments. */
  pluginId?: string;
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
  portId?: string;
  durationMs?: number;
}

interface ToastStoreState {
  /** Live toast stack rendered by ToastContainer (capped at MAX_VISIBLE). */
  toasts: ToastItem[];
  /** Overflowed core toasts are preserved; plugin backlog is separately bounded.
   *  The notification center shows live + stashed, newest first. */
  stashed: ToastItem[];
  /** Notification center popover visibility (bell in the StatusBar). */
  centerOpen: boolean;
  push: (input: ToastPushInput) => string;
  /** Silently drops plugin notifications exceeding their rate/backlog quota. */
  pushPlugin: (pluginId: string, input: PluginToastPushInput) => string | null;
  dismiss: (id: string) => void;
  /** Clears the live stack AND the stash. */
  clearAll: () => void;
  setCenterOpen: (open: boolean) => void;
}

const MAX_VISIBLE = 5;
const DEFAULT_DURATION_MS = 4000;
const ERROR_DURATION_MS = 6000;

type PluginToastPushInput = Pick<ToastPushInput, 'severity' | 'message' | 'title' | 'durationMs'>;

// Plugin-only limits: burst 5, refill 1/s, 20 retained per plugin and 100 total.
// Text limits count UTF-16 code units. Core/serial sticky notifications are exempt.
export const PLUGIN_NOTIFY_BURST = 5;
export const PLUGIN_NOTIFY_REFILL_MS = 1000;
export const PLUGIN_NOTIFY_MAX_PENDING = 20;
export const PLUGIN_NOTIFY_MAX_TOTAL_PENDING = 100;
export const PLUGIN_NOTIFY_MAX_TITLE = 256;
export const PLUGIN_NOTIFY_MAX_BODY = 4096;
export const PLUGIN_NOTIFY_MIN_DURATION_MS = 2000;
export const PLUGIN_NOTIFY_MAX_DURATION_MS = 30000;

const pluginBuckets = new Map<string, { tokens: number; updatedAt: number }>();

function consumePluginToken(pluginId: string, now: number): boolean {
  // Fully refilled buckets can be discarded, including those of unloaded plugins.
  for (const [id, bucket] of pluginBuckets) {
    if (now - bucket.updatedAt >= PLUGIN_NOTIFY_BURST * PLUGIN_NOTIFY_REFILL_MS) {
      pluginBuckets.delete(id);
    }
  }
  let bucket = pluginBuckets.get(pluginId);
  if (!bucket) {
    // Bound quota metadata too; do not evict active buckets and restore bursts.
    if (pluginBuckets.size >= PLUGIN_NOTIFY_MAX_TOTAL_PENDING) return false;
    bucket = { tokens: PLUGIN_NOTIFY_BURST, updatedAt: now };
    pluginBuckets.set(pluginId, bucket);
  }
  const elapsed = Math.max(0, now - bucket.updatedAt);
  bucket.tokens = Math.min(PLUGIN_NOTIFY_BURST, bucket.tokens + elapsed / PLUGIN_NOTIFY_REFILL_MS);
  bucket.updatedAt = Math.max(now, bucket.updatedAt);
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

function makeToast(input: ToastPushInput, pluginId?: string): ToastItem {
  return {
    id: genToastId(),
    severity: input.severity,
    messageKey: input.messageKey,
    message: input.message,
    title: input.title,
    portId: input.portId,
    pluginId,
    durationMs: input.durationMs ?? (input.severity === 'error' ? ERROR_DURATION_MS : DEFAULT_DURATION_MS),
    createdAt: Date.now(),
  };
}

function appendToast(state: Pick<ToastStoreState, 'toasts' | 'stashed'>, toast: ToastItem): void {
  state.toasts.push(toast);
  // Core overflow remains preserved, including sticky and serial notifications.
  if (state.toasts.length > MAX_VISIBLE) {
    state.stashed.push(...state.toasts.splice(0, state.toasts.length - MAX_VISIBLE));
  }
}

// Toast id style mirrors the terminal line id pattern used in useTauri.ts
// (`line-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`).
let toastCounter = 0;
function genToastId(): string {
  toastCounter += 1;
  return `toast-${Date.now()}-${toastCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

export const useToastStore = create<ToastStoreState>()(
  immer((set, get) => ({
    toasts: [],
    stashed: [],
    centerOpen: false,

    push: (input) => {
      const toast = makeToast(input);
      set((state) => appendToast(state, toast));
      return toast.id;
    },

    pushPlugin: (pluginId, input) => {
      const state = get();
      if (!consumePluginToken(pluginId, Date.now())) return null;
      let pending = 0;
      let total = 0;
      for (const toast of state.stashed) {
        if (toast.pluginId !== undefined) total += 1;
        if (toast.pluginId === pluginId) pending += 1;
      }
      for (const toast of state.toasts) {
        if (toast.pluginId !== undefined) total += 1;
        if (toast.pluginId === pluginId) pending += 1;
      }
      if (pending >= PLUGIN_NOTIFY_MAX_PENDING || total >= PLUGIN_NOTIFY_MAX_TOTAL_PENDING) return null;
      const requested = typeof input.durationMs === 'number' && Number.isFinite(input.durationMs)
        ? input.durationMs : DEFAULT_DURATION_MS;
      const toast = makeToast({
        severity: input.severity,
        title: input.title?.slice(0, PLUGIN_NOTIFY_MAX_TITLE),
        message: input.message?.slice(0, PLUGIN_NOTIFY_MAX_BODY),
        durationMs: Math.min(PLUGIN_NOTIFY_MAX_DURATION_MS, Math.max(PLUGIN_NOTIFY_MIN_DURATION_MS, requested)),
      }, pluginId);
      set((draft) => appendToast(draft, toast));
      return toast.id;
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