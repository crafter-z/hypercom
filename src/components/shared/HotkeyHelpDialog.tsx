import React from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../stores/useAppStore';
import { X } from 'lucide-react';

interface ShortcutRow {
  keys: string;
  actionKey: string;
}

const SHORTCUTS: ShortcutRow[] = [
  { keys: 'Ctrl+L', actionKey: 'hotkeys.clearTerminal' },
  { keys: 'Ctrl+F', actionKey: 'hotkeys.focusSearch' },
  { keys: 'Ctrl+K', actionKey: 'hotkeys.toggleConnect' },
  { keys: 'Ctrl+/', actionKey: 'hotkeys.showHelp' },
  { keys: 'Escape', actionKey: 'hotkeys.closeModal' },
];

const HotkeyHelpDialog: React.FC = () => {
  const { t } = useTranslation();
  const isOpen = useAppStore((s) => s.ui.isHotkeyHelpOpen);
  const setUIState = useAppStore((s) => s.setUIState);

  if (!isOpen) return null;

  const close = () => setUIState({ isHotkeyHelpOpen: false });

  return (
    <div className="modal-overlay" onClick={close}>
      <div className="modal-dialog-compact animate-slide-up" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h3 className="modal-dialog-title" style={{ margin: 0 }}>{t('hotkeys.title')}</h3>
          <button className="btn btn-icon btn-sm" onClick={close} title={t('hotkeys.close')}>
            <X size={14} />
          </button>
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--border-color)', color: 'var(--text-secondary)', fontWeight: 500 }}>
                {t('hotkeys.shortcut')}
              </th>
              <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--border-color)', color: 'var(--text-secondary)', fontWeight: 500 }}>
                {t('hotkeys.action')}
              </th>
            </tr>
          </thead>
          <tbody>
            {SHORTCUTS.map((row) => (
              <tr key={row.keys}>
                <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border-color)' }}>
                  <kbd style={{
                    background: 'var(--bg-secondary)',
                    border: '1px solid var(--border-color)',
                    borderRadius: 3,
                    padding: '1px 6px',
                    fontSize: 12,
                    fontFamily: 'var(--font-terminal)',
                  }}>{row.keys}</kbd>
                </td>
                <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border-color)', color: 'var(--text-primary)' }}>
                  {t(row.actionKey)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default HotkeyHelpDialog;
