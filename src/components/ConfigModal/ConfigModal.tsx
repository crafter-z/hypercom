/**
 * 配置管理弹窗
 * 左侧树状导航，右侧详细设置
 * 包含通用、日志、备份、显示、规则引擎等设置页
 */

import React from 'react';
import { useAppStore } from '../../stores/useAppStore';
import type { AppConfig } from '../../types';

// ==================== 配置页面导航项 ====================
interface NavItem {
  id: string;
  label: string;
  icon?: string;
}

const navItems: NavItem[] = [
  { id: 'general', label: '通用设置', icon: '⚙' },
  { id: 'log', label: '日志设置', icon: '📄' },
  { id: 'backup', label: '备份管理', icon: '💾' },
  { id: 'display', label: '显示与交互', icon: '🖥' },
  { id: 'highlight', label: '语法高亮规则', icon: '🎨' },
  { id: 'commands', label: '发送命令规则', icon: '📡' },
];

// ==================== 通用设置页 ====================

const GeneralSettings: React.FC = () => {
  const { config, setConfig } = useAppStore();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>通用设置</h3>

      {/* 关闭行为 */}
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

      {/* 内存限制 */}
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

      {/* 语言 */}
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

      {/* 主题 */}
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

      {/* 防息屏/防休眠 */}
      <div className="config-row">
        <label className="checkbox-wrapper">
          <input
            type="checkbox"
            checked={config.preventScreenOff}
            onChange={(e) => setConfig({ preventScreenOff: e.target.checked })}
          />
          防止系统息屏
        </label>
        <label className="checkbox-wrapper">
          <input
            type="checkbox"
            checked={config.preventSleep}
            onChange={(e) => setConfig({ preventSleep: e.target.checked })}
          />
          防止系统休眠
        </label>
      </div>

      {/* 字体设置 */}
      <div className="divider-h" />
      <h4 style={{ fontSize: 14, fontWeight: 600 }}>字体设置</h4>

      <div className="config-row">
        <label>终端字体:</label>
        <input
          className="input"
          value={config.terminalFont}
          onChange={(e) => setConfig({ terminalFont: e.target.value })}
        />
        <input
          className="input"
          type="number"
          value={config.terminalFontSize}
          onChange={(e) => setConfig({ terminalFontSize: Number(e.target.value) })}
          style={{ width: 60 }}
        />
        <span>px</span>
      </div>

      <div className="config-row">
        <label>UI字体:</label>
        <input
          className="input"
          value={config.uiFont}
          onChange={(e) => setConfig({ uiFont: e.target.value })}
        />
        <input
          className="input"
          type="number"
          value={config.uiFontSize}
          onChange={(e) => setConfig({ uiFontSize: Number(e.target.value) })}
          style={{ width: 60 }}
        />
        <span>px</span>
      </div>

      {/* 背景图片 */}
      <div className="config-row">
        <label>背景图片:</label>
        <input
          className="input"
          value={config.backgroundImage || ''}
          placeholder="选择图片路径..."
          readOnly
        />
        <button className="btn btn-sm">浏览...</button>
      </div>
    </div>
  );
};

// ==================== 日志设置页 ====================

const LogSettings: React.FC = () => {
  const { config, setConfig } = useAppStore();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>日志设置</h3>

      <label className="checkbox-wrapper">
        <input
          type="checkbox"
          checked={config.autoSaveLog}
          onChange={(e) => setConfig({ autoSaveLog: e.target.checked })}
        />
        自动保存日志
      </label>

      <div className="config-row">
        <label>日志存储目录:</label>
        <input
          className="input"
          value={config.logDirectory}
          placeholder="选择日志保存路径..."
          readOnly
        />
        <button className="btn btn-sm">浏览...</button>
      </div>

      <div className="config-row">
        <label>文件名格式:</label>
        <input
          className="input"
          value={config.logFilenameFormat}
          onChange={(e) => setConfig({ logFilenameFormat: e.target.value })}
        />
        <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
          可用变量: [com], [datetime], [date], [time]
        </span>
      </div>

      <div className="config-row">
        <label>日志格式:</label>
        <select
          className="select"
          value={config.logFormat}
          onChange={(e) => setConfig({ logFormat: e.target.value as AppConfig['logFormat'] })}
        >
          <option value="string">字符串</option>
          <option value="hex">十六进制</option>
          <option value="binary">二进制</option>
        </select>
      </div>

      <div className="config-row">
        <label>日志编码:</label>
        <select
          className="select"
          value={config.logEncoding}
          onChange={(e) => setConfig({ logEncoding: e.target.value as AppConfig['logEncoding'] })}
        >
          <option value="ASCII">ASCII</option>
          <option value="UTF-8">UTF-8</option>
        </select>
      </div>

      <label className="checkbox-wrapper">
        <input
          type="checkbox"
          checked={config.logSplitEnabled}
          onChange={(e) => setConfig({ logSplitEnabled: e.target.checked })}
        />
        开启分片存储
      </label>

      {config.logSplitEnabled && (
        <div className="config-row">
          <label>分片大小 (MB):</label>
          <input
            className="input"
            type="number"
            value={config.logSplitSizeMB}
            onChange={(e) => setConfig({ logSplitSizeMB: Number(e.target.value) })}
            min={1}
          />
        </div>
      )}
    </div>
  );
};

// ==================== 备份管理页 ====================

