/**
 * 插件设置页（issue #17）
 *
 * 功能：列出已安装插件（磁盘扫描 + config 状态）、启用/禁用、卸载、
 * 权限授予（manifest 声明是上限，勾选实际授予）、安装（目录/zip 经系统对话框）。
 * 数据源：usePlugins hook（列表 state + 命令），宿主会话同步在 hook 内完成。
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { open } from '@tauri-apps/plugin-dialog';
import {
  Plug,
  Download,
  Trash2,
  Power,
  FolderOpen,
  FileArchive,
  RefreshCw,
  AlertTriangle,
} from 'lucide-react';
import { usePluginList, usePluginMarketplace, isPluginReplaceConfirmationError, replacementTargetId } from '../../../hooks/usePlugins';
import { effectivePermissions, hasTrustedViews, reviewablePermissions } from '../../../utils/pluginPermissionReview';
import { PluginPermissionDialog, type PendingPermissionReview } from './PluginPermissionDialog';
import { PluginSettingsInstallProgress, canCancelDirectoryInstall, type DirectoryInstallPanelState } from './PluginSettingsInstallProgress';
import { pluginService } from '../../../services/plugin';
import { useConfigPersistence } from '../../../hooks/useConfigPersistence';
import { notifyError } from '../../../stores/useToastStore';
import ConfirmDialog from '../../shared/ConfirmDialog';

/** Uninstalling retires native webviews and clears browser data on the UI thread,
 *  which can take tens of seconds. The panel is painted before the invoke starts
 *  and keeps counting, so a slow uninstall never looks like a frozen app. */
const UninstallProgress: React.FC<{ name: string; startedAt: number }> = ({ name, startedAt }) => {
  const { t } = useTranslation();
  const [elapsed, setElapsed] = React.useState(0);
  const dialogRef = React.useRef<HTMLDivElement>(null);
  useDialogLifecycle({ open: true, dialogRef, disableEscape: true });
  React.useEffect(() => {
    const tick = () => setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    tick();
    const timer = setInterval(tick, 500);
    return () => clearInterval(timer);
  }, [startedAt]);
  const label = t('plugins.uninstalling', { name });
  return <div ref={dialogRef} tabIndex={-1} className="plugin-uninstall-overlay" role="alertdialog" aria-modal="true" aria-busy="true" aria-label={label}>
    <div className="plugin-uninstall-panel">
      <div className="plugin-uninstall-title">{label}</div>
      <div className="plugin-uninstall-bar" role="progressbar" aria-valuetext={label}><span className="plugin-uninstall-bar-fill" /></div>
      <p className="plugin-uninstall-hint">{t('plugins.uninstallProgressHint')}</p>
      <p className="plugin-uninstall-elapsed">{t('plugins.uninstallElapsed', { seconds: elapsed })}</p>
    </div>
  </div>;
};
import { useAppStore } from '../../../stores/useAppStore';
import type { MarketplaceUpdate, PluginView } from '../../../types';
import { usePluginViewOverlay } from '../../shared/usePluginViewOverlay';
import { useDialogLifecycle } from '../../shared/useDialogLifecycle';

function ClearWebDataDialog({ plugin, working, onCancel, onAccept }: {
  plugin: PluginView; working: boolean; onCancel: () => void; onAccept: () => void;
}) {
  const { t } = useTranslation();
  const ready = usePluginViewOverlay();
  const ref = React.useRef<HTMLDivElement>(null);
  useDialogLifecycle({ open: ready, dialogRef: ref, onClose: onCancel, disableEscape: working });
  if (!ready) return null;
  return <div className="modal-overlay" role="presentation" onClick={event => event.stopPropagation()}>
    <div ref={ref} tabIndex={-1} className="modal-dialog-compact plugin-permission-dialog" role="dialog" aria-modal="true" aria-labelledby="clear-web-title" aria-describedby="clear-web-description">
      <h3 id="clear-web-title">{t('plugins.clearWebDataTitle')}</h3>
      <p><strong>{plugin.manifest?.name ?? plugin.id}</strong> · {plugin.manifest?.version}</p>
      <p id="clear-web-description">{t('plugins.clearWebDataDescription')}</p>
      <div className="plugin-permission-dialog-actions">
        <button className="btn" disabled={working} onClick={onCancel}>{t('plugins.trustedWebCancel')}</button>
        <button className="btn btn-danger" disabled={working} onClick={onAccept}>{t('plugins.clearWebData')}</button>
      </div>
    </div>
  </div>;
}

