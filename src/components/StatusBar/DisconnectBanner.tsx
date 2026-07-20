import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import { useAppStore } from '../../stores/useAppStore';
import { isUserClosingPort } from '../../hooks/useTauri';
import type { TabItem, SerialPort } from '../../types';

/**
 * Pure helper: returns the tab IDs whose ports are unexpectedly disconnected.
 *
 * A tab is "unexpectedly disconnected" when:
 *  - The tab is still open.
 *  - The port is missing from `ports[]` (USB unplug removed it) OR the port
 *    status is `'disconnected'`.
 *  - The disconnect was NOT user-initiated (portId not in `userClosingPortIds`).
 *
 * Exported for unit testing (see `DisconnectBanner.test.ts`).
 */
export function getUnexpectedDisconnectedTabIds(
  tabs: TabItem[],
  ports: SerialPort[],
  userClosingPortIds: Set<string>,
): string[] {
  const portMap = new Map(ports.map(p => [p.id, p]));
  return tabs
    .filter((tab) => {
      if (userClosingPortIds.has(tab.id)) return false;
      const port = portMap.get(tab.id);
      // Port missing from list = USB unplug = unexpected
      if (!port) return true;
      // Port present but disconnected = unexpected (user-initiated already
      // filtered above)
      return port.status === 'disconnected';
    })
    .map(tab => tab.id);
}

/**
 * Blinking red banner shown above the StatusBar when one or more open tabs
 * reference ports that became unexpectedly disconnected (USB unplug, device
 * reset, etc.).
 *
 * The blink animation is CSS-only (`@keyframes disconnected-blink` in
 * `status-bar.css`) so it does not trigger React re-renders. The banner is
 * only mounted while ≥1 unexpected disconnect exists — unmounting stops the
 * animation.
 *
 * "View" button focuses the first affected tab so the user can immediately
 * see which terminal went stale.
 */
const DisconnectBanner: React.FC = () => {
  const tabs = useAppStore((s) => s.tabs);
  const ports = useAppStore((s) => s.ports);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const { t } = useTranslation();

  // Build the effective user-closing set from the module-level probe.
  // `isUserClosingPort` reads the module-level Set in useTauri.ts that is
  // populated by `useSerialConnection.closePort`. Re-evaluated on every
  // render; renders are triggered by `ports`/`tabs` subscription, which
  // always changes in tandem with the closing set (closePort calls
  // updatePort after marking the port).
  const closingSet = useMemo(
    () => {
      const set = new Set<string>();
      for (const tab of tabs) {
        if (isUserClosingPort(tab.id)) set.add(tab.id);
      }
      return set;
    },
    [tabs, ports],
  );

  const disconnectedTabIds = useMemo(
    () => getUnexpectedDisconnectedTabIds(tabs, ports, closingSet),
    [tabs, ports, closingSet],
  );

  if (disconnectedTabIds.length === 0) return null;

  const handleView = () => {
    const firstId = disconnectedTabIds[0];
    if (firstId) setActiveTab(firstId);
  };

  return (
    <div className="disconnect-banner blink" role="alert">
      <AlertTriangle size={14} />
      <span className="disconnect-banner-text">
        {t('disconnect.banner.text', { count: disconnectedTabIds.length })}
      </span>
      <button
        type="button"
        className="disconnect-banner-view-btn"
        onClick={handleView}
      >
        {t('disconnect.banner.view')}
      </button>
    </div>
  );
};

export default DisconnectBanner;