const BackupSettings: React.FC = () => {
  const { config, setConfig } = useAppStore();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>备份管理</h3>

      <label className="checkbox-wrapper">
        <input
          type="checkbox"
          checked={config.backupEnabled}
          onChange={(e) => setConfig({ backupEnabled: e.target.checked })}
        />
        开启日志库备份
      </label>

      {config.backupEnabled && (
        <>
          <div className="config-row">
            <label>备份周期 (小时):</label>
            <input
              className="input"
              type="number"
              value={config.backupInterval}
              onChange={(e) => setConfig({ backupInterval: Number(e.target.value) })}
              min={1}
            />
          </div>

          <div className="config-row">
            <label>备份存储目录:</label>
            <input
              className="input"
              value={config.backupDirectory}
              placeholder="选择备份保存路径..."
              readOnly
            />
            <button className="btn btn-sm">浏览...</button>
          </div>
        </>
      )}
    </div>
  );
};

// ==================== 显示与交互页 ====================

const DisplaySettings: React.FC = () => {
  const { config, setConfig } = useAppStore();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>显示与交互</h3>

      {/* 预设波特率 */}
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
        <input
          type="checkbox"
          checked={config.showPortType}
          onChange={(e) => setConfig({ showPortType: e.target.checked })}
        />
        显示串口类型 (虚拟/真实)
      </label>

      <div className="config-row">
        <label>默认换行方式:</label>
        <select
          className="select"
          value={config.defaultLineEnding}
          onChange={(e) => setConfig({ defaultLineEnding: e.target.value as AppConfig['defaultLineEnding'] })}
        >
          <option value="\\r\\n">\r\n</option>
          <option value="\\r">\r</option>
          <option value="\\n">\n</option>
        </select>
      </div>

      <div className="config-row">
        <label>发送提示前缀:</label>
        <input
          className="input"
          value={config.sendPrefix}
          onChange={(e) => setConfig({ sendPrefix: e.target.value })}
        />
      </div>

      <div className="config-row">
        <label>时间戳显示方式:</label>
        <select
          className="select"
          value={config.timestampMode}
          onChange={(e) => setConfig({ timestampMode: e.target.value as AppConfig['timestampMode'] })}
        >
          <option value="perLine">每行显示一个时间戳</option>
          <option value="perRound">每轮输出显示一个时间戳</option>
        </select>
      </div>
    </div>
  );
};

// ==================== 语法高亮规则页 ====================

const HighlightSettings: React.FC = () => {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>语法高亮规则集</h3>
      <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
        管理语法高亮规则集。每个规则集包含多条规则，支持正则表达式或关键词匹配，可设置颜色、加粗、斜体。
      </p>
      {/* TODO: 实现规则集列表编辑UI */}
      <div className="panel-card" style={{ padding: 24, textAlign: 'center', color: 'var(--text-secondary)' }}>
        规则集编辑器（待实现）
      </div>
    </div>
  );
};

// ==================== 发送命令规则页 ====================

const CommandSettings: React.FC = () => {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>发送命令规则集</h3>
      <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
        管理自动发送命令规则集。每个规则集包含多条命令，可设置顺序、名称、延时、发送类型、命令内容。
      </p>
      {/* TODO: 实现命令规则集列表编辑UI */}
      <div className="panel-card" style={{ padding: 24, textAlign: 'center', color: 'var(--text-secondary)' }}>
        命令规则集编辑器（待实现）
      </div>
    </div>
  );
};

// ==================== 主弹窗组件 ====================

const ConfigModal: React.FC = () => {
  const { ui, toggleConfigModal, setConfigActiveTab } = useAppStore();
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
    <div
      className="animate-fade-in"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2000,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={() => toggleConfigModal(false)}
    >
      <div
        style={{
          width: 800,
          height: 600,
          maxWidth: '90vw',
          maxHeight: '90vh',
          background: 'var(--bg-primary)',
          border: '1px solid var(--border-color)',
          borderRadius: 8,
          display: 'flex',
          overflow: 'hidden',
          boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 左侧导航 */}
        <div style={{
          width: 180,
          background: 'var(--bg-secondary)',
          borderRight: '1px solid var(--border-color)',
          display: 'flex',
          flexDirection: 'column',
        }}>
          <div style={{ padding: '16px 12px', borderBottom: '1px solid var(--border-color)' }}>
            <h2 style={{ fontSize: 16, fontWeight: 600 }}>设置</h2>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
            {navItems.map(item => (
              <div
                key={item.id}
                style={{
                  padding: '8px 16px',
                  cursor: 'pointer',
                  fontSize: 13,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  background: configActiveTab === item.id ? 'var(--bg-active)' : 'transparent',
                  color: configActiveTab === item.id ? 'var(--text-active)' : 'var(--text-primary)',
                  borderLeft: configActiveTab === item.id ? '3px solid var(--text-link)' : '3px solid transparent',
                  transition: 'all var(--transition-fast)',
                }}
                onClick={() => setConfigActiveTab(item.id)}
                onMouseEnter={(e) => {
                  if (configActiveTab !== item.id) {
                    (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)';
                  }
                }}
                onMouseLeave={(e) => {
                  if (configActiveTab !== item.id) {
                    (e.currentTarget as HTMLElement).style.background = 'transparent';
                  }
                }}
              >
                <span>{item.icon}</span>
                {item.label}
              </div>
            ))}
          </div>
        </div>

        {/* 右侧内容 */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* 头部 */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 16px',
            borderBottom: '1px solid var(--border-color)',
          }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>
              {navItems.find(n => n.id === configActiveTab)?.label}
            </span>
            <button
              className="btn btn-icon"
              onClick={() => toggleConfigModal(false)}
              title="关闭"
            >
              ✕
            </button>
          </div>

          {/* 设置内容 */}
          <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
            {renderContent()}
          </div>

          {/* 底部按钮 */}
          <div style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            padding: '12px 16px',
            borderTop: '1px solid var(--border-color)',
          }}>
            <button className="btn" onClick={() => toggleConfigModal(false)}>取消</button>
            <button className="btn btn-primary" onClick={() => toggleConfigModal(false)}>保存</button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ConfigModal;
