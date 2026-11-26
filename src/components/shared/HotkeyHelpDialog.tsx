import React from 'react';
import { useTranslation } from 'react-i18next';
import { useSystemStore } from '../../stores/useSystemStore';
import { X } from 'lucide-react';
import { usePluginViewOverlay } from './usePluginViewOverlay';
import Modal from './Modal';

interface ShortcutRow {
  keys: string;
  actionKey: string;
  /** Keep Control key literal on macOS (e.g. Ctrl+Tab). */
  preserveCtrlOnMac?: boolean;
}

interface ShortcutCategory {
  id: string;
  titleKey: string;
  rows: ShortcutRow[];
}

const SHORTCUT_CATEGORIES: ShortcutCategory[] = [
  {
    id: 'global',
    titleKey: 'hotkeys.category.global',
    rows: [
      { keys: 'Ctrl+Shift+F', actionKey: 'hotkeys.globalSearch' },
      { keys: 'Ctrl+B', actionKey: 'hotkeys.toggleSidebar' },
      { keys: 'Ctrl+,', actionKey: 'hotkeys.openSettings' },
      { keys: 'Ctrl+/', actionKey: 'hotkeys.showHelp' },
      { keys: 'F1', actionKey: 'hotkeys.openDocs' },
      { keys: 'Escape', actionKey: 'hotkeys.closeModal' },
    ],
  },
  {
    id: 'terminal',
    titleKey: 'hotkeys.category.terminal',
    rows: [
      { keys: 'Ctrl+K', actionKey: 'hotkeys.toggleConnect' },
      { keys: 'Ctrl+L', actionKey: 'hotkeys.clearTerminal' },
      { keys: 'Ctrl+F', actionKey: 'hotkeys.focusSearch' },
      { keys: 'F3 / Shift+F3', actionKey: 'hotkeys.findNextPrev' },
    ],
  },
  {
    id: 'tabs',
    titleKey: 'hotkeys.category.tabsPanes',
    rows: [
      { keys: 'Ctrl+W', actionKey: 'hotkeys.closeTab' },
      { keys: 'Ctrl+Tab / Ctrl+Shift+Tab', actionKey: 'hotkeys.switchTab', preserveCtrlOnMac: true },
      { keys: 'Ctrl+1..9', actionKey: 'hotkeys.jumpTab' },
      { keys: 'F6', actionKey: 'hotkeys.cyclePane' },
    ],
  },
  {
    id: 'sidebar',
    titleKey: 'hotkeys.category.sidebar',
    rows: [
      { keys: 'Enter', actionKey: 'hotkeys.sidebarOpenPort' },
      { keys: 'Space', actionKey: 'hotkeys.sidebarToggleConnect' },
      { keys: 'Shift+F10', actionKey: 'hotkeys.contextMenu' },
    ],
  },
];

function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
}

function formatShortcut(keys: string, isMac: boolean, preserveCtrlOnMac?: boolean): string {
  if (!isMac) return keys;
  if (preserveCtrlOnMac) {
    return keys.replace(/Ctrl\+/g, '⌃').replace(/Shift\+/g, '⇧');
  }
  return keys.replace(/Ctrl\+/g, '⌘').replace(/Shift\+/g, '⇧');
}

const kbdStyle: React.CSSProperties = {
  background: 'var(--bg-secondary)',
  border: '1px solid var(--border-color)',
  borderRadius: 3,
  padding: '1px 6px',
  fontSize: 12,
  fontFamily: 'var(--font-terminal)',
  whiteSpace: 'nowrap',
};

const HotkeyHelpDialog: React.FC = () => {
  const { t } = useTranslation();
  const isOpen = useSystemStore((s) => s.ui.isHotkeyHelpOpen);
  const setUIState = useSystemStore((s) => s.setUIState);
  const overlayReady = usePluginViewOverlay(isOpen);

  if (!isOpen || !overlayReady) return null;

  const isMac = isMacPlatform();
  const close = () => setUIState({ isHotkeyHelpOpen: false });

  return (
    <Modal
      open
      onClose={close}
      labelledBy="hotkey-help-title"
      dialogClassName="modal-dialog-compact animate-slide-up"
      onOverlayClick={close}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <h3 className="modal-dialog-title" id="hotkey-help-title" style={{ margin: 0 }}>{t('hotkeys.title')}</h3>
        <button
          type="button"
          className="btn btn-icon btn-sm"
          onClick={close}
          title={t('hotkeys.close')}
          aria-label={t('hotkeys.close')}
        >
          <X size={14} />
        </button>
      </div>
      <div style={{ maxHeight: '65vh', overflowY: 'auto' }}>
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
            {SHORTCUT_CATEGORIES.map((category) => (
              <React.Fragment key={category.id}>
                <tr>
                  <th
                    colSpan={2}
                    scope="colgroup"
                    style={{
                      textAlign: 'left',
                      padding: '10px 8px 4px',
                      fontSize: 11,
                      fontWeight: 600,
                      letterSpacing: '0.04em',
                      textTransform: 'uppercase',
                      color: 'var(--text-secondary)',
                      borderBottom: '1px solid var(--border-subtle)',
                    }}
                  >
                    {t(category.titleKey)}
                  </th>
                </tr>
                {category.rows.map((row) => (
                  <tr key={`${category.id}:${row.keys}`}>
                    <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border-color)' }}>
                      <kbd style={kbdStyle}>{formatShortcut(row.keys, isMac, row.preserveCtrlOnMac)}</kbd>
                    </td>
                    <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border-color)', color: 'var(--text-primary)' }}>
                      {t(row.actionKey)}
                    </td>
                  </tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
};

export default HotkeyHelpDialog;
