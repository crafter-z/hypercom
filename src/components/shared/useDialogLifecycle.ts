import { useLayoutEffect, useRef, type RefObject } from 'react';

interface DialogEntry {
  element: HTMLElement;
  initialFocusRef?: RefObject<HTMLElement | null>;
}

// One WebView-local owner stack, shared by styled Modal and custom dialog shells.
const dialogs: DialogEntry[] = [];
const FOCUSABLE = 'a[href],button,input:not([type="hidden"]),select,textarea,summary,[tabindex]';

function isAvailable(element: HTMLElement): boolean {
  if (!element.isConnected || element.matches(':disabled') || element.closest('[hidden],[inert],[aria-hidden="true"]')) return false;
  for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (ancestor.tagName === 'DETAILS' && !ancestor.hasAttribute('open')) {
      const summary = Array.from(ancestor.children).find(child => child.tagName === 'SUMMARY');
      if (!summary?.contains(element)) return false;
    }
  }
  return true;
}

function focusable(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(element =>
    (element.tabIndex >= 0 || element.tagName === 'SUMMARY' && !element.hasAttribute('tabindex')) &&
    element.closest('[role="dialog"],[role="alertdialog"]') === dialog && isAvailable(element));
}

function focusDialog(entry: DialogEntry): void {
  const preferred = entry.initialFocusRef?.current;
  const target = preferred && entry.element.contains(preferred) && isAvailable(preferred)
    ? preferred : focusable(entry.element)[0] ?? entry.element;
  target.focus({ preventScroll: true });
}

export interface DialogLifecycleOptions {
  open: boolean;
  dialogRef: RefObject<HTMLElement | null>;
  onClose?: () => void;
  disableEscape?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
}

/** Focus capture/restore, visible Tab cycle and topmost Escape ownership.
 * Business save/approval rules stay with onClose; custom shells keep their CSS. */
export function useDialogLifecycle({ open, dialogRef, onClose, disableEscape = false, initialFocusRef }: DialogLifecycleOptions): void {
  const latest = useRef({ onClose, disableEscape });
  latest.current = { onClose, disableEscape };
  useLayoutEffect(() => {
    const element = dialogRef.current;
    if (!open || !element) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const entry: DialogEntry = { element, initialFocusRef };
    // React mounts child layout effects first. A parent joining afterward must
    // sit below its already-mounted child, not steal its focus/keyboard owner.
    const descendant = dialogs.findIndex(item => element.contains(item.element));
    if (descendant >= 0) dialogs.splice(descendant, 0, entry);
    else dialogs.push(entry);
    if (dialogs[dialogs.length - 1] === entry) focusDialog(entry);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || dialogs[dialogs.length - 1] !== entry) return;
      const active = document.activeElement;
      const owningDialog = active instanceof Element ? active.closest('[role="dialog"],[role="alertdialog"]') : null;
      // Legacy/unmanaged overlays still own their keys while focused. Managed
      // lower dialogs never take ownership away from the current top dialog.
      if (owningDialog && owningDialog !== element && !dialogs.some(item => item.element === owningDialog)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!latest.current.disableEscape) latest.current.onClose?.();
      } else if (event.key === 'Tab') {
        const controls = focusable(element);
        const first = controls[0], last = controls[controls.length - 1];
        if (!first) {
          event.preventDefault();
          element.focus({ preventScroll: true });
        } else if (!element.contains(active)) {
          event.preventDefault();
          (event.shiftKey ? last! : first).focus({ preventScroll: true });
        } else if (event.shiftKey && (active === first || active === element)) {
          event.preventDefault();
          last!.focus({ preventScroll: true });
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus({ preventScroll: true });
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      const wasTop = dialogs[dialogs.length - 1] === entry;
      const index = dialogs.indexOf(entry);
      if (index >= 0) dialogs.splice(index, 1);
      if (!wasTop) return;
      const next = dialogs[dialogs.length - 1];
      if (previous && isAvailable(previous) && (!next || next.element.contains(previous))) previous.focus({ preventScroll: true });
      else if (next) focusDialog(next);
    };
  }, [open, dialogRef, initialFocusRef]);
}
