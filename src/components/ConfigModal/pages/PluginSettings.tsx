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
  Trash2,
  Power,
  FolderOpen,
  RefreshCw,
  AlertTriangle,
  Check,
  X,
} from 'lucide-react';
import { usePluginList } from '../../../hooks/usePlugins';
import { SENSITIVE_PERMISSIONS } from '../../../utils/pluginRpc';
import { useAppStore } from '../../../stores/useAppStore';
import type { PluginView } from '../../../types';

const PluginSettings: React.FC = () => {
  const { t } = useTranslation();
  const {
    plugins,
    loading,
    refresh,
    installPlugin,
    grantAllAndEnable,
    uninstallPlugin,
    setEnabled,
    togglePermission,
  } = usePluginList();
  const [pendingGrant, setPendingGrant] = React.useState<PluginView | null>(null);
  // 插件出站代理（issue #17）：宿主显式配置，供 plugin_http 使用（不继承宿主系统代理）。
  const pluginProxyEnabled = useAppStore((s) => s.config.pluginProxyEnabled);
  const pluginProxy = useAppStore((s) => s.config.pluginProxy);
  const setConfig = useAppStore((s) => s.setConfig);
  const handleInstall = async (source: 'directory' | 'zip'): Promise<void> => {
    try {
      const selected = source === 'directory'
        ? await open({ directory: true, multiple: false, title: t('plugins.installDirectory') })
        : await open({ multiple: false, filters: [{ name: 'Plugin archive', extensions: ['zip'] }], title: t('plugins.installZip') });
      if (typeof selected !== 'string') return;
      const installed = await installPlugin(selected);
      if (installed) setPendingGrant(installed);
    } catch (error) {
      console.debug('[PluginSettings] install failed:', error);
    }
  };


  /** 启用时提示当前可授予的敏感权限；未实现能力不列入风险确认。 */
  const handleToggleEnabled = (plugin: { id: string; installGeneration: string; name: string | null; declaredPermissions: string[]; enabled: boolean }): void => {
    if (!plugin.enabled) {
      const sensitive = plugin.declaredPermissions.filter((p) => SENSITIVE_PERMISSIONS.includes(p));
      if (sensitive.length > 0 && !window.confirm(t('plugins.sensitiveConfirm', { name: plugin.name ?? plugin.id, perms: sensitive.join(', ') }))) {
        return;
      }
    }
    void setEnabled(plugin.id, !plugin.enabled, plugin.installGeneration);
  };

  return (
    <>
      <div className="plugin-settings">
      <div className="settings-section-header">
        <h3>{t('plugins.title')}</h3>
        <div className="plugin-settings-actions">
          <button className="btn btn-sm" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw size={14} /> {t('plugins.refresh')}
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => void handleInstall('directory')} disabled={loading}>
            <FolderOpen size={14} /> {t('plugins.installDirectory')}
          </button>
          <button className="btn btn-sm" onClick={() => void handleInstall('zip')} disabled={loading}>
            <FolderOpen size={14} /> {t('plugins.installZip')}
          </button>
        </div>
      </div>

      <p className="settings-hint">{t('plugins.description')}</p>

      <div className="divider-h" />
      <h4 className="config-section-title">{t('plugins.proxy.sectionTitle')}</h4>

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
            className="input"
            value={pluginProxy}
            placeholder={t('plugins.proxy.urlPlaceholder')}
            onChange={(e) => setConfig({ pluginProxy: e.target.value })}
          />
        </div>
      )}
      <p className="settings-hint">{t('plugins.proxy.hint')}</p>

      {plugins.length === 0 ? (
        <div className="plugin-empty">
          <Plug size={32} />
          <p>{t('plugins.emptyText')}</p>
          <p className="settings-hint">{t('plugins.installHint')}</p>
        </div>
      ) : (
        <div className="plugin-list">
          {plugins.map((plugin) => {
            const declared = (plugin.manifest?.permissions ?? [])
              .filter((permission) => plugin.knownPermissions.includes(permission));
            const granted = plugin.grantedPermissions;
            return (
              <div key={plugin.id} className={`plugin-card ${plugin.manifestError ? 'plugin-card-error' : ''}`}>
                <div className="plugin-card-header">
                  <div className="plugin-card-title">
                    <strong>{plugin.manifest?.name ?? plugin.id}</strong>
                    {plugin.manifest && (
                      <span className="plugin-card-version">
                        {t('plugins.version', { version: plugin.manifest.version })} ·{' '}
                        {t('plugins.apiVersion', { version: plugin.manifest.apiVersion })}
                      </span>
                    )}
                  </div>
                  <div className="plugin-card-controls">
                    <button
                      className={`btn btn-sm${plugin.enabled ? ' active' : ''}`}
                      onClick={() =>
                        handleToggleEnabled({
                          id: plugin.id,
                          installGeneration: plugin.installGeneration,
                          name: plugin.manifest?.name ?? null,
                          declaredPermissions: declared,
                          enabled: plugin.enabled,
                        })
                      }
                      disabled={loading || !!plugin.manifestError}
                    >
                      <Power size={13} /> {plugin.enabled ? t('plugins.disable') : t('plugins.enable')}
                    </button>
                    <button
                      className="btn btn-danger btn-sm"
                      disabled={loading}
                      onClick={() => {
                        if (window.confirm(t('plugins.uninstallConfirm', { name: plugin.manifest?.name ?? plugin.id }))) {
                          void uninstallPlugin(plugin.id);
                        }
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

                    {/* 权限授予区 */}
                    <div className="plugin-perms">
                      <div className="plugin-perms-header">
                        <strong>{t('plugins.permissions')}</strong>
                        <span className="settings-hint">{t('plugins.permissionsHint')}</span>
                      </div>
                      {declared.length === 0 ? (
                        <p className="settings-hint">{t('plugins.noPermissions')}</p>
                      ) : (
                        <div className="plugin-perm-grid">
                          {declared.map((perm) => (
                            <label key={perm} className="plugin-perm-item">
                              <input
                                type="checkbox"
                                checked={granted.includes(perm)}
                                disabled={loading || !!plugin.manifestError}
                                onChange={() => void togglePermission(plugin.id, perm, plugin.installGeneration)}
                              />
                              <code>{perm}</code>
                              <span className="plugin-perm-state">
                                {granted.includes(perm) ? (
                                  <Check size={12} className="granted" />
                                ) : (
                                  <X size={12} className="not-granted" />
                                )}
                              </span>
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
      </div>
    {pendingGrant && (
      <div className="modal-overlay" onClick={() => setPendingGrant(null)}>
        <div className="modal-dialog-compact plugin-permission-dialog animate-slide-up" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
          <h3 className="modal-dialog-title">{t('plugins.permissionPromptTitle', { name: pendingGrant.manifest?.name ?? pendingGrant.id })}</h3>
          <p className="settings-hint">{t('plugins.permissionPromptDescription')}</p>
          {pendingGrant.declaredPermissions.length > 0 ? (
            <div className="plugin-permission-dialog-list">
              {pendingGrant.declaredPermissions.filter(permission => pendingGrant.knownPermissions.includes(permission)).map(permission => (
                <code key={permission}>{permission}</code>
              ))}
            </div>
          ) : <p className="settings-hint">{t('plugins.noPermissions')}</p>}
          <div className="plugin-permission-dialog-actions">
            <button className="btn" onClick={() => setPendingGrant(null)}>{t('plugins.permissionPromptLater')}</button>
            <button className="btn btn-primary" disabled={loading} onClick={() => {
              void grantAllAndEnable(pendingGrant).then(() => setPendingGrant(null)).catch(() => {});
            }}>{t('plugins.permissionPromptGrantAll')}</button>
          </div>
        </div>
      </div>
    )}
    </>
  );
};

export default PluginSettings;
