import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../stores/useAppStore';
import { useSystemStore } from '../../stores/useSystemStore';
import { popoutEventService } from '../../services/tauri';
import { useConfigPersistence } from '../../hooks';
import { getCommittedUpdateMode, runAutoCheck } from '../../utils/updateService';
import { applyUiScale } from '../../utils/uiScale';
import type { AppConfig } from '../../types';
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

const independentlyPersisted: Partial<Record<keyof AppConfig, true>> = {
  revision: true, portGroups: true, portMeta: true, pluginConfigs: true, portPresets: true,
  sendCommandSets: true, highlightRuleSets: true, protocolTemplates: true, triggerRules: true, portToolConfigs: true,
};

const ConfigModal: React.FC = () => {
  const { t } = useTranslation();
  const isConfigOpen = useSystemStore((s) => s.ui.isConfigOpen);
  const configActiveTab = useSystemStore((s) => s.ui.configActiveTab);
  const overlayReady = usePluginViewOverlay(isConfigOpen);
  const toggleConfigModal = useSystemStore((s) => s.toggleConfigModal);
  const setConfigActiveTab = useSystemStore((s) => s.setConfigActiveTab);
  const setConfig = useAppStore((s) => s.setConfig);
  const { saveConfig } = useConfigPersistence();
  // The pages edit `useAppStore.config` directly, so "the draft" is the store
  // itself. This ref remembers the value at open time for cancel rollback.
  const configSnapshotRef = useRef<AppConfig | null>(null);
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
      configSnapshotRef.current = state.ui.isConfigOpen ? { ...useAppStore.getState().config } : null;
    });
    return () => {
      mountedRef.current = false;
      sessionRef.current++;
      unsubscribe();
    };
  }, []);
  useEffect(() => {
    if (contentRef.current) contentRef.current.inert = saving;
  }, [saving, isConfigOpen, overlayReady]);

  useEffect(() => {
    if (isConfigOpen && !configSnapshotRef.current) {
      configSnapshotRef.current = { ...useAppStore.getState().config };
    }
    if (!isConfigOpen) {
      configSnapshotRef.current = null;
    }
  }, [isConfigOpen]);

  const handleCancel = useCallback(() => {
    if (savingRef.current) return;
    // issue #6-8：弹窗打开后 useAppInit 的分组/元数据 500ms 防抖可能已把新
    // 分组/元数据回写 store.config 并落盘；整体回滚会把这两项也回滚为旧值，
    // 后续全量保存再把旧值写回磁盘 → 丢失。取消时保留当前 store.config 中的
    // portGroups/portMeta，只回滚其余字段。
    // 插件授权已由后端命令单独落盘；取消仅回滚普通设置，保留
    // `utils/pluginConfigSnapshot.ts` 同步的当前 pluginConfigs 镜像。
    const snap = configSnapshotRef.current;
    if (snap) {
      const cur = useAppStore.getState().config;
      setConfig({
        ...snap, revision: cur.revision, portGroups: cur.portGroups, portMeta: cur.portMeta, pluginConfigs: cur.pluginConfigs,
        sendCommandSets: cur.sendCommandSets, highlightRuleSets: cur.highlightRuleSets,
        protocolTemplates: cur.protocolTemplates, triggerRules: cur.triggerRules, portToolConfigs: cur.portToolConfigs,
      });
      configSnapshotRef.current = null;
    }
    toggleConfigModal(false);
  }, [setConfig, toggleConfigModal]);

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
      // Compose from live stores at dispatch; never patch with an old full draft.
      if (!(await saveConfig())) return;
      if (!mountedRef.current || session !== sessionRef.current || !useSystemStore.getState().ui.isConfigOpen) return;
      const latest = useAppStore.getState().config;
      // External updates can still arrive while controls are frozen. Keep the
      // newer draft open rather than representing an older snapshot as saved.
      if ((Object.keys(current) as Array<keyof AppConfig>).some(key => !independentlyPersisted[key] && current[key] !== latest[key])) return;
      void applyUiScale(current.uiScalePercent);
      void popoutEventService.emitUiScaleChanged(current.uiScalePercent)
        .catch((error) => console.debug('[ConfigModal] Failed to broadcast UI scale:', error));
      configSnapshotRef.current = null;
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
