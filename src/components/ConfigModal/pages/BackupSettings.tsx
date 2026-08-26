import React from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../../stores/useAppStore';
import { open, save } from '@tauri-apps/plugin-dialog';
import { configService, fileService } from '../../../services/tauri';
import type { AppConfig } from '../../../types';
import { notifyError, notifySuccess } from '../../../stores/useToastStore';
import { clampNumber } from '../../../utils/clampNumber';

/** 配置 bundle 标记，导入时校验文件来源 */
const BUNDLE_APP = 'hypercom';
const BUNDLE_VERSION = 2;

/**
 * 配置导出 bundle 结构。
 * v2（config.json 单一数据源后）：全部设置实体已内嵌于 AppConfig，
 * 因此 bundle 只需包裹一份完整 config，不再有顶层冗余实体数组。
 */
interface ConfigBundle {
  app?: string;
  version?: number;
  exportedAt?: string;
  config?: AppConfig;
}

/** Validate an imported config bundle's config section. Returns error message or null if valid. */
function validateConfigBundle(bundle: ConfigBundle): string | null {
  if (!bundle || typeof bundle !== 'object') return 'Invalid bundle format';
  if (bundle.config) {
    const c = bundle.config;
    if (typeof c.memoryLimitMb !== 'number') return 'Invalid config: memoryLimitMb must be a number';
    if (typeof c.theme !== 'string') return 'Invalid config: theme must be a string';
    if (typeof c.language !== 'string') return 'Invalid config: language must be a string';
    if (c.terminalFontSize !== undefined && typeof c.terminalFontSize !== 'number') return 'Invalid config: terminalFontSize must be a number';
    if (c.autoSaveLog !== undefined && typeof c.autoSaveLog !== 'boolean') return 'Invalid config: autoSaveLog must be a boolean';
  }
  return null;
}

const BackupSettings: React.FC = () => {
  const { t } = useTranslation();
  const backupEnabled = useAppStore(s => s.config.backupEnabled);
  const backupInterval = useAppStore(s => s.config.backupInterval);
  const backupDirectory = useAppStore(s => s.config.backupDirectory);
  const setConfig = useAppStore((s) => s.setConfig);

  const handleExport = async () => {
    try {
      // 从后端读取最新配置（config.json 是唯一数据源）。不能用前端 store 的
      // config——设置页的规则 CRUD 只更新 useRuleStore + 后端 config.json，
      // 不回写 store.config，直接读 store 会导出陈旧的实体数组。
      const currentConfig = await configService.getConfig();
      const bundle: ConfigBundle = {
        app: BUNDLE_APP,
        version: BUNDLE_VERSION,
        exportedAt: new Date().toISOString(),
        config: currentConfig,
      };
      const path = await save({
        defaultPath: `hypercom-config-${new Date().toISOString().slice(0, 10)}.json`,
        filters: [{ name: 'HyperCom Config', extensions: ['json'] }],
      });
      if (!path) return;
      await fileService.writeTextFile(path, JSON.stringify(bundle, null, 2));
      notifySuccess('backupSettings.exportSuccess');
    } catch (e) {
      notifyError(e);
    }
  };

  const handleImport = async () => {
    try {
      const path = await open({
        multiple: false,
        filters: [{ name: 'HyperCom Config', extensions: ['json'] }],
      });
      if (!path || typeof path !== 'string') return;
      const content = await fileService.readTextFile(path);
      const bundle = JSON.parse(content) as ConfigBundle;
      if (bundle.app !== BUNDLE_APP) {
        notifyError(new Error(t('backupSettings.importInvalid')));
        return;
      }
      const validationError = validateConfigBundle(bundle);
      if (validationError) {
        notifyError(new Error(validationError));
        return;
      }
      if (!bundle.config) {
        notifyError(new Error(t('backupSettings.importInvalid')));
        return;
      }
      // 全量写回 config.json（含全部设置实体），set_config 内部会校验收敛并同步 LogManager。
      await configService.setConfig(bundle.config);
      useAppStore.getState().setConfig(bundle.config);
      notifySuccess('backupSettings.importSuccess');
      // 重载让 useAppInit 从 config.json 重新加载实体到各 store。
      setTimeout(() => window.location.reload(), 1200);
    } catch (e) {
      notifyError(e);
    }
  };

  return (
    <div className="config-page">
      <h3 className="config-page-title">{t('backupSettings.title')}</h3>

      <label className="checkbox-wrapper">
        <input type="checkbox" checked={backupEnabled} onChange={(e) => setConfig({ backupEnabled: e.target.checked })} />
        {t('backupSettings.enabled')}
      </label>

      {backupEnabled && (
        <>
          <div className="config-row">
            <label>{t('backupSettings.intervalLabel')}</label>
            <input className="input" type="number" value={backupInterval} onChange={(e) => setConfig({ backupInterval: clampNumber(e.target.value, 1, 8760) })} min={1} max={8760} />
          </div>
          <div className="config-row">
            <label>{t('backupSettings.directoryLabel')}</label>
            <input className="input" value={backupDirectory} placeholder={t('backupSettings.directoryPlaceholder')} readOnly />
            <button className="btn btn-sm" onClick={async () => {
              const result = await open({ directory: true });
              if (result) setConfig({ backupDirectory: result });
            }}>{t('backupSettings.browseButton')}</button>
          </div>
        </>
      )}

      <h3 className="config-page-title" style={{ marginTop: 20 }}>{t('backupSettings.exportImportTitle')}</h3>
      <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '4px 0 12px' }}>
        {t('backupSettings.exportImportHint')}
      </p>
      <div className="config-row" style={{ gap: 8 }}>
        <button className="btn btn-sm" onClick={handleExport}>{t('backupSettings.exportButton')}</button>
        <button className="btn btn-sm" onClick={handleImport}>{t('backupSettings.importButton')}</button>
      </div>
    </div>
  );
};

export default BackupSettings;
