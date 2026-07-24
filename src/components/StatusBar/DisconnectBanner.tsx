import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import { useAppStore } from '../../stores/useAppStore';
import { isPortLost } from '../../hooks/useTauri';
import type { TabItem } from '../../types';

/**
 * Pure helper: returns the IDs of open tabs whose ports are "lost".
 *
 * A port is lost only after a real connected → disconnected transition THIS
 * session (tracked by `lostPortIds` in useTauri.ts). Session-restored tabs
 * were never connected this session, so they never light up the banner —
 * that is what fixes the startup false-alarm.
 *
 * Exported for unit testing (see `DisconnectBanner.test.ts`).
 */
export function filterLostTabIds(
  tabs: TabItem[],
  isLost: (id: string) => boolean,
): string[] {
  return tabs.filter((t) => isLost(t.id)).map((t) => t.id);
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

  // `isPortLost` reads the module-level `lostPortIds` Set in useTauri.ts,
  // which mutates in tandem with port status updates (the status handler
  // adds on unexpected disconnect and deletes on connect, and openPort /
  // closePort / reconnect clear it). `ports` is in the deps so this memo
  // re-runs on every status change that can flip a port's lost state.
  const disconnectedTabIds = useMemo(
    () => filterLostTabIds(tabs, isPortLost),
    [tabs, ports],
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