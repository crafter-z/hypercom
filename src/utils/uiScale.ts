import { getCurrentWebview } from '@tauri-apps/api/webview';

export function normalizeUiScalePercent(percent: number | null | undefined): number {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return 100;
  return Math.round(Math.max(80, Math.min(200, percent)));
}

// One queue per WebView realm: coalesce StrictMode effects and serialize native
// zoom calls so a slow earlier request cannot overwrite a newer setting.
let requestedPercent: number | null = null;
let lastAppliedPercent: number | null = null;
let applying = false;

export async function applyUiScale(percent: number | null | undefined): Promise<void> {
  requestedPercent = normalizeUiScalePercent(percent);
  if (applying) return;

  applying = true;
  try {
    while (requestedPercent !== null) {
      const next = requestedPercent;
      requestedPercent = null;
      if (next === lastAppliedPercent) continue;
      try {
        await getCurrentWebview().setZoom(next / 100);
        lastAppliedPercent = next;
      } catch (error) {
        console.warn('[uiScale] Failed to set WebView zoom:', error);
        // A failed native call must not leave a requested scale applied only
        // in application state. Restore the neutral scale unless a newer
        // request is already queued.
        if (next !== 100 && requestedPercent === null) requestedPercent = 100;
      }
    }
  } finally {
    applying = false;
  }
}
