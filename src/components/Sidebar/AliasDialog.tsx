import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

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

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-dialog animate-slide-up" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-dialog-title">{t('aliasDialog.title')}</h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 12 }}>
          {t('aliasDialog.description', { portId })}
        </p>
        <input
          className="input modal-dialog-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={t('aliasDialog.input.placeholder')}
          autoFocus
          onKeyDown={(e) => { if (e.key === 'Enter') onSave(value); if (e.key === 'Escape') onCancel(); }}
        />
        <div className="modal-dialog-actions">
          <button className="btn" onClick={onCancel}>{t('aliasDialog.cancel')}</button>
          <button className="btn btn-primary" onClick={() => onSave(value)}>{t('aliasDialog.confirm')}</button>
        </div>
      </div>
    </div>
  );
};

export default AliasDialog;
