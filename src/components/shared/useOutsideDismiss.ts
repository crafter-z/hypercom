import { useEffect } from 'react';
import type { RefObject } from 'react';

/**
 * Dismiss a floating panel when the user presses outside it or hits Escape.
 *
 * The app has three independent popovers (ContextMenu, TextEditContextMenu,
 * NotificationCenter) that each hand-rolled this listener pair — including the
 * same caveat that the element owning the ref may also own the trigger button,
 * whose own onClick must keep toggling instead of being dismissed here. One
 * implementation keeps that semantic in exactly one place: presses inside the
 * ref never dismiss, presses outside it and Escape always do.
 *
 * `active` gates the listeners so a closed panel costs nothing; `onDismiss`
 * may change identity every render (it is re-read from the listener closure
 * only through the effect dependency, so pass a stable callback when the
 * panel stays open across renders).
 */
export function useOutsideDismiss(
  ref: RefObject<HTMLElement | null>,
  onDismiss: () => void,
  active = true,
): void {
  useEffect(() => {
    if (!active) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!ref.current || ref.current.contains(e.target as Node)) return;
      onDismiss();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [ref, onDismiss, active]);
}
