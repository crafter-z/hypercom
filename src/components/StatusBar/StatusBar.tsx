import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import { useAppStore } from '../../stores/useAppStore';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { Cpu, MemoryStick, ArrowUpCircle, ArrowDownCircle, PlugZap, Timer } from 'lucide-react';
import { useSystemStatus } from '../../hooks';
import { readJsHeapMb } from '../../utils/jsHeap';
import DisconnectBanner from './DisconnectBanner';
import NotificationCenter from './NotificationCenter';

/** Format bytes/sec with auto-scaling */
function formatRate(bytesPerSec: number): string {
  if (bytesPerSec >= 1024 * 1024) return `${(bytesPerSec / 1024 / 1024).toFixed(2)} MB/s`;
  if (bytesPerSec >= 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${Math.round(bytesPerSec)} B/s`;
}

/** Format milliseconds as HH:MM:SS */
function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

interface RateSnapshot {
  ts: number;
  rx: number;
  tx: number;
}

interface RateDisplay {
  duration: string;
  rxRate: number;
  txRate: number;
  peakRx: number;
  peakTx: number;
}

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

  // F.4: rate + duration state (updated once per second, NOT on every serial event)
  const [rateDisplay, setRateDisplay] = useState<RateDisplay | null>(null);
  const rateWindowRef = useRef<RateSnapshot[]>([]);
  const peakRef = useRef<{ rx: number; tx: number }>({ rx: 0, tx: 0 });
  const prevConnectedAtRef = useRef<number | null>(null);

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(new Date());

      const portId = useAppStore.getState().activeTabId;
      if (!portId) {
        setRateDisplay(null);
        return;
      }

      const term = useTerminalStore.getState().terminals[portId];
      const connectedAt = term?.connectedAt ?? null;

      // Reset window + peak on reconnect or port change
      if (connectedAt !== prevConnectedAtRef.current) {
        prevConnectedAtRef.current = connectedAt;
        rateWindowRef.current = [];
        peakRef.current = { rx: 0, tx: 0 };
      }

      if (connectedAt == null) {
        setRateDisplay(null);
        return;
      }

      const stats = useAppStore.getState().trafficStats[portId];
      const rx = stats?.rxTotal ?? 0;
      const tx = stats?.txTotal ?? 0;
      const ts = Date.now();

      // Push snapshot, keep last 6 (for 5-second window)
      const window = rateWindowRef.current;
      window.push({ ts, rx, tx });
      if (window.length > 6) window.shift();

      // Compute rate over the window
      let rxRate = 0;
      let txRate = 0;
      if (window.length >= 2) {
        const oldest = window[0];
        const newest = window[window.length - 1];
        const dtSec = (newest.ts - oldest.ts) / 1000;
        if (dtSec > 0) {
          rxRate = Math.max(0, (newest.rx - oldest.rx) / dtSec);
          txRate = Math.max(0, (newest.tx - oldest.tx) / dtSec);
        }
      }

      // Track peak
      if (rxRate > peakRef.current.rx) peakRef.current.rx = rxRate;
      if (txRate > peakRef.current.tx) peakRef.current.tx = txRate;

      setRateDisplay({
        duration: formatDuration(ts - connectedAt),
        rxRate,
        txRate,
        peakRx: peakRef.current.rx,
        peakTx: peakRef.current.tx,
      });
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const formatBytes = (bytes: number): string => {
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KB`;
    return `${bytes} B`;
  };

  return (
    <>
    <DisconnectBanner />
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
        <span className="statusbar-item" title={t('statusBar.processMem')}>
          <MemoryStick size={12} />
          {(() => { const jsHeap = readJsHeapMb(); return jsHeap > 0 ? `${t('statusBar.jsHeap')} ${jsHeap}MB · ` : ''; })()}
          {t('statusBar.processMem')} {systemStatus.memoryUsedMb}MB / {systemStatus.memoryLimitMb}MB
        </span>
        <span className="statusbar-item">
          <Cpu size={12} />
          {systemStatus.cpuUsage.toFixed(1)}%
        </span>
      </div>

      <div className="statusbar-right">
        {rateDisplay && (
          <span className="statusbar-item statusbar-rate-group">
            <Timer size={12} />
            <span className="statusbar-duration">{rateDisplay.duration}</span>
            <span className="statusbar-rate-sep">|</span>
            <span className="statusbar-rx">
              {t('statusBar.rate.rx')} {formatRate(rateDisplay.rxRate)}
              <span className="statusbar-peak"> ({t('statusBar.rate.peak')} {formatRate(rateDisplay.peakRx)})</span>
            </span>
            <span className="statusbar-rate-sep">|</span>
            <span className="statusbar-tx">
              {t('statusBar.rate.tx')} {formatRate(rateDisplay.txRate)}
            </span>
          </span>
        )}
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
        <NotificationCenter />
        <span className="statusbar-item">
          {now.toLocaleTimeString(i18n.language === 'en-US' ? 'en-US' : 'zh-CN')}
        </span>
      </div>
    </div>
    </>
  );
};

export default StatusBar;
