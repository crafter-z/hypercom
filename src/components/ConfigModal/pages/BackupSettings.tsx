import React from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../../stores/useAppStore';
import { open, confirm } from '@tauri-apps/plugin-dialog';
import { configService, fileService, pluginService } from '../../../services/tauri';
import type { AppConfig } from '../../../types';
import { notifyError, notifySuccess } from '../../../stores/useToastStore';
import { CONFIG_BOUNDS } from '../../../utils/bounds';
import { NumericInput } from '../../shared/NumericInput';
import { syncPluginListSnapshot } from '../../../utils/pluginConfigSnapshot';
import { requestEditorLeave } from '../../../utils/editorLeave';
import { adoptEntityEditorBaselineFromConfig } from '../../../utils/entityEditor';
import { markOrdinaryConfigSaved } from '../../../hooks/useConfigPersistence';

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
    if (typeof c.maxDisplayLines !== 'number') return 'Invalid config: maxDisplayLines must be a number';
    if (typeof c.theme !== 'string') return 'Invalid config: theme must be a string';
    if (typeof c.language !== 'string') return 'Invalid config: language must be a string';
    if (c.terminalFontSize !== undefined && typeof c.terminalFontSize !== 'number') return 'Invalid config: terminalFontSize must be a number';
    if (c.uiScalePercent !== undefined && typeof c.uiScalePercent !== 'number') return 'Invalid config: uiScalePercent must be a number';
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
      // Export committed backend state, never unfinished editor drafts.
      const currentConfig = await configService.getConfig();
      const bundle: ConfigBundle = {
        app: BUNDLE_APP,
        version: BUNDLE_VERSION,
        exportedAt: new Date().toISOString(),
        config: currentConfig,
      };
      const saved = await fileService.pickTextFileAndWrite(JSON.stringify(bundle, null, 2), {
        defaultFileName: `hypercom-config-${new Date().toISOString().slice(0, 10)}.json`,
        filters: [{ name: 'HyperCom Config', extensions: ['json'] }],
      });
      if (saved === null) return;
      notifySuccess('backupSettings.exportSuccess');
    } catch (e) {
      notifyError(e);
    }
  };

  const handleImport = async () => {
    try {
      const content = await fileService.pickTextFileAndRead({
        filters: [{ name: 'HyperCom Config', extensions: ['json'] }],
      });
      if (content === null) return;
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
      if (!(await confirm(t('backupSettings.importConfirm'), { title: t('backupSettings.importButton'), kind: 'warning' }))) return;
      if (!(await requestEditorLeave())) return;
      // Only the backend can decide whether backed-up grants still name installed code.
      await configService.setConfig(bundle.config, true);
      const restored = await configService.getConfig();
      const current = useAppStore.getState().config;
      useAppStore.getState().setConfig({ ...restored, revision: Math.max(restored.revision ?? 0, current.revision ?? 0), pluginConfigs: current.pluginConfigs });
      adoptEntityEditorBaselineFromConfig(restored);
      markOrdinaryConfigSaved(useAppStore.getState().config);
      syncPluginListSnapshot(await pluginService.listPlugins());
      notifySuccess('backupSettings.importSuccess');
      // Reload immediately: a delayed reload would leave a window for new edits.
      window.location.reload();
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
            <NumericInput className="input" value={backupInterval} onCommit={(value) => setConfig({ backupInterval: value })} min={CONFIG_BOUNDS.backupInterval[0]} max={CONFIG_BOUNDS.backupInterval[1]} step={1} />
          </div>
          <div className="config-row">
            <label>{t('backupSettings.directoryLabel')}</label>
            <input className="input" value={backupDirectory} placeholder={t('backupSettings.directoryPlaceholder')} readOnly />
            <button className="btn btn-sm" onClick={async () => {
              const result = await open({ directory: true }).catch((e) => { console.debug('[BackupSettings] directory dialog failed:', e); return null; });
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
