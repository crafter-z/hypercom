import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePluginViewOverlay } from '../shared/usePluginViewOverlay';
import Modal from '../shared/Modal';

export interface AliasDialogProps {
  portId: string;
  currentAlias: string;
  onSave: (alias: string) => void;
  onCancel: () => void;
}

const AliasDialog: React.FC<AliasDialogProps> = ({
  portId,
  currentAlias,
  onSave,
  onCancel,
}) => {
  const [value, setValue] = useState(currentAlias);
  const { t } = useTranslation();
  const overlayReady = usePluginViewOverlay();
  const inputRef = useRef<HTMLInputElement>(null);
  if (!overlayReady) return null;

  return (
    <Modal
      open
      onClose={onCancel}
      labelledBy="alias-dialog-title"
      dialogClassName="modal-dialog-compact animate-slide-up"
      onOverlayClick={onCancel}
      initialFocusRef={inputRef}
    >
      <h3 className="modal-dialog-title" id="alias-dialog-title">{t('aliasDialog.title')}</h3>
      <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 12 }}>
        {t('aliasDialog.description', { portId })}
      </p>
      <input
        ref={inputRef}
        className="input modal-dialog-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={t('aliasDialog.input.placeholder')}
        onKeyDown={(e) => { if (e.key === 'Enter') onSave(value); if (e.key === 'Escape') onCancel(); }}
      />
      <div className="modal-dialog-actions">
        <button className="btn" onClick={onCancel}>{t('aliasDialog.cancel')}</button>
        <button className="btn btn-primary" onClick={() => onSave(value)}>{t('aliasDialog.confirm')}</button>
      </div>
    </Modal>
  );
};

export default AliasDialog;
