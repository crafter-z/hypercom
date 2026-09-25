import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../stores/useAppStore';
import { useSystemStore } from '../../stores/useSystemStore';
import { useConfigPersistence } from '../../hooks';
import { updateTiming, runAutoCheck } from '../../utils/updateService';
import type { AppConfig } from '../../types';
import {
  Settings, FileText, HardDrive, Monitor, Palette, Send, Code2, Wrench, Zap, X,
} from 'lucide-react';
import GeneralSettings from './pages/GeneralSettings';
import LogSettings from './pages/LogSettings';
import BackupSettings from './pages/BackupSettings';
import DisplaySettings from './pages/DisplaySettings';
import HighlightSettings from './pages/HighlightSettings';
import CommandSettings from './pages/CommandSettings';
import ProtocolSettings from './pages/ProtocolSettings';
import ToolSettings from './pages/ToolSettings';
import TriggerSettings from './pages/TriggerSettings';

interface NavItem {
  id: string;
  labelKey: string;
  icon: React.ReactNode;
}

const navItems: NavItem[] = [
  { id: 'general', labelKey: 'configModal.nav.general', icon: <Settings size={16} /> },
  { id: 'log', labelKey: 'configModal.nav.log', icon: <FileText size={16} /> },
  { id: 'backup', labelKey: 'configModal.nav.backup', icon: <HardDrive size={16} /> },
  { id: 'display', labelKey: 'configModal.nav.display', icon: <Monitor size={16} /> },
  { id: 'highlight', labelKey: 'configModal.nav.highlight', icon: <Palette size={16} /> },
  { id: 'commands', labelKey: 'configModal.nav.commands', icon: <Send size={16} /> },
  { id: 'protocol', labelKey: 'configModal.nav.protocol', icon: <Code2 size={16} /> },
  { id: 'tools', labelKey: 'configModal.nav.tools', icon: <Wrench size={16} /> },
  { id: 'triggers', labelKey: 'config.triggerSettings', icon: <Zap size={16} /> },
];

const ConfigModal: React.FC = () => {
  const { t } = useTranslation();
  const isConfigOpen = useSystemStore((s) => s.ui.isConfigOpen);
  const configActiveTab = useSystemStore((s) => s.ui.configActiveTab);
  const toggleConfigModal = useSystemStore((s) => s.toggleConfigModal);
  const setConfigActiveTab = useSystemStore((s) => s.setConfigActiveTab);
  const setConfig = useAppStore((s) => s.setConfig);
  const { saveConfig } = useConfigPersistence();
  // The pages edit `useAppStore.config` directly, so "the draft" is the store
  // itself. This ref only remembers the value at open time, to roll the session
  // back on cancel and to detect an update-channel change on save.
  const configSnapshotRef = useRef<AppConfig | null>(null);
  // Overlay click must only close on a click whose press *and* release were both
  // on the overlay: dragging a text selection that starts inside the dialog and
  // ends over the overlay synthesises a click there, which used to dismiss the
  // dialog mid-selection.
  const dialogRef = useRef<HTMLDivElement>(null);
  const mouseDownInsideDialogRef = useRef(false);

  useEffect(() => {
    if (isConfigOpen && !configSnapshotRef.current) {
      configSnapshotRef.current = { ...useAppStore.getState().config };
    }
    if (!isConfigOpen) {
      configSnapshotRef.current = null;
    }
  }, [isConfigOpen]);

  const handleCancel = () => {
    const snap = configSnapshotRef.current;
    if (snap) {
      setConfig(snap);
      configSnapshotRef.current = null;
    }
    toggleConfigModal(false);
  };

  const handleSave = async () => {
    // The entity arrays are owned by `useRuleStore` / the live store fields, so
    // `saveConfig` builds its own safe snapshot instead of trusting this draft
    // wholesale (`set_config` replaces config.json entirely).
    const current = useAppStore.getState().config;
    const snapshot = configSnapshotRef.current;
    const modeChanged = snapshot !== null && snapshot.updateCheckMode !== current.updateCheckMode;
    if (modeChanged) {
      // Update-channel bookkeeping belongs at the save boundary, not on the
      // radio's onChange: cancelling the dialog rolls the config back, so a
      // side effect fired at change time would leak. Clearing the snooze and the
      // last-check stamp (which is not per-channel) makes the new channel due
      // immediately.
      updateTiming.clearSnooze();
      updateTiming.clearLastCheck();
    }
    await saveConfig(current);
    configSnapshotRef.current = null;
    toggleConfigModal(false);
    // Re-check right away instead of waiting for the next startup; this runs in
    // the background and surfaces the update dialog if one is found.
    if (modeChanged && current.updateCheckMode !== 'none') {
      void runAutoCheck(current.updateCheckMode).then((update) => {
        if (update) {
          useSystemStore.getState().setUIState({ isUpdateOpen: true, updateCandidate: update });
        }
      });
    }
  };

  if (!isConfigOpen) return null;

  const renderContent = () => {
    switch (configActiveTab) {
      case 'general': return <GeneralSettings />;
      case 'log': return <LogSettings />;
      case 'backup': return <BackupSettings />;
      case 'display': return <DisplaySettings />;
      case 'highlight': return <HighlightSettings />;
      case 'commands': return <CommandSettings />;
      case 'protocol': return <ProtocolSettings />;
      case 'tools': return <ToolSettings />;
      case 'triggers': return <TriggerSettings />;
      default: return <GeneralSettings />;
    }
  };

  const activeNav = navItems.find(n => n.id === configActiveTab);

  return (
    <div
      className="modal-overlay animate-fade-in"
      onPointerDown={(e) => {
        mouseDownInsideDialogRef.current =
          dialogRef.current?.contains(e.target as Node) ?? false;
      }}
      onClick={() => {
        if (mouseDownInsideDialogRef.current) {
          mouseDownInsideDialogRef.current = false;
          return;
        }
        handleCancel();
      }}
    >
      <div className="modal-dialog animate-slide-up" ref={dialogRef} onClick={(e) => e.stopPropagation()}>
        <div className="modal-nav">
          <div className="modal-nav-header">
            <h2 className="modal-nav-title">{t('configModal.title')}</h2>
          </div>
          <div className="modal-nav-list">
            {navItems.map(item => (
              <div
                key={item.id}
                className={`modal-nav-item${configActiveTab === item.id ? ' active' : ''}`}
                onClick={() => setConfigActiveTab(item.id)}
              >
                <span className="modal-nav-icon">{item.icon}</span>
                {t(item.labelKey)}
              </div>
            ))}
          </div>
        </div>

        <div className="modal-content-area">
          <div className="modal-content-header">
            <span className="modal-content-title">
              {activeNav ? t(activeNav.labelKey) : ''}
            </span>
            <button className="btn btn-icon" onClick={handleCancel} title={t('configModal.close')}>
              <X size={16} />
            </button>
          </div>

          <div className="modal-content-body">
            {renderContent()}
          </div>

          <div className="modal-content-footer">
            <button className="btn" onClick={handleCancel}>{t('configModal.cancel')}</button>
            <button className="btn btn-primary" onClick={handleSave}>{t('configModal.save')}</button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ConfigModal;
