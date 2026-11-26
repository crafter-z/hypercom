import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, RotateCw, X } from 'lucide-react';
import { getTabPortId, useAppStore } from '../../stores/useAppStore';
import { isPortLost, useSerialConnection } from '../../hooks';
import { lostPortIds } from '../../hooks/disconnectTracking';
import { runSequential } from '../../utils/sequential';
import type { SerialPort, TabItem } from '../../types';

/**
 * Pure helper: returns the IDs of open tabs whose ports are "lost".
 *
 * A port is lost only after a real connected → disconnected transition THIS
 * session (tracked by `lostPortIds` in disconnectTracking.ts). Session-restored
 * tabs were never connected this session, so they never light up the banner —
 * that is what fixes the startup false-alarm.
 *
 * Exported for unit testing (see `DisconnectBanner.test.ts`).
 */
export function filterLostTabIds(
  tabs: TabItem[],
  isLost: (id: string) => boolean,
): string[] {
  const seen = new Set<string>();
  return tabs.filter((tab) => {
    const portId = getTabPortId(tab);
    if (!portId || seen.has(portId) || !isLost(portId)) return false;
    seen.add(portId);
    return true;
  }).map((tab) => tab.id);
}

/**
 * Pure helper: formats a concise human-readable summary of lost ports
 * (e.g., `COM3 (MCU)` or `COM3, COM5 (+1)`).
 */
export function formatLostPortsSummary(
  tabs: TabItem[],
  ports: SerialPort[],
  disconnectedTabIds: string[],
): string {
  const tabById = new Map(tabs.map((tab) => [tab.id, tab]));
  const portById = new Map(ports.map((port) => [port.id, port]));
  const labels = disconnectedTabIds.map((tabId) => {
    const tab = tabById.get(tabId);
    const portId = getTabPortId(tab);
    if (!portId) return tab?.title ?? tabId;
    const port = portById.get(portId);
    return port?.alias ? `${portId} (${port.alias})` : portId;
  });
  if (labels.length <= 2) return labels.join(', ');
  return `${labels.slice(0, 2).join(', ')} (+${labels.length - 2})`;
}

/**
 * Blinking red banner shown above the StatusBar when one or more open tabs
 * reference ports that became unexpectedly disconnected (USB unplug, device
 * reset, etc.).
 */
const DisconnectBanner: React.FC = () => {
  const tabs = useAppStore((s) => s.tabs);
  const ports = useAppStore((s) => s.ports);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const { openPort } = useSerialConnection();
  const { t } = useTranslation();
  const [dismissRev, setDismissRev] = useState(0);
  const [reconnecting, setReconnecting] = useState(false);

  // `isPortLost` reads the module-level `lostPortIds` Set in disconnectTracking.ts,
  // which mutates in tandem with port status updates (and Dismiss). `ports` and
  // `dismissRev` are in deps so this memo re-runs on every state flip.
  const disconnectedTabIds = useMemo(
    () => filterLostTabIds(tabs, isPortLost),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tabs, ports, dismissRev],
  );

  const lostPortList = useMemo(() => {
    const tabById = new Map(tabs.map((tab) => [tab.id, tab]));
    return disconnectedTabIds
      .map((id) => getTabPortId(tabById.get(id)))
      .filter((portId): portId is string => portId !== null);
  }, [tabs, disconnectedTabIds]);

  const portsSummary = useMemo(
    () => formatLostPortsSummary(tabs, ports, disconnectedTabIds),
    [tabs, ports, disconnectedTabIds],
  );

  const handleView = useCallback(() => {
    if (disconnectedTabIds.length === 0) return;
    const currentIndex = activeTabId ? disconnectedTabIds.indexOf(activeTabId) : -1;
    const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % disconnectedTabIds.length : 0;
    const targetId = disconnectedTabIds[nextIndex];
    if (targetId) setActiveTab(targetId);
  }, [disconnectedTabIds, activeTabId, setActiveTab]);

  const handleReconnect = useCallback(() => {
    if (reconnecting || lostPortList.length === 0) return;
    setReconnecting(true);
    void runSequential(lostPortList, openPort).finally(() => setReconnecting(false));
  }, [reconnecting, lostPortList, openPort]);

  const handleDismiss = useCallback(() => {
    for (const portId of lostPortList) {
      lostPortIds.delete(portId);
    }
    setDismissRev((rev) => rev + 1);
  }, [lostPortList]);

  if (disconnectedTabIds.length === 0) return null;

  return (
    <div className="disconnect-banner blink" role="alert">
      <AlertTriangle size={14} aria-hidden="true" />
      <span className="disconnect-banner-text" title={portsSummary}>
        {t('disconnect.banner.textWithPorts', { ports: portsSummary, count: disconnectedTabIds.length })}
      </span>
      <div className="disconnect-banner-actions">
        <button
          type="button"
          className="disconnect-banner-view-btn"
          onClick={handleView}
        >
          {t('disconnect.banner.view')}
        </button>
        <button
          type="button"
          className="disconnect-banner-view-btn"
          onClick={handleReconnect}
          disabled={reconnecting}
        >
          <RotateCw size={12} className={reconnecting ? 'spin-icon' : undefined} aria-hidden="true" />
          {t('disconnect.banner.reconnect')}
        </button>
        <button
          type="button"
          className="disconnect-banner-dismiss-btn"
          title={t('disconnect.banner.dismiss')}
          aria-label={t('disconnect.banner.dismiss')}
          onClick={handleDismiss}
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
};

export default DisconnectBanner;