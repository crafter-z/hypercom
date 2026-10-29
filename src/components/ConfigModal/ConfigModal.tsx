import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../stores/useAppStore';
import { useSystemStore } from '../../stores/useSystemStore';
import { popoutEventService } from '../../services/tauri';
import { useConfigPersistence, isOrdinaryConfigDirty, discardOrdinaryConfigDraft } from '../../hooks/useConfigPersistence';
import { getCommittedUpdateMode, runAutoCheck } from '../../utils/updateService';
import { applyUiScale } from '../../utils/uiScale';
import { listDirtyEntityKinds } from '../../utils/entityEditor';
import { registerEditorParticipant, requestEditorLeave } from '../../utils/editorLeave';
import {
  Settings, FileText, HardDrive, Monitor, Palette, Send, Code2, Wrench, Zap, Plug, X,
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
import PluginSettings from './pages/PluginSettings';

import { usePluginViewOverlay } from '../shared/usePluginViewOverlay';
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
  { id: 'plugins', labelKey: 'configModal.nav.plugins', icon: <Plug size={16} /> },
];


const ConfigModal: React.FC = () => {
  const { t } = useTranslation();
  const isConfigOpen = useSystemStore((s) => s.ui.isConfigOpen);
  const configActiveTab = useSystemStore((s) => s.ui.configActiveTab);
  const overlayReady = usePluginViewOverlay(isConfigOpen);
  const toggleConfigModal = useSystemStore((s) => s.toggleConfigModal);
  const setConfigActiveTab = useSystemStore((s) => s.setConfigActiveTab);
  const { saveConfig } = useConfigPersistence();
  // Overlay click must only close on a click whose press *and* release were both
  // on the overlay: dragging a text selection that starts inside the dialog and
  // ends over the overlay synthesises a click there, which used to dismiss the
  // dialog mid-selection.
  const dialogRef = useRef<HTMLDivElement>(null);
  const mouseDownInsideDialogRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const sessionRef = useRef(0);
  const mountedRef = useRef(false);
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    mountedRef.current = true;
    const unsubscribe = useSystemStore.subscribe((state, previous) => {
      if (state.ui.isConfigOpen === previous.ui.isConfigOpen) return;
      sessionRef.current++;
    });
    return () => {
      mountedRef.current = false;
      sessionRef.current++;
      unsubscribe();
    };
  }, []);

  useEffect(() => registerEditorParticipant('config-ordinary', {
    isDirty: isOrdinaryConfigDirty,
    save: () => saveConfig(),
    discard: () => { discardOrdinaryConfigDraft(); },
    label: () => 'configModal.title',
  }), [saveConfig]);
  useEffect(() => {
    if (contentRef.current) contentRef.current.inert = saving;
  }, [saving, isConfigOpen, overlayReady]);

  const handleCancel = useCallback(() => {
    if (savingRef.current) return;
    void requestEditorLeave(['config-ordinary', 'entity-editor']).then(allowed => {
      if (!allowed || savingRef.current) return;
      toggleConfigModal(false);
    });
  }, [toggleConfigModal]);

  useEffect(() => {
    if (!isConfigOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || useSystemStore.getState().ui.isHotkeyHelpOpen) return;
      event.preventDefault();
      handleCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isConfigOpen, handleCancel]);

  const handleSave = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    const session = sessionRef.current;
    const current = useAppStore.getState().config;
    const modeChanged = getCommittedUpdateMode() !== current.updateCheckMode;
    try {
      if (!(await saveConfig())) return;
      if (!mountedRef.current || session !== sessionRef.current || !useSystemStore.getState().ui.isConfigOpen) return;
      if (isOrdinaryConfigDirty() || listDirtyEntityKinds().length > 0) return;
      const latest = useAppStore.getState().config;
      void applyUiScale(latest.uiScalePercent);
      void popoutEventService.emitUiScaleChanged(latest.uiScalePercent)
        .catch((error) => console.debug('[ConfigModal] Failed to broadcast UI scale:', error));

      toggleConfigModal(false);
      if (modeChanged && getCommittedUpdateMode() !== 'none') void runAutoCheck();
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  };

  if (!isConfigOpen || !overlayReady) return null;

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
      case 'plugins': return <PluginSettings />;
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
                onClick={() => { if (!savingRef.current) setConfigActiveTab(item.id); }}
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
            <button className="btn btn-icon" disabled={saving} onClick={handleCancel} title={t('configModal.close')}>
              <X size={16} />
            </button>
          </div>

          <div className="modal-content-body" ref={contentRef} aria-busy={saving}
            onClickCapture={(event) => { if (savingRef.current) { event.preventDefault(); event.stopPropagation(); } }}
            onChangeCapture={(event) => { if (savingRef.current) event.stopPropagation(); }}>
            {renderContent()}
          </div>

          <div className="modal-content-footer">
            <button className="btn" disabled={saving} onClick={handleCancel}>{t('configModal.cancel')}</button>
            <button className="btn btn-primary" disabled={saving} onClick={handleSave}>{t('configModal.save')}</button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ConfigModal;
