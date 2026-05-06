/**
 * 底部状态栏
 * 左侧显示系统状态、内存、CPU
 * 右侧显示当前串口流量统计 (TX/RX)
 */

import React from 'react';
import { useAppStore } from '../../stores/useAppStore';

const StatusBar: React.FC = () => {
  const { systemStatus, trafficStats, activeTabId } = useAppStore();
  const activeTraffic = activeTabId ? trafficStats[activeTabId] : null;

  const formatBytes = (bytes: number): string => {
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KB`;
    return `${bytes} B`;
  };

  return (
    <div
      style={{
        height: 'var(--statusbar-height)',
        background: 'var(--bg-statusbar)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 12px',
        fontSize: 12,
        color: '#ffffff',
        flexShrink: 0,
      }}
    >
      {/* 左侧：系统状态 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#4ec9b0' }} />
          {systemStatus.status}
        </span>

        <span>
          内存: {systemStatus.memoryUsedMB}MB / {systemStatus.memoryLimitMB}MB
          {' '}
          ({((systemStatus.memoryUsedMB / systemStatus.memoryLimitMB) * 100).toFixed(0)}%)
        </span>

        <span>CPU: {systemStatus.cpuUsage.toFixed(1)}%</span>
      </div>

      {/* 右侧：流量统计 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        {activeTraffic ? (
          <>
            <span style={{ color: '#4ec9b0' }}>
              ↑ TX: {formatBytes(activeTraffic.txTotal)}
            </span>
            <span style={{ color: '#4fc1ff' }}>
              ↓ RX: {formatBytes(activeTraffic.rxTotal)}
            </span>
          </>
        ) : (
          <span style={{ opacity: 0.7 }}>未选择串口</span>
        )}

        <span style={{ opacity: 0.8 }}>
          {new Date().toLocaleTimeString('zh-CN')}
        </span>
      </div>
    </div>
  );
};

export default StatusBar;
