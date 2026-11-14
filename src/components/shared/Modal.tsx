import React, { useCallback, useRef } from 'react';
import { useDialogLifecycle } from './useDialogLifecycle';

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
  /** Closing stays with the caller so press/release and saving guards survive. */
  onOverlayClick?: (event: React.MouseEvent<HTMLDivElement>) => void;
  disableEscape?: boolean;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  dialogRef?: React.Ref<HTMLDivElement>;
  children: React.ReactNode;
}

/** Styled dialog shell; custom shells share useDialogLifecycle, not a second trap. */
const Modal: React.FC<ModalProps> = ({
  open, onClose, labelledBy, label, describedBy, overlayClassName, dialogClassName,
  onOverlayClick, disableEscape = false, initialFocusRef, dialogRef: externalDialogRef, children,
}) => {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const assignDialogRef = useCallback((element: HTMLDivElement | null) => {
    dialogRef.current = element;
    if (!externalDialogRef) return;
    if (typeof externalDialogRef === 'function') externalDialogRef(element);
    else (externalDialogRef as React.MutableRefObject<HTMLDivElement | null>).current = element;
  }, [externalDialogRef]);
  useDialogLifecycle({ open, dialogRef, onClose, disableEscape, initialFocusRef });

  if (!open) return null;
  return (
    <div
      className={overlayClassName ? `modal-overlay ${overlayClassName}` : 'modal-overlay'}
      onClick={event => { if (event.target === event.currentTarget) onOverlayClick?.(event); }}
    >
      <div
        ref={assignDialogRef}
        className={dialogClassName ? `modal-dialog ${dialogClassName}` : 'modal-dialog'}
        role="dialog" aria-modal="true" aria-labelledby={labelledBy}
        aria-label={labelledBy ? undefined : label} aria-describedby={describedBy} tabIndex={-1}
      >
        {children}
      </div>
    </div>
  );
};

export default Modal;
