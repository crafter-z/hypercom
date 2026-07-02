import React, { useEffect, useRef } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { useConfigPersistence } from '../../hooks/useTauri';
import type { AppConfig } from '../../types';
import {
  Settings, FileText, HardDrive, Monitor, Palette, Send, Code2, X,
} from 'lucide-react';
import GeneralSettings from './pages/GeneralSettings';
import LogSettings from './pages/LogSettings';
import BackupSettings from './pages/BackupSettings';
import DisplaySettings from './pages/DisplaySettings';
import HighlightSettings from './pages/HighlightSettings';
import CommandSettings from './pages/CommandSettings';
import ProtocolSettings from './pages/ProtocolSettings';

interface NavItem {
  id: string;
  label: string;
  icon: React.ReactNode;
}

const navItems: NavItem[] = [
  { id: 'general', label: '通用设置', icon: <Settings size={16} /> },
  { id: 'log', label: '日志设置', icon: <FileText size={16} /> },
  { id: 'backup', label: '备份管理', icon: <HardDrive size={16} /> },
  { id: 'display', label: '显示与交互', icon: <Monitor size={16} /> },
  { id: 'highlight', label: '语法高亮规则', icon: <Palette size={16} /> },
  { id: 'commands', label: '发送命令规则', icon: <Send size={16} /> },
  { id: 'protocol', label: '协议解析', icon: <Code2 size={16} /> },
];

const ConfigModal: React.FC = () => {
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
    await saveConfig(useAppStore.getState().config);
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
      default: return <GeneralSettings />;
    }
  };

  return (
    <div className="modal-overlay animate-fade-in" onClick={handleCancel}>
      <div className="modal-dialog animate-slide-up" onClick={(e) => e.stopPropagation()}>
        <div className="modal-nav">
          <div className="modal-nav-header">
            <h2 className="modal-nav-title">设置</h2>
          </div>
          <div className="modal-nav-list">
            {navItems.map(item => (
              <div
                key={item.id}
                className={`modal-nav-item${configActiveTab === item.id ? ' active' : ''}`}
                onClick={() => setConfigActiveTab(item.id)}
              >
                <span className="modal-nav-icon">{item.icon}</span>
                {item.label}
              </div>
            ))}
          </div>
        </div>

        <div className="modal-content-area">
          <div className="modal-content-header">
            <span className="modal-content-title">
              {navItems.find(n => n.id === configActiveTab)?.label}
            </span>
            <button className="btn btn-icon" onClick={() => toggleConfigModal(false)} title="关闭">
              <X size={16} />
            </button>
          </div>

          <div className="modal-content-body">
            {renderContent()}
          </div>

          <div className="modal-content-footer">
            <button className="btn" onClick={handleCancel}>取消</button>
            <button className="btn btn-primary" onClick={handleSave}>保存</button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ConfigModal;
