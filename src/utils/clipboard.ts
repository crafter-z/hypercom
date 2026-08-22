/**
 * Clipboard write helper — Tauri plugin first, Web API fallback.
 *
 * `navigator.clipboard.writeText()` silently fails in Tauri v2 WebView2
 * (the `with_clipboard` flag / transient user activation often doesn't
 * propagate through async context-menu callbacks). The Tauri clipboard
 * plugin writes via Rust, bypassing the Web API restriction entirely.
 */
import { writeText } from '@tauri-apps/plugin-clipboard-manager';

/**
 * Write text to the clipboard. Uses the Tauri clipboard-manager plugin
 * (works in both main and popout webviews). Falls back to the Web Clipboard
 * API if the Tauri plugin is unavailable (e.g. in vitest/jsdom).
 */
export async function writeClipboardText(text: string): Promise<void> {
  if (!text) return;
  try {
    await writeText(text);
  } catch {
    // Fallback: Web Clipboard API (may work in some contexts).
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      console.error('[clipboard] Failed to write text via both Tauri and Web API');
    }
  }
}
