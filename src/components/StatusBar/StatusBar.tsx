import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import { useAppStore } from '../../stores/useAppStore';
import { Cpu, MemoryStick, ArrowUpCircle, ArrowDownCircle, PlugZap } from 'lucide-react';
import { useSystemStatus } from '../../hooks/useTauri';

const StatusBar: React.FC = () => {
  const systemStatus = useAppStore((s) => s.systemStatus);
  const trafficStats = useAppStore((s) => s.trafficStats);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const ports = useAppStore((s) => s.ports);
  const activeTraffic = activeTabId ? trafficStats[activeTabId] : null;
  const connectedCount = ports.filter(p => p.status === 'connected').length;
  const { t } = useTranslation();

  useSystemStatus(5000);

  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const formatBytes = (bytes: number): string => {
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KB`;
    return `${bytes} B`;
  };

  return (
    <div className="statusbar">
      <div className="statusbar-left">
        <span className="statusbar-item">
          <span className={systemStatus.status === 'high_load' ? 'statusbar-dot warning' : 'statusbar-dot'} />
          {systemStatus.status === 'high_load' ? t('statusBar.highLoad') : t('statusBar.normal')}
        </span>
        {connectedCount > 0 && (
          <span className="statusbar-item statusbar-connected">
            <PlugZap size={12} />
            {t('statusBar.connectedCount', { count: connectedCount })}
          </span>
        )}
        {activeTabId && (
          <span className="statusbar-item statusbar-value">{activeTabId}</span>
        )}
        <span className="statusbar-item">
          <MemoryStick size={12} />
          {systemStatus.memoryUsedMB}MB / {systemStatus.memoryLimitMb}MB ({systemStatus.memoryLimitMb ? ((systemStatus.memoryUsedMB / systemStatus.memoryLimitMb) * 100).toFixed(0) : '0'}%)
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
          <span className="statusbar-item">{t('statusBar.noPortSelected')}</span>
        )}
        <span className="statusbar-item">
          {now.toLocaleTimeString(i18n.language === 'en-US' ? 'en-US' : 'zh-CN')}
        </span>
      </div>
    </div>
  );
};

export default StatusBar;