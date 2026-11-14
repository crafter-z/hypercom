import { flushSync } from 'react-dom';

/**
 * Publish the draft held by the focused editor before an external action.
 *
 * NumericInput (and other blur-committing editors) intentionally keep a raw
 * input buffer while typing. Native close requests and modal actions do not
 * reliably move focus first, so blur synchronously to make the draft visible
 * to save/leave participants before they inspect their state.
 */
export function flushFocusedEditor(): void {
  if (typeof document === 'undefined') return;
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return;
  flushSync(() => { activeElement.blur(); });
}

export default flushFocusedEditor;
