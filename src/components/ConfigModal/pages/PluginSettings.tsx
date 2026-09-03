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

const PluginSettings: React.FC = () => {
  const { t } = useTranslation();
  const {
    plugins,
    loading,
    refresh,
    installPlugin,
    uninstallPlugin,
    setEnabled,
    grantPermissions,
  } = usePluginList();
  /** 安装：先选目录，再允许选 zip（dialog 过滤器）。 */
  const handleInstall = async (): Promise<void> => {
    try {
      // 目录选择（插件目录含 manifest.json）
      const dir = await open({ directory: true, multiple: false, title: 'Select plugin directory' });
      if (typeof dir === 'string') {
        await installPlugin(dir);
        return;
      }
      // zip 选择
      const file = await open({
        multiple: false,
        filters: [{ name: 'Plugin archive', extensions: ['zip'] }],
        title: 'Select plugin .zip',
      });
      if (typeof file === 'string') {
        await installPlugin(file);
      }
    } catch (e) {
      // usePlugins 已 notifyError；此处吞掉用户取消（dialog 返回 null 正常流）。
      console.debug('[PluginSettings] install dialog cancelled or failed:', e);
    }
  };

  /** 权限勾选切换：整体替换 grantedPermissions。 */
  const handleTogglePermission = async (pluginId: string, perm: string, granted: string[]): Promise<void> => {
    const next = granted.includes(perm)
      ? granted.filter((p) => p !== perm)
      : [...granted, perm];
    await grantPermissions(pluginId, next);
  };

  return (
    <div className="plugin-settings">
      <div className="settings-section-header">
        <h3>{t('plugins.title')}</h3>
        <div className="plugin-settings-actions">
          <button className="btn-secondary" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw size={14} /> {t('configModal.nav.plugins')}
          </button>
          <button className="btn-primary" onClick={() => void handleInstall()} disabled={loading}>
            <FolderOpen size={14} /> {t('plugins.installButton')}
          </button>
        </div>
      </div>

      <p className="settings-hint">{t('plugins.description')}</p>

      {plugins.length === 0 ? (
        <div className="plugin-empty">
          <Plug size={32} />
          <p>{t('plugins.emptyText')}</p>
          <p className="settings-hint">{t('plugins.installHint')}</p>
        </div>
      ) : (
        <div className="plugin-list">
          {plugins.map((plugin) => {
            const declared = plugin.manifest?.permissions ?? [];
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
                      className={plugin.enabled ? 'btn-toggle-on' : 'btn-toggle'}
                      onClick={() => void setEnabled(plugin.id, !plugin.enabled)}
                      disabled={!!plugin.manifestError}
                    >
                      <Power size={13} /> {plugin.enabled ? t('plugins.disable') : t('plugins.enable')}
                    </button>
                    <button
                      className="btn-danger-ghost"
                      onClick={() => {
                        if (window.confirm(`Uninstall plugin ${plugin.manifest?.name ?? plugin.id}?`)) {
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
                                disabled={!plugin.enabled}
                                onChange={() => void handleTogglePermission(plugin.id, perm, granted)}
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
  );
};

export default PluginSettings;
