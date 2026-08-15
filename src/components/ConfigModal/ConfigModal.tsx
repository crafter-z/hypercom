import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../stores/useAppStore';
import { useRuleStore } from '../../stores/useRuleStore';
import { useConfigPersistence } from '../../hooks';
import { mergeLiveRuleEntities } from '../../utils/configMerge';
import { updateTiming } from '../../utils/updateService';
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
  // issue #6-8：overlay 点击关闭只应响应「按下和松开都在遮罩上」的点击。
  // 框选文字时按下在弹窗内、松开在弹窗外——mouseup 落在遮罩上会合成一次
  // overlay click 导致设置界面误关闭。用 pointerdown 记录起点是否在弹窗内。
  const dialogRef = useRef<HTMLDivElement>(null);
  const mouseDownInsideDialogRef = useRef(false);

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
    // issue #12 复审：更新模式变更的副作用挪到**保存边界**（旧实现放 radio
    // onChange——用户点「取消」时配置回滚、snooze 却已清，副作用泄漏）。
    // 清 snooze + lastCheckAt 使新通道立即生效：lastCheckAt 不分通道，
    // 旧通道的 7 天周期会推迟新通道首检。
    const snapshot = configSnapshotRef.current;
    const current = useAppStore.getState().config;
    if (snapshot && snapshot.updateCheckMode !== current.updateCheckMode) {
      updateTiming.clearSnooze();
      updateTiming.clearLastCheck();
    }
    await saveConfig(mergeLiveRuleEntities(current, useRuleStore.getState()));
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
    <div
      className="modal-overlay animate-fade-in"
      onPointerDown={(e) => {
        // 记录按下起点是否在弹窗内部：仅当起点在遮罩上才允许点击关闭
        mouseDownInsideDialogRef.current =
          dialogRef.current?.contains(e.target as Node) ?? false;
      }}
      onClick={() => {
        // issue #6-8：框选文字（按下在弹窗内、松开在遮罩上）不触发关闭
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
