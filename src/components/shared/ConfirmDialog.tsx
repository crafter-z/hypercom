import React, { useId } from 'react';
import { AlertTriangle } from 'lucide-react';
import Modal from './Modal';
import '../../styles/confirm-dialog.css';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: React.ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Small decision dialog for destructive / mass actions. It reuses the shared
 * Modal so it participates in the same focus-trap, Escape and focus-restore
 * contract as every other dialog.
 */
const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open, title, message, confirmLabel, cancelLabel, danger = false, onConfirm, onCancel,
}) => {
  const titleId = useId();
  return (
    <Modal
      open={open}
      onClose={onCancel}
      labelledBy={titleId}
      dialogClassName="modal-dialog-compact confirm-dialog animate-slide-up"
      onOverlayClick={onCancel}
    >
      <div className="confirm-dialog-heading">
        {danger && <AlertTriangle size={16} className="confirm-dialog-icon" aria-hidden="true" />}
        <h3 className="modal-dialog-title confirm-dialog-title" id={titleId}>{title}</h3>
      </div>
      <div className="confirm-dialog-message">{message}</div>
      <div className="confirm-dialog-actions">
        <button type="button" className="btn" onClick={onCancel}>{cancelLabel}</button>
        <button
          type="button"
          className={`btn ${danger ? 'btn-danger-solid' : 'btn-primary'}`}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
};

export default ConfirmDialog;
