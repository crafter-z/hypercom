/** Clipboard writes for host UI: native Tauri plugin first, Web API fallback. */
import { writeText } from '@tauri-apps/plugin-clipboard-manager';

/**
 * Use the existing clipboard-manager capability in main/popout WebViews rather
 * than depending on WebView transient activation. Browser previews can fall
 * back to the Web Clipboard API (subject to its own permission policy).
 *
 * A rejected write must remain observable: callers must not report success or
 * delete a cut selection when neither backend wrote the text. Empty strings
 * are valid writes too (for example, a HEX conversion can produce no text).
 */
export async function writeClipboardText(text: string): Promise<void> {
  try {
    await writeText(text);
  } catch (nativeError) {
    if (typeof navigator === 'undefined' || typeof navigator.clipboard?.writeText !== 'function') {
      throw nativeError;
    }
    // Do not swallow this failure. UI actions catch it and report the error;
    // async callers (notably cut) must only proceed after an actual write.
    await navigator.clipboard.writeText(text);
  }
}
