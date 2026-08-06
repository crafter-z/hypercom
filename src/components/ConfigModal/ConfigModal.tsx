import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../stores/useAppStore';
import { useRuleStore } from '../../stores/useRuleStore';
import { useConfigPersistence } from '../../hooks';
import { mergeLiveRuleEntities } from '../../utils/configMerge';
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
  const isConfigOpen = useAppStore((s) => s.ui.isConfigOpen);
  const configActiveTab = useAppStore((s) => s.ui.configActiveTab);
  const toggleConfigModal = useAppStore((s) => s.toggleConfigModal);
  const setConfigActiveTab = useAppStore((s) => s.setConfigActiveTab);
  const setConfig = useAppStore((s) => s.setConfig);
  const { saveConfig } = useConfigPersistence();
  const configSnapshotRef = useRef<AppConfig | null>(null);

  // Save snapshot when modal opens
  useEffect(() => {
    if (isConfigOpen && !configSnapshotRef.current) {
      configSnapshotRef.current = { ...useAppStore.getState().config };
    }
    if (!isConfigOpen) {
      configSnapshotRef.current = null;
    }
  }, [isConfigOpen]);

  const handleCancel = () => {
    if (configSnapshotRef.current) {
      setConfig(configSnapshotRef.current);
      configSnapshotRef.current = null;
    }
    toggleConfigModal(false);
  };

  const handleSave = async () => {
    // `useAppStore.config` 的实体数组是启动时的快照：规则页里的单条 ✓ 保存
    // 直接经 storageService 落盘 config.json，从不回写 store.config。这里若
    // 直接全量保存会用过期快照整体替换后端刚写入的实体（issue #5-2）——
    // 先合并 useRuleStore 的实时实体再保存。
    await saveConfig(mergeLiveRuleEntities(useAppStore.getState().config, useRuleStore.getState()));
    configSnapshotRef.current = null;
    toggleConfigModal(false);
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

  return (
    <div className="modal-overlay animate-fade-in" onClick={handleCancel}>
      <div className="modal-dialog animate-slide-up" onClick={(e) => e.stopPropagation()}>
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
              {navItems.find(n => n.id === configActiveTab)?.labelKey ? t(navItems.find(n => n.id === configActiveTab)!.labelKey) : ''}
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
