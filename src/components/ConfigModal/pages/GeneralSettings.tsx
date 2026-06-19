import React from 'react';
import { useAppStore } from '../../../stores/useAppStore';
import { open } from '@tauri-apps/plugin-dialog';
import type { AppConfig } from '../../../types';

const GeneralSettings: React.FC = () => {
  const config = useAppStore((s) => s.config);
  const setConfig = useAppStore((s) => s.setConfig);

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
          value={config.memoryLimitMb}
          onChange={(e) => setConfig({ memoryLimitMb: Number(e.target.value) })}
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
        <button className="btn btn-sm" onClick={async () => {
          const result = await open({ directory: false, multiple: false, filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'webp'] }] });
          if (result) setConfig({ backgroundImage: result });
        }}>浏览...</button>
      </div>
    </div>
  );
};

export default GeneralSettings;
