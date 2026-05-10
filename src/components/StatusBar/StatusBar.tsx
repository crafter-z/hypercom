import React from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { Cpu, MemoryStick, ArrowUpCircle, ArrowDownCircle } from 'lucide-react';

const StatusBar: React.FC = () => {
  const { systemStatus, trafficStats, activeTabId } = useAppStore();
  const activeTraffic = activeTabId ? trafficStats[activeTabId] : null;

  const formatBytes = (bytes: number): string => {
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KB`;
    return `${bytes} B`;
  };

  return (
    <div className="statusbar">
      <div className="statusbar-left">
        <span className="statusbar-item">
          <span className="statusbar-dot" />
          {systemStatus.status}
        </span>
        <span className="statusbar-item">
          <MemoryStick size={12} />
          {systemStatus.memoryUsedMB}MB / {systemStatus.memoryLimitMB}MB ({((systemStatus.memoryUsedMB / systemStatus.memoryLimitMB) * 100).toFixed(0)}%)
        </span>
        <span className="statusbar-item">
          <Cpu size={12} />
          {systemStatus.cpuUsage.toFixed(1)}%
        </span>
      </div>

      <div className="statusbar-right">
        {activeTraffic ? (
          <>
            <span className="statusbar-item statusbar-tx">
              <ArrowUpCircle size={12} />
              TX: {formatBytes(activeTraffic.txTotal)}
            </span>
            <span className="statusbar-item statusbar-rx">
              <ArrowDownCircle size={12} />
              RX: {formatBytes(activeTraffic.rxTotal)}
            </span>
          </>
        ) : (
          <span className="statusbar-item" style={{ opacity: 0.7 }}>未选择串口</span>
        )}
        <span className="statusbar-item" style={{ opacity: 0.8 }}>
          {new Date().toLocaleTimeString('zh-CN')}
        </span>
      </div>
    </div>
  );
};

export default StatusBar;