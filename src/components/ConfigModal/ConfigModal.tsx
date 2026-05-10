import React from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { useConfigPersistence } from '../../hooks/useTauri';
import type { AppConfig } from '../../types';
import {
  Settings, FileText, HardDrive, Monitor, Palette, Send, X
} from 'lucide-react';

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
];

const GeneralSettings: React.FC = () => {
  const { config, setConfig } = useAppStore();

  return (
    <div className="config-page">
      <h3 className="config-page-title">通用设置</h3>

      <div className="config-row">
        <label>程序关闭行为:</label>
        <select
          className="select"
          value={config.closeBehavior}
          onChange={(e) => setConfig({ closeBehavior: e.target.value as AppConfig['closeBehavior'] })}
        >
          <option value="minimize">最小化到托盘</option>
          <option value="exit">直接退出</option>
        </select>
      </div>

      <div className="config-row">
        <label>内存占用上限 (MB):</label>
        <input
          className="input"
          type="number"
          value={config.memoryLimitMB}
          onChange={(e) => setConfig({ memoryLimitMB: Number(e.target.value) })}
          min={64}
          max={4096}
          step={64}
        />
      </div>

      <div className="config-row">
        <label>语言:</label>
        <select
          className="select"
          value={config.language}
          onChange={(e) => setConfig({ language: e.target.value as AppConfig['language'] })}
        >
          <option value="zh-CN">简体中文</option>
          <option value="en-US">English</option>
        </select>
      </div>

      <div className="config-row">
        <label>主题:</label>
        <select
          className="select"
          value={config.theme}
          onChange={(e) => setConfig({ theme: e.target.value as AppConfig['theme'] })}
        >
          <option value="light">亮色</option>
          <option value="dark">暗色</option>
          <option value="system">跟随系统</option>
        </select>
      </div>

      <div className="config-row">
        <label className="checkbox-wrapper">
          <input type="checkbox" checked={config.preventScreenOff} onChange={(e) => setConfig({ preventScreenOff: e.target.checked })} />
          防止系统息屏
        </label>
        <label className="checkbox-wrapper">
          <input type="checkbox" checked={config.preventSleep} onChange={(e) => setConfig({ preventSleep: e.target.checked })} />
          防止系统休眠
        </label>
      </div>

      <div className="divider-h" />
      <h4 className="config-section-title">字体设置</h4>

      <div className="config-row">
        <label>终端字体:</label>
        <input className="input" value={config.terminalFont} onChange={(e) => setConfig({ terminalFont: e.target.value })} />
        <input className="input" type="number" value={config.terminalFontSize} onChange={(e) => setConfig({ terminalFontSize: Number(e.target.value) })} style={{ width: 60 }} />
        <span>px</span>
      </div>

      <div className="config-row">
        <label>UI字体:</label>
        <input className="input" value={config.uiFont} onChange={(e) => setConfig({ uiFont: e.target.value })} />
        <input className="input" type="number" value={config.uiFontSize} onChange={(e) => setConfig({ uiFontSize: Number(e.target.value) })} style={{ width: 60 }} />
        <span>px</span>
      </div>

      <div className="config-row">
        <label>背景图片:</label>
        <input className="input" value={config.backgroundImage || ''} placeholder="选择图片路径..." readOnly />
        <button className="btn btn-sm">浏览...</button>
      </div>
    </div>
  );
};

const LogSettings: React.FC = () => {
  const { config, setConfig } = useAppStore();

  return (
    <div className="config-page">
      <h3 className="config-page-title">日志设置</h3>

      <label className="checkbox-wrapper">
        <input type="checkbox" checked={config.autoSaveLog} onChange={(e) => setConfig({ autoSaveLog: e.target.checked })} />
        自动保存日志
      </label>

      <div className="config-row">
        <label>日志存储目录:</label>
        <input className="input" value={config.logDirectory} placeholder="选择日志保存路径..." readOnly />
        <button className="btn btn-sm">浏览...</button>
      </div>

      <div className="config-row">
        <label>文件名格式:</label>
        <input className="input" value={config.logFilenameFormat} onChange={(e) => setConfig({ logFilenameFormat: e.target.value })} />
        <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>可用变量: [com], [datetime], [date], [time]</span>
      </div>

      <div className="config-row">
        <label>日志格式:</label>
        <select className="select" value={config.logFormat} onChange={(e) => setConfig({ logFormat: e.target.value as AppConfig['logFormat'] })}>
          <option value="string">字符串</option>
          <option value="hex">十六进制</option>
          <option value="binary">二进制</option>
        </select>
      </div>

      <div className="config-row">
        <label>日志编码:</label>
        <select className="select" value={config.logEncoding} onChange={(e) => setConfig({ logEncoding: e.target.value as AppConfig['logEncoding'] })}>
          <option value="ASCII">ASCII</option>
          <option value="UTF-8">UTF-8</option>
        </select>
      </div>

      <label className="checkbox-wrapper">
        <input type="checkbox" checked={config.logSplitEnabled} onChange={(e) => setConfig({ logSplitEnabled: e.target.checked })} />
        开启分片存储
      </label>

      {config.logSplitEnabled && (
        <div className="config-row">
          <label>分片大小 (MB):</label>
          <input className="input" type="number" value={config.logSplitSizeMB} onChange={(e) => setConfig({ logSplitSizeMB: Number(e.target.value) })} min={1} />
        </div>
      )}
    </div>
  );
};