const PluginSettings: React.FC = () => {
  const { t } = useTranslation();
  const { saveConfig } = useConfigPersistence();
  const {
    plugins,
    loading,
    refresh,
    installPlugin,
    installMarketplacePlugin,
    reloadPlugin,
    applyPermissionReview,
    uninstallPlugin,
    setEnabled,
    revokeTrustedWeb,
    clearWebData,
  } = usePluginList();
  const [review, setReview] = React.useState<PendingPermissionReview | null>(null);
  const [pendingClear, setPendingClear] = React.useState<PluginView | null>(null);
  const [pendingUninstall, setPendingUninstall] = React.useState<PluginView | null>(null);
  const [pendingReplace, setPendingReplace] = React.useState<{
    selected: string;
    source: 'directory' | 'zip';
    name: string;
    version: string;
    expectedGeneration: string;
  } | null>(null);
  const [working, setWorking] = React.useState(false);
  // One uninstall at a time; the panel outlives the click that started it.
  const [uninstalling, setUninstalling] = React.useState<{ name: string; startedAt: number } | null>(null);
  const uninstallBusyRef = React.useRef(false);
  // Hook queues serialize mutations, but a fast double-click can enqueue the
  // same plugin before React commits `loading`. Keep a synchronous per-plugin
  // admission set as a UI busy guard; the hook remains the authority for CAS.
  const busyPluginRef = React.useRef(new Set<string>());
  const [busyPlugins, setBusyPlugins] = React.useState<ReadonlySet<string>>(new Set());
  const beginPluginBusy = (pluginId: string): boolean => {
    if (busyPluginRef.current.has(pluginId)) return false;
    busyPluginRef.current.add(pluginId);
    setBusyPlugins(new Set(busyPluginRef.current));
    return true;
  };
  const endPluginBusy = (pluginId: string): void => {
    busyPluginRef.current.delete(pluginId);
    setBusyPlugins(new Set(busyPluginRef.current));
  };
  // 插件出站代理（issue #17）：宿主显式配置的代理优先；未配置时继承系统代理。
  const pluginProxyEnabled = useAppStore((s) => s.config.pluginProxyEnabled);
  const pluginProxy = useAppStore((s) => s.config.pluginProxy);
  const pluginMarketplaceUrl = useAppStore((s) => s.config.pluginMarketplaceUrl);
  const setConfig = useAppStore((s) => s.setConfig);
  const {
    index: marketplaceIndex,
    updates: marketplaceUpdates,
    loading: marketplaceLoading,
    error: marketplaceError,
    fetchIndex: fetchMarketplace,
    checkUpdates: checkMarketplaceUpdates,
  } = usePluginMarketplace(pluginMarketplaceUrl);
  const [marketplaceBusyId, setMarketplaceBusyId] = React.useState<string | null>(null);
  const [marketplaceOpen, setMarketplaceOpen] = React.useState(() => Boolean(pluginMarketplaceUrl.trim() || marketplaceIndex));
  React.useEffect(() => {
    if (marketplaceIndex) setMarketplaceOpen(true);
  }, [marketplaceIndex]);
  const [directoryInstall, setDirectoryInstall] = React.useState<DirectoryInstallPanelState | null>(null);
  const installPickerBusy = React.useRef(false);
  const cancelBusy = React.useRef<string | null>(null);
  const handleInstallCancel = async () => {
    if (!directoryInstall || !canCancelDirectoryInstall(directoryInstall)) return;
    const { requestId } = directoryInstall;
    if (cancelBusy.current === requestId) return;
    cancelBusy.current = requestId;
    setDirectoryInstall(current => current?.requestId === requestId ? { ...current, cancel: 'pending' } : current);
    try {
      const cancel = await pluginService.cancelPluginInstall(requestId);
      setDirectoryInstall(current => current?.requestId === requestId ? { ...current, cancel } : current);
    } catch {
      setDirectoryInstall(current => current?.requestId === requestId ? { ...current, cancel: 'failed' } : current);
    } finally {
      if (cancelBusy.current === requestId) cancelBusy.current = null;
    }
  };

  const runInstall = async (
    source: 'directory' | 'zip',
    selected: string,
    replaceExisting?: boolean,
    expectedGeneration?: string,
  ): Promise<PluginView | null> => {
    if (source === 'zip') {
      return expectedGeneration === undefined
        ? installPlugin(selected)
        : installPlugin(selected, replaceExisting, expectedGeneration);
    }
    const requestId = crypto.randomUUID();
    setDirectoryInstall({ requestId, progress: null, cancel: 'none' });
    try {
      return await installPlugin(selected, replaceExisting, expectedGeneration, {
        requestId,
        onProgress: progress => setDirectoryInstall(current => current?.requestId === requestId
          ? { ...current, progress } : current),
      });
    } finally {
      setDirectoryInstall(current => current?.requestId === requestId ? null : current);
    }
  };

  const handleInstall = async (source: 'directory' | 'zip'): Promise<void> => {
    if (installPickerBusy.current) return;
    installPickerBusy.current = true;
    try {
      const selected = source === 'directory'
        ? await open({ directory: true, multiple: false, title: t('plugins.installDirectory') })
        : await open({ multiple: false, filters: [{ name: 'Plugin archive', extensions: ['zip'] }], title: t('plugins.installZip') });
      if (typeof selected !== 'string') return;
      let installed: PluginView | null;
      try {
        installed = await runInstall(source, selected);
      } catch (error) {
        // Same/lower version: not a failure yet. Ask for an explicit
        // replacement (data preserved, grants/trust reset) before retrying.
        if (!isPluginReplaceConfirmationError(error)) return;
        const targetId = replacementTargetId(error);
        const refreshed = await refresh();
        const reviewed = (refreshed ?? plugins).find(plugin => plugin.id === targetId);
        if (!reviewed?.installGeneration) {
          notifyError(new Error(t('plugins.replaceGenerationError')));
          return;
        }
        setPendingReplace({
          selected,
          source,
          name: reviewed.manifest?.name ?? reviewed.id,
          version: reviewed.manifest?.version ?? '',
          expectedGeneration: reviewed.installGeneration,
        });
        return;
      }
      if (installed?.manifest) setReview({ plugin: installed, intent: 'install' });
    } catch (error) {
      console.debug('[PluginSettings] install failed:', error);
    } finally {
      installPickerBusy.current = false;
    }
  };

  const handleConfirmReplace = async (): Promise<void> => {
    const target = pendingReplace;
    setPendingReplace(null);
    if (!target) return;
    try {
      const installed = await runInstall(target.source, target.selected, true, target.expectedGeneration);
      if (installed?.manifest) setReview({ plugin: installed, intent: 'install' });
    } catch (error) {
      console.debug('[PluginSettings] replace install failed:', error);
    }
  };

  const handleConfirmUninstall = (): void => {
    const plugin = pendingUninstall;
    setPendingUninstall(null);
    if (!plugin) return;
    const { id, installGeneration } = plugin;
    if (!installGeneration || uninstallBusyRef.current || busyPluginRef.current.has(id)) return;
    const name = plugin.manifest?.name ?? id;
    if (!beginPluginBusy(id)) return;
    uninstallBusyRef.current = true;
    setUninstalling({ name, startedAt: Date.now() });
    // Paint before native teardown. A timer races rAF because hidden documents pause rAF.
    let started = false;
    const begin = () => {
      if (started) return;
      started = true;
      void uninstallPlugin(id, installGeneration).catch(() => {}).finally(() => {
        uninstallBusyRef.current = false;
        endPluginBusy(id);
        setUninstalling(null);
      });
    };
    requestAnimationFrame(() => requestAnimationFrame(begin));
    setTimeout(begin, 250);
  };

  const persistMarketplaceSource = async (source: string): Promise<boolean> =>
    saveConfig({ pluginMarketplaceUrl: source }, true);

  const handleMarketplaceRefresh = async (): Promise<void> => {
    const source = pluginMarketplaceUrl.trim();
    const index = await fetchMarketplace();
    if (!index) return;
    // Persist before the second metadata/version request so the backend's
    // persisted-source fallback cannot replace the address just entered.
    if (!(await persistMarketplaceSource(source))) return;
    await checkMarketplaceUpdates();
  };

  const handleMarketplaceCheck = async (): Promise<void> => {
    const source = pluginMarketplaceUrl.trim();
    if (!(await persistMarketplaceSource(source))) return;
    await checkMarketplaceUpdates();
  };

  const handleMarketplaceInstall = async (update: MarketplaceUpdate, expectedGeneration?: string): Promise<void> => {
    if (marketplaceBusyId || loading || !update.descriptionUrl || !update.latestVersion) return;
    setMarketplaceBusyId(update.id);
    if (!beginPluginBusy(update.id)) {
      setMarketplaceBusyId(null);
      return;
    }
    try {
      const installed = await installMarketplacePlugin(update, expectedGeneration);
      if (installed?.manifest) setReview({ plugin: installed, intent: 'install', preview: update.manifest });
    } catch (error) {
      console.debug('[PluginSettings] marketplace install failed:', error);
    } finally {
      endPluginBusy(update.id);
      setMarketplaceBusyId(null);
    }
  };


  const handleToggleEnabled = (plugin: PluginView): void => {
    if (!plugin.enabled && hasTrustedViews(plugin.manifest) && plugin.trustedWebGranted !== true) {
      setReview({ plugin, intent: 'enable' });
      return;
    }
    if (!beginPluginBusy(plugin.id)) return;
    void setEnabled(plugin.id, !plugin.enabled, plugin.installGeneration)
      .finally(() => endPluginBusy(plugin.id));
  };

  return (
    <>
      <div className="plugin-settings">
        <section className="plugin-immediate-section" aria-labelledby="plugin-immediate-title">
          <div className="settings-section-header">
            <div>
              <div className="plugin-section-title-row">
                <h3 id="plugin-immediate-title" className="config-section-title">{t('plugins.installedSectionTitle')}</h3>
                <span className="plugin-installed-count">{t('plugins.installedCount', { count: plugins.length })}</span>
              </div>
              <p className="settings-hint">{t('plugins.installedSectionHint')}</p>
            </div>
            <div className="plugin-settings-actions">
              <button type="button" className="btn btn-sm" onClick={() => void refresh()} disabled={loading}>
                <RefreshCw size={14} /> {t('plugins.refresh')}
              </button>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => void handleInstall('directory')} disabled={loading}>
                <FolderOpen size={14} /> {t('plugins.installDirectory')}
              </button>
              <button type="button" className="btn btn-sm" onClick={() => void handleInstall('zip')} disabled={loading}>
                <FileArchive size={14} /> {t('plugins.installZip')}
              </button>
            </div>
          </div>
        </section>

        {plugins.length === 0 ? (
          <div className="plugin-empty">
            <Plug size={32} />
            <p>{t('plugins.emptyText')}</p>
            <p className="settings-hint">{t('plugins.installHint')}</p>
          </div>
        ) : (
          <div className="plugin-list">
            {plugins.map((plugin, index) => {
              const declared = reviewablePermissions(plugin);
              const source = plugin.source === 'marketplace' ? 'marketplace' : 'manual';
              const previousSource = plugins[index - 1]?.source === 'marketplace' ? 'marketplace' : 'manual';
              const showGroupTitle = index === 0 || source !== previousSource;
              const granted = effectivePermissions(plugin);
              return (
                <React.Fragment key={plugin.id}>
                  {showGroupTitle && <div className="plugin-list-group-title">
                    {source === 'marketplace' ? t('plugins.localSourceMarketplace') : t('plugins.localSourceManual')}
                  </div>}
                  <div className={`plugin-card ${plugin.manifestError ? 'plugin-card-error' : ''}`}>
                  <div className="plugin-card-header">
                    <div className="plugin-card-title">
                      <strong>{plugin.manifest?.name ?? plugin.id}</strong>
                      <span className="plugin-card-id">{plugin.id}</span>
                      {plugin.manifest && (
                        <span className="plugin-card-version">
                          {t('plugins.version', { version: plugin.manifest.version })} ·{' '}
                          {t('plugins.apiVersion', { version: plugin.manifest.apiVersion })}
                        </span>
                      )}
                      {hasTrustedViews(plugin.manifest) && <span className="plugin-card-version">{t(plugin.trustedWebGranted === true ? 'plugins.trustedWebBadge' : 'plugins.trustedWebPendingBadge')}</span>}
                    </div>
                    <div className="plugin-card-controls">
                      {plugin.trustedWebGranted === true && <button type="button" className="btn btn-danger btn-sm" disabled={loading || busyPlugins.has(plugin.id)} onClick={() => {
                        if (!beginPluginBusy(plugin.id)) return;
                        void revokeTrustedWeb(plugin.id, plugin.installGeneration)
                          .catch(() => {}).finally(() => endPluginBusy(plugin.id));
                      }}>{t('plugins.revokeTrustedWeb')}</button>}
                      {hasTrustedViews(plugin.manifest) && <button type="button" className="btn btn-sm" disabled={loading || busyPlugins.has(plugin.id)} onClick={() => setPendingClear(plugin)}>{t('plugins.clearWebData')}</button>}
                      <button
                        type="button"
                        className="btn btn-sm"
                        title={t('plugins.reloadCodeHint')}
                        onClick={() => {
                          if (!beginPluginBusy(plugin.id)) return;
                          void reloadPlugin(plugin.id, plugin.installGeneration)
                            .catch(() => {}).finally(() => endPluginBusy(plugin.id));
                        }}
                        disabled={loading || busyPlugins.has(plugin.id) || !plugin.enabled || !!plugin.manifestError}
                      >
                        <RefreshCw size={13} /> {t('plugins.reloadCode')}
                      </button>
                      <button
                        type="button"
                        className={`btn btn-sm${plugin.enabled ? ' active' : ''}`}
                        onClick={() => handleToggleEnabled(plugin)}
                        disabled={loading || busyPlugins.has(plugin.id) || !plugin.installGeneration || !!plugin.manifestError}
                      >
                        <Power size={13} /> {plugin.enabled ? t('plugins.disable') : t('plugins.enable')}
                      </button>
                      <button
                        type="button"
                        className="btn btn-danger btn-sm"
                        disabled={loading || !!uninstalling || !plugin.installGeneration || busyPlugins.has(plugin.id)}
                        onClick={() => {
                          if (!plugin.installGeneration || uninstallBusyRef.current || busyPluginRef.current.has(plugin.id)) return;
                          setPendingUninstall(plugin);
                        }}
                      >
                        <Trash2 size={13} /> {t('plugins.uninstall')}
                      </button>
                    </div>
                  </div>

                  {plugin.manifestError ? (
                    <div className="plugin-error-row">
                      <AlertTriangle size={13} />
                      <span>{t('plugins.manifestError', { error: plugin.manifestError })}</span>
                    </div>
                  ) : (
                    <>
                      <p className="plugin-desc">{plugin.manifest?.description}</p>

                      <div className="plugin-perms">
                        <div className="plugin-perms-header">
                          <strong>{t('plugins.permissions')}</strong>
                          {declared.length > 0 && <span className="settings-hint">
                            {t('plugins.review.summary', { count: granted.length, total: declared.length })}
                          </span>}
                          {(declared.length > 0 || hasTrustedViews(plugin.manifest) && plugin.trustedWebGranted !== true) &&
                            <button type="button" className="btn btn-sm" disabled={loading || busyPlugins.has(plugin.id) || !plugin.installGeneration}
                              onClick={() => setReview({ plugin, intent: 'manage' })}>{t('plugins.review.manage')}</button>}
                        </div>
                        {declared.length === 0 && <p className="settings-hint">{t('plugins.noPermissions')}</p>}
                      </div>
                    </>
                  )}
                </div>
                </React.Fragment>
              );
            })}
          </div>
        )}

        <details
          open={marketplaceOpen}
          onToggle={(event) => setMarketplaceOpen((event.currentTarget as HTMLDetailsElement).open)}
          className="plugin-marketplace-section plugin-secondary-section"
        >
          <summary className="plugin-secondary-summary">
            <span className="plugin-secondary-summary-copy">
              <strong>{t('plugins.marketplace.title')}</strong>
              <span className="settings-hint">{t('plugins.marketplace.summary')}</span>
            </span>
          </summary>
          <div className="plugin-secondary-body">
          <div className="settings-section-header">
            <div>
              <p className="settings-hint">{t('plugins.marketplace.description')}</p>
            </div>
            <div className="plugin-settings-actions">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void handleMarketplaceRefresh()}
                disabled={marketplaceLoading || !pluginMarketplaceUrl.trim()}
              >
                <RefreshCw size={14} /> {t('plugins.marketplace.fetch')}
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void handleMarketplaceCheck()}
                disabled={marketplaceLoading || !pluginMarketplaceUrl.trim()}
              >
                <RefreshCw size={14} /> {t('plugins.marketplace.checkUpdates')}
              </button>
            </div>
          </div>
          <div className="config-row">
            <label htmlFor="plugin-marketplace-url">{t('plugins.marketplace.sourceLabel')}</label>
            <input
              id="plugin-marketplace-url"
              className="input config-flex-input"
              value={pluginMarketplaceUrl}
              placeholder={t('plugins.marketplace.sourcePlaceholder')}
              onChange={(event) => setConfig({ pluginMarketplaceUrl: event.target.value })}
            />
          </div>
          <p className="settings-hint">{t('plugins.marketplace.saveHint')}</p>
          {marketplaceError && <p className="plugin-marketplace-error" role="alert">
            {marketplaceError === 'marketplace source is empty' ? t('plugins.marketplace.sourceRequired') : marketplaceError}
          </p>}
          {marketplaceIndex ? (
            <div className="plugin-marketplace-results" aria-live="polite">
              <div className="plugin-marketplace-results-heading">
                <strong>{t('plugins.marketplace.results')}</strong>
                <span className="settings-hint">{t('plugins.marketplace.resultCount', { count: marketplaceIndex.plugins.length })}</span>
              </div>
              {marketplaceUpdates.length === 0 ? (
                <p className="settings-hint">{t('plugins.marketplace.checkForDetails')}</p>
              ) : (
                <div className="plugin-marketplace-list">
                  {marketplaceUpdates.map((update) => {
                    const installed = plugins.find(plugin => plugin.id === update.id);
                    const currentVersion = update.currentVersion ?? installed?.manifest?.version;
                    const updateAvailable = update.updateAvailable;
                    const status = !installed
                      ? t('plugins.marketplace.statusNotInstalled')
                      : updateAvailable
                        ? t('plugins.marketplace.statusUpdateAvailable')
                        : t('plugins.marketplace.statusLatest');
                    return (
                      <div key={update.descriptionUrl} className="plugin-marketplace-card">
                        <div className="plugin-marketplace-card-copy">
                          <div className="plugin-marketplace-card-title-row">
                            <strong>{update.manifest.name}</strong>
                            <span className={`plugin-marketplace-status${updateAvailable ? ' is-update' : ''}`}>{status}</span>
                          </div>
                          <code>{update.id}</code>
                          <span className="settings-hint">
                            {currentVersion
                              ? t('plugins.marketplace.installedVersion', { version: currentVersion })
                              : t('plugins.marketplace.notInstalled')}
                            {' · '}{t('plugins.marketplace.latestVersion', { version: update.latestVersion })}
                            {' · '}{t('plugins.marketplace.permissionCount', { count: update.manifest.permissions.length })}
                          </span>
                          {update.manifest.description && <span className="settings-hint">{update.manifest.description}</span>}
                        </div>
                        <div className="plugin-marketplace-card-action">
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            disabled={marketplaceLoading || loading || marketplaceBusyId !== null || busyPlugins.has(update.id) || !updateAvailable}
                            onClick={() => void handleMarketplaceInstall(update, installed?.installGeneration)}
                          >
                            <Download size={13} /> {installed ? t('plugins.marketplace.update') : t('plugins.marketplace.install')}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <p className="settings-hint">{t('plugins.marketplace.noIndex')}</p>
          )}
        </div>
        </details>

        <details className="plugin-proxy-section plugin-secondary-section">
          <summary className="plugin-secondary-summary">
            <span className="plugin-secondary-summary-copy">
              <strong>{t('plugins.proxy.sectionTitle')}</strong>
              <span className="settings-hint">{t('plugins.proxy.summary')}</span>
            </span>
          </summary>
          <div className="plugin-secondary-body">
          <p className="settings-hint">{t('plugins.proxy.saveHint')}</p>
          <label className="checkbox-wrapper">
            <input
              type="checkbox"
              checked={pluginProxyEnabled}
              onChange={(e) => setConfig({ pluginProxyEnabled: e.target.checked })}
            />
            {t('plugins.proxy.enable')}
          </label>

          {pluginProxyEnabled && (
            <div className="config-row">
              <label htmlFor="plugin-proxy-url">{t('plugins.proxy.urlLabel')}</label>
              <input
                id="plugin-proxy-url"
                className="input config-flex-input"
                value={pluginProxy}
                placeholder={t('plugins.proxy.urlPlaceholder')}
                onChange={(e) => setConfig({ pluginProxy: e.target.value })}
              />
            </div>
          )}
          <p className="settings-hint">{t('plugins.proxy.hint')}</p>
          </div>
        </details>
      </div>
    <ConfirmDialog
      open={pendingReplace !== null}
      title={t('plugins.replaceConfirmTitle')}
      message={pendingReplace ? t('plugins.replaceConfirm', { name: pendingReplace.name, version: pendingReplace.version }) : ''}
      confirmLabel={t('confirmDialog.confirm')}
      cancelLabel={t('confirmDialog.cancel')}
      danger
      onConfirm={() => { void handleConfirmReplace(); }}
      onCancel={() => setPendingReplace(null)}
    />
    <ConfirmDialog
      open={pendingUninstall !== null}
      title={t('plugins.uninstallConfirmTitle')}
      message={pendingUninstall ? t('plugins.uninstallConfirm', { name: pendingUninstall.manifest?.name ?? pendingUninstall.id }) : ''}
      confirmLabel={t('plugins.uninstall')}
      cancelLabel={t('confirmDialog.cancel')}
      danger
      onConfirm={handleConfirmUninstall}
      onCancel={() => setPendingUninstall(null)}
    />
    {pendingClear && <ClearWebDataDialog
      plugin={pendingClear}
      working={working || loading}
      onCancel={() => setPendingClear(null)}
      onAccept={() => {
        const { id, installGeneration } = pendingClear;
        if (!beginPluginBusy(id)) return;
        setWorking(true);
        void clearWebData(id, installGeneration).catch(() => {}).finally(() => {
          setPendingClear(null);
          setWorking(false);
          endPluginBusy(id);
        });
      }}
    />}
    {review && <PluginPermissionDialog
      key={`${review.plugin.id}:${review.plugin.installGeneration}:${review.intent}`}
      review={review}
      working={loading || busyPlugins.has(review.plugin.id)}
      onCancel={() => setReview(null)}
      onApply={decision => {
        const { id } = decision.plugin;
        if (!beginPluginBusy(id)) return;
        void applyPermissionReview(decision).catch(() => {}).finally(() => {
          setReview(null);
          endPluginBusy(id);
        });
      }}
    />}
    {directoryInstall && <PluginSettingsInstallProgress state={directoryInstall} onCancel={() => void handleInstallCancel()} />}
    {uninstalling && <UninstallProgress name={uninstalling.name} startedAt={uninstalling.startedAt} />}
    </>
  );
};

export default PluginSettings;
