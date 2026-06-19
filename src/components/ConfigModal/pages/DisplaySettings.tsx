import React from 'react';
import { useAppStore } from '../../../stores/useAppStore';
import type { AppConfig } from '../../../types';

const DisplaySettings: React.FC = () => {
  const config = useAppStore((s) => s.config);
  const setConfig = useAppStore((s) => s.setConfig);

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

export default DisplaySettings;