const BackupSettings: React.FC = () => {
  const { config, setConfig } = useAppStore();

  return (
    <div className="config-page">
      <h3 className="config-page-title">备份管理</h3>

      <label className="checkbox-wrapper">
        <input type="checkbox" checked={config.backupEnabled} onChange={(e) => setConfig({ backupEnabled: e.target.checked })} />
        开启日志库备份
      </label>

      {config.backupEnabled && (
        <>
          <div className="config-row">
            <label>备份周期 (小时):</label>
            <input className="input" type="number" value={config.backupInterval} onChange={(e) => setConfig({ backupInterval: Number(e.target.value) })} min={1} />
          </div>
          <div className="config-row">
            <label>备份存储目录:</label>
            <input className="input" value={config.backupDirectory} placeholder="选择备份保存路径..." readOnly />
            <button className="btn btn-sm">浏览...</button>
          </div>
        </>
      )}
    </div>
  );
};

const DisplaySettings: React.FC = () => {
  const { config, setConfig } = useAppStore();

  return (
    <div className="config-page">
      <h3 className="config-page-title">显示与交互</h3>

      <div className="config-row">
        <label>预设波特率:</label>
        <input
          className="input"
          value={config.defaultBaudRates.join(', ')}
          onChange={(e) => setConfig({ defaultBaudRates: e.target.value.split(',').map(s => Number(s.trim())).filter(Boolean) })}
          style={{ flex: 1 }}
        />
      </div>

      <label className="checkbox-wrapper">
        <input type="checkbox" checked={config.showPortType} onChange={(e) => setConfig({ showPortType: e.target.checked })} />
        显示串口类型 (虚拟/真实)
      </label>

      <div className="config-row">
        <label>默认换行方式:</label>
        <select className="select" value={config.defaultLineEnding} onChange={(e) => setConfig({ defaultLineEnding: e.target.value as AppConfig['defaultLineEnding'] })}>
          <option value="\\r\\n">\r\n</option>
          <option value="\\r">\r</option>
          <option value="\\n">\n</option>
        </select>
      </div>

      <div className="config-row">
        <label>发送提示前缀:</label>
        <input className="input" value={config.sendPrefix} onChange={(e) => setConfig({ sendPrefix: e.target.value })} />
      </div>

      <div className="config-row">
        <label>时间戳显示方式:</label>
        <select className="select" value={config.timestampMode} onChange={(e) => setConfig({ timestampMode: e.target.value as AppConfig['timestampMode'] })}>
          <option value="perLine">每行显示一个时间戳</option>
          <option value="perRound">每轮输出显示一个时间戳</option>
        </select>
      </div>
    </div>
  );
};

const HighlightSettings: React.FC = () => {
  return (
    <div className="config-page">
      <h3 className="config-page-title">语法高亮规则集</h3>
      <p className="config-page-desc">
        管理语法高亮规则集。每个规则集包含多条规则，支持正则表达式或关键词匹配，可设置颜色、加粗、斜体。
      </p>
      <div className="config-placeholder">规则集编辑器（待实现）</div>
    </div>
  );
};

const CommandSettings: React.FC = () => {
  return (
    <div className="config-page">
      <h3 className="config-page-title">发送命令规则集</h3>
      <p className="config-page-desc">
        管理自动发送命令规则集。每个规则集包含多条命令，可设置顺序、名称、延时、发送类型、命令内容。
      </p>
      <div className="config-placeholder">命令规则集编辑器（待实现）</div>
    </div>
  );
};

const ConfigModal: React.FC = () => {
  const { ui, toggleConfigModal, setConfigActiveTab } = useAppStore();
  const { saveConfig } = useConfigPersistence();
  const { isConfigOpen, configActiveTab } = ui;

  if (!isConfigOpen) return null;

  const renderContent = () => {
    switch (configActiveTab) {
      case 'general': return <GeneralSettings />;
      case 'log': return <LogSettings />;
      case 'backup': return <BackupSettings />;
      case 'display': return <DisplaySettings />;
      case 'highlight': return <HighlightSettings />;
      case 'commands': return <CommandSettings />;
      default: return <GeneralSettings />;
    }
  };

  return (
    <div className="modal-overlay animate-fade-in" onClick={() => toggleConfigModal(false)}>
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
            <button className="btn" onClick={() => toggleConfigModal(false)}>取消</button>
            <button className="btn btn-primary" onClick={async () => { await saveConfig(useAppStore.getState().config); toggleConfigModal(false); }}>保存</button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ConfigModal;