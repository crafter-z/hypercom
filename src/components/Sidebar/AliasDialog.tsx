import React, { useState } from 'react';

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

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-dialog animate-slide-up" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-dialog-title">设置备注名</h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 12 }}>
          为 <strong>{portId}</strong> 设置备注名
        </p>
        <input
          className="input modal-dialog-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="输入备注名..."
          autoFocus
          onKeyDown={(e) => { if (e.key === 'Enter') onSave(value); if (e.key === 'Escape') onCancel(); }}
        />
        <div className="modal-dialog-actions">
          <button className="btn" onClick={onCancel}>取消</button>
          <button className="btn btn-primary" onClick={() => onSave(value)}>确定</button>
        </div>
      </div>
    </div>
  );
};

export default AliasDialog;
