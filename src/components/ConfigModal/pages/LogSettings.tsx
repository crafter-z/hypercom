import React from 'react';
import { useAppStore } from '../../../stores/useAppStore';
import { open } from '@tauri-apps/plugin-dialog';
import type { AppConfig } from '../../../types';

const LogSettings: React.FC = () => {
  const config = useAppStore((s) => s.config);
  const setConfig = useAppStore((s) => s.setConfig);

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
        <button className="btn btn-sm" onClick={async () => {
          const result = await open({ directory: true });
          if (result) setConfig({ logDirectory: result });
        }}>浏览...</button>
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
          <input className="input" type="number" value={config.logSplitSizeMb} onChange={(e) => setConfig({ logSplitSizeMb: Number(e.target.value) })} min={1} />
        </div>
      )}
    </div>
  );
};

export default LogSettings;
