import React, { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import type { TabItem } from '../../types';
import { useAppStore, getTabPortId } from '../../stores/useAppStore';
import { useSystemStore } from '../../stores/useSystemStore';
import {
  getAvailablePluginViews, getPluginViewState, getTabViewPreference,
  isRetriablePluginViewFailure, placePluginView, retryPluginView,
  selectSerialPluginView, subscribePluginViewState,
} from '../../utils/pluginViewRuntime';
import { subscribePluginViews, getPluginViews } from '../../utils/pluginConfigSnapshot';
import { removeTabContentPlacement, setTabContentPlacement } from '../../utils/tabContentPlacement';
import { notifyError } from '../../stores/useToastStore';
import { Settings, AlertTriangle } from 'lucide-react';
import PluginViewPicker, { type PluginViewChoice } from '../shared/PluginViewPicker';
import { TimelineButton } from './TimelineControls';

interface Props { tab: TabItem; hidden: boolean; }

/** Take the user to the page that can actually fix a rejected view: enable,
 *  re-grant, update/disable the plugin, or manage its trusted-web consent. */
function openPluginSettings(): void {
  const system = useSystemStore.getState();
  system.setConfigActiveTab('plugins');
  system.toggleConfigModal(true);
}

const PluginViewSurface: React.FC<Props> = ({ tab, hidden }) => {
  const { t } = useTranslation();
  const state = useSyncExternalStore(subscribePluginViewState, () => getPluginViewState(tab.id));
  useSyncExternalStore(subscribePluginViews, getPluginViews);
  const zoomPercent = useAppStore(store => store.config.uiScalePercent);
  useAppStore(store => tab.kind === 'serial' ? store.ports.find(port => port.id === tab.portId)?.displayView : undefined);
  useAppStore(store => { const id = getTabPortId(tab); return id ? store.ports.find(port => port.id === id)?.mode : undefined; });
  const bodyRef = useRef<HTMLDivElement>(null);
  const preference = getTabViewPreference(tab);
  const portId = getTabPortId(tab);
  const isRemoteProjected = tab.kind === 'plugin' && Boolean(tab.remoteProfileId);
  const pluginName = tab.kind === 'plugin'
    ? (isRemoteProjected
      ? `[${tab.remoteHostLabel || tab.remoteProfileId}] ${tab.remotePluginName || tab.pluginId}`
      : (getPluginViews().find(plugin => plugin.id === tab.pluginId)?.manifest?.name ?? tab.pluginId))
    : null;
  const pluginEffective = !!preference && state.status !== 'unavailable';
  const stockVisible = tab.kind === 'replay' || (tab.kind === 'serial' && !pluginEffective);
  // A rejected page must never look like a silent fallback: keep the toolbar (and
  // therefore the reason + actions) visible even when the raw terminal took over.
  const rejected = !!preference && state.status === 'unavailable';
  const serialRejectedFallback = tab.kind === 'serial' && stockVisible && rejected;
  const showToolbar = !stockVisible || rejected;
  const retriable = isRetriablePluginViewFailure(state.code);
  const reasonKey = state.code ? `pluginViews.failure.${state.code}` : null;
  const replacements = tab.kind === 'serial' ? getAvailablePluginViews(portId, 'serial-content') : [];
  const selected = preference ? `${preference.pluginId}/${preference.viewId}` : '';
  useLayoutEffect(() => {
    const element = bodyRef.current;
    if (!element) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = element.getBoundingClientRect();
        const bounds = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        setTabContentPlacement({ tabId: tab.id, rect: bounds, visible: !hidden, stockVisible });
        placePluginView(tab.id, { ...bounds, zoomPercent }, !hidden && pluginEffective);
      });
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    update();
    return () => {
      cancelAnimationFrame(frame); observer.disconnect();
      window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true);
      removeTabContentPlacement(tab.id);
      placePluginView(tab.id, { x: 0, y: 0, width: 0, height: 0, zoomPercent }, false);
    };
  }, [tab.id, hidden, stockVisible, pluginEffective, state.instanceId, zoomPercent, showToolbar]);

  const choose = (choice: PluginViewChoice | null) => {
    try { selectSerialPluginView(tab.id, choice?.preference ?? null); }
    catch (error) { notifyError(error); }
  };
  const unavailablePreference = preference && !replacements.some(item => `${item.preference.pluginId}/${item.preference.viewId}` === selected)
    ? { key: selected, label: `${preference.pluginId}: ${preference.viewId}` }
    : undefined;
  // A structural rejection (changed install, missing grant/consent/view, wrong
  // port binding) cannot be fixed by retrying; offer the page that can fix it.
  const failureActions = rejected ? <>
    {!isRemoteProjected && (
      <button type="button" className="btn btn-sm" onClick={openPluginSettings} title={t('pluginViews.failureHint')}>
        <Settings size={12} /> {t('pluginViews.openSettings')}
      </button>
    )}
    {(retriable || isRemoteProjected) && <button type="button" className="btn btn-sm" onClick={() => retryPluginView(tab.id)}>{t('pluginViews.retry')}</button>}
    {serialRejectedFallback && (
      <button type="button" className="btn btn-sm" onClick={() => choose(null)}>
        {t('pluginViews.switchToTerminal')}
      </button>
    )}
  </> : null;
  const failureText = rejected
    ? <span className="plugin-view-error-inline" title={state.error ?? ''}>
      {serialRejectedFallback && <AlertTriangle size={13} className="plugin-view-error-icon" aria-hidden="true" />}
      {t('pluginViews.failureLead', { reason: reasonKey ? t(reasonKey) : (state.error ?? '') })}
    </span>
    : null;
  return <div className="plugin-view-tab" style={{ display: hidden ? 'none' : 'flex' }}>
    {showToolbar && (serialRejectedFallback ? (
      <div className="plugin-view-toolbar plugin-view-toolbar-alert" role="alert">
        {failureText}
        <span className="plugin-view-toolbar-spacer" />
        <div className="plugin-view-toolbar-actions">{failureActions}</div>
      </div>
    ) : (
      <div className="plugin-view-toolbar">
        {tab.kind === 'serial' ? (
          <PluginViewPicker
            choices={replacements}
            value={selected}
            rawOption={{ key: '', label: t('pluginViews.terminal') }}
            fallbackOption={unavailablePreference}
            triggerLabel={t('pluginViews.view')}
            title={t('pluginViews.view')}
            ariaLabel={t('pluginViews.view')}
            onSelect={choose}
          />
        ) : (
          <span className="plugin-view-source">
            <span className="plugin-view-source-name">{pluginName}</span>
            {portId && <span className="plugin-view-source-port">· {portId}</span>}
          </span>
        )}
        <TimelineButton tabId={tab.id} />
        <span className="plugin-view-toolbar-spacer" />
        {failureText}
        {failureActions}
      </div>
    ))}
    <div ref={bodyRef} className="plugin-view-body">
      {tab.kind === 'plugin' && rejected && <div className="plugin-view-placeholder">
        <strong>{t('pluginViews.unavailable')}</strong>
        <p>{reasonKey ? t(reasonKey) : state.error}</p>
        {!isRemoteProjected && <p className="plugin-view-failure-hint">{t('pluginViews.failureHint')}</p>}
        <div className="plugin-view-failure-actions">
          {!isRemoteProjected && (
            <button className="btn" onClick={openPluginSettings}>
              <Settings size={14} /> {t('pluginViews.openSettings')}
            </button>
          )}
          {(retriable || isRemoteProjected) && <button className="btn" onClick={() => retryPluginView(tab.id)}>{t('pluginViews.retry')}</button>}
        </div>
      </div>}
      {pluginEffective && state.status === 'loading' && <div className="plugin-view-placeholder">{t('pluginViews.loading')}</div>}
    </div>
  </div>;
};
export default PluginViewSurface;
