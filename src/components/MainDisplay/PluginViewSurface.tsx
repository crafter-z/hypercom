import React, { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import type { TabItem } from '../../types';
import { useAppStore, getTabPortId } from '../../stores/useAppStore';
import {
  getAvailablePluginViews, getPluginViewState, getTabViewPreference,
  placePluginView, retryPluginView,
  selectSerialPluginView, subscribePluginViewState,
} from '../../utils/pluginViewRuntime';
import { subscribePluginViews, getPluginViews } from '../../utils/pluginConfigSnapshot';
import { removeTabContentPlacement, setTabContentPlacement } from '../../utils/tabContentPlacement';
import { notifyError } from '../../stores/useToastStore';
import PluginViewPicker, { type PluginViewChoice } from '../shared/PluginViewPicker';

interface Props { tab: TabItem; hidden: boolean; }
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
  const pluginName = tab.kind === 'plugin'
    ? (getPluginViews().find(plugin => plugin.id === tab.pluginId)?.manifest?.name ?? tab.pluginId)
    : null;
  const pluginEffective = !!preference && state.status !== 'unavailable';
  const stockVisible = tab.kind === 'serial' && !pluginEffective;
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
  }, [tab.id, hidden, stockVisible, pluginEffective, state.instanceId, zoomPercent]);

  const choose = (choice: PluginViewChoice | null) => {
    try { selectSerialPluginView(tab.id, choice?.preference ?? null); }
    catch (error) { notifyError(error); }
  };
  const unavailablePreference = preference && !replacements.some(item => `${item.preference.pluginId}/${item.preference.viewId}` === selected)
    ? { key: selected, label: `${preference.pluginId}: ${preference.viewId}` }
    : undefined;
  return <div className="plugin-view-tab" style={{ display: hidden ? 'none' : 'flex' }}>
    {!stockVisible && <div className="plugin-view-toolbar">
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
      <span className="plugin-view-toolbar-spacer" />
      {preference && state.status === 'unavailable' && <>
        <span className="plugin-view-error-inline" title={state.error ?? ''}>{t('pluginViews.unavailable')}</span>
        <button className="btn btn-sm" onClick={() => retryPluginView(tab.id)}>{t('pluginViews.retry')}</button>
      </>}
    </div>}
    <div ref={bodyRef} className="plugin-view-body">
      {tab.kind === 'plugin' && state.status === 'unavailable' && <div className="plugin-view-placeholder">
        <strong>{t('pluginViews.unavailable')}</strong><p>{state.error}</p>
        <button className="btn" onClick={() => retryPluginView(tab.id)}>{t('pluginViews.retry')}</button>
      </div>}
      {pluginEffective && state.status === 'loading' && <div className="plugin-view-placeholder">{t('pluginViews.loading')}</div>}
    </div>
  </div>;
};
export default PluginViewSurface;
