import React, { useCallback, useEffect, useRef } from 'react';

/**
 * Interactive elements inside a dialog, in DOM order. Hidden/disabled/inert
 * elements are excluded so the focus trap never parks focus on something the
 * user cannot operate.
 */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function getFocusable(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => element.tabIndex >= 0
      && !element.hasAttribute('inert') && !element.closest('[inert]')
      && element.getAttribute('aria-hidden') !== 'true',
  );
}

export interface ModalProps {
  open: boolean;
  onClose?: () => void;
  /** id of the visible title element (preferred). */
  labelledBy?: string;
  /** Accessible name when the dialog has no visible title to reference. */
  label?: string;
  describedBy?: string;
  overlayClassName?: string;
  dialogClassName?: string;
  /**
   * Called for a click whose target is the overlay. Closing is the caller's
   * decision so press/release and saving guards stay with the feature.
   */
  onOverlayClick?: (event: React.MouseEvent<HTMLDivElement>) => void;
  disableEscape?: boolean;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  /** Optional handle for features that need the dialog element (e.g. guards). */
  dialogRef?: React.Ref<HTMLDivElement>;
  children: React.ReactNode;
}

/**
 * Accessible modal shell. Renders the existing modal-overlay / modal-dialog
 * classes and owns focus capture, the Tab cycle, Escape, and focus restoration.
 */
const Modal: React.FC<ModalProps> = ({
  open,
  onClose,
  labelledBy,
  label,
  describedBy,
  overlayClassName,
  dialogClassName,
  onOverlayClick,
  disableEscape = false,
  initialFocusRef,
  dialogRef: externalDialogRef,
  children,
}) => {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const assignDialogRef = useCallback((element: HTMLDivElement | null) => {
    dialogRef.current = element;
    if (!externalDialogRef) return;
    if (typeof externalDialogRef === 'function') externalDialogRef(element);
    else (externalDialogRef as React.MutableRefObject<HTMLDivElement | null>).current = element;
  }, [externalDialogRef]);

  useEffect(() => {
    if (!open) return undefined;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    const target = initialFocusRef?.current ?? getFocusable(dialog)[0] ?? dialog;
    target.focus({ preventScroll: true });
    return () => {
      const previous = restoreFocusRef.current;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [open, initialFocusRef]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog) return;

      if (event.key === 'Escape' && !disableEscape) {
        if (event.defaultPrevented) return;
        // A nested dialog (its own Escape handling) owns the key while focus is
        // inside it. Compare against our dialog so portalled children still win.
        const active = document.activeElement;
        const owningDialog = active instanceof Element ? active.closest('[role="dialog"]') : null;
        if (owningDialog && owningDialog !== dialog) return;
        event.preventDefault();
        onClose?.();
        return;
      }

      if (event.key !== 'Tab') return;
      const focusable = getFocusable(dialog);
      const active = document.activeElement;
      // A nested dialog owns Tab while focus is inside it. Without this guard
      // the parent's trap would yank focus back into the parent on every Tab.
      const owningDialog = active instanceof Element ? active.closest('[role="dialog"]') : null;
      if (owningDialog && owningDialog !== dialog) return;
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!dialog.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && (active === first || active === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, disableEscape, onClose]);

  if (!open) return null;

  return (
    <div
      className={overlayClassName ? `modal-overlay ${overlayClassName}` : 'modal-overlay'}
      onClick={(event) => {
        if (event.target === event.currentTarget) onOverlayClick?.(event);
      }}
    >
      <div
        ref={assignDialogRef}
        className={dialogClassName ? `modal-dialog ${dialogClassName}` : 'modal-dialog'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-label={labelledBy ? undefined : label}
        aria-describedby={describedBy}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>
  );
};

export default Modal;
