import React from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../../stores/useAppStore';
import { confirm } from '@tauri-apps/plugin-dialog';
import { configService, fileService, pluginService } from '../../../services/tauri';
import type { AppConfig } from '../../../types';
import { notifyError, notifySuccess } from '../../../stores/useToastStore';
import { syncPluginListSnapshot } from '../../../utils/pluginConfigSnapshot';
import { requestEditorLeave } from '../../../utils/editorLeave';
import { adoptEntityEditorBaselineFromConfig } from '../../../utils/entityEditor';
import { markOrdinaryConfigSaved } from '../../../hooks/useConfigPersistence';
import { enqueueConfigWrite } from '../../../utils/configWriteQueue';

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
  const importInFlight = React.useRef(false);
  const [importing, setImporting] = React.useState(false);

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
    if (importInFlight.current) return;
    importInFlight.current = true;
    setImporting(true);
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
      const imported = bundle.config;
      // Import is a destructive write, but it still owns the same serialized
      // lane as ordinary/entity/metadata saves. Never publish before its ACK.
      await enqueueConfigWrite(async () => {
        // Only the backend can decide whether grants still name installed code.
        if (!await configService.setConfig(imported, true)) throw new Error(t('editor.saveFailed'));
        const restored = await configService.getConfig();
        const current = useAppStore.getState().config;
        useAppStore.getState().setConfig({ ...restored, revision: Math.max(restored.revision ?? 0, current.revision ?? 0), pluginConfigs: current.pluginConfigs });
        adoptEntityEditorBaselineFromConfig(restored);
        markOrdinaryConfigSaved(useAppStore.getState().config);
        syncPluginListSnapshot(await pluginService.listPlugins());
        notifySuccess('backupSettings.importSuccess');
        // Reload immediately: a delayed reload would leave a window for new edits.
        window.location.reload();
      });
    } catch (e) {
      notifyError(e);
    } finally {
      importInFlight.current = false;
      setImporting(false);
    }
  };

  return (
    <div className="config-page">
      <p className="config-page-summary">{t('backupSettings.exportImportHint')}</p>
      <div className="backup-actions-grid">
        <section className="backup-action-card" aria-labelledby="backup-export-title">
          <h3 id="backup-export-title" className="config-section-title">{t('backupSettings.exportTitle')}</h3>
          <p className="config-field-hint">{t('backupSettings.exportHint')}</p>
          <button className="btn btn-sm btn-primary" disabled={importing} onClick={handleExport}>{t('backupSettings.exportButton')}</button>
        </section>
        <section className="backup-action-card backup-action-card-warning" aria-labelledby="backup-import-title">
          <h3 id="backup-import-title" className="config-section-title">{t('backupSettings.importTitle')}</h3>
          <p className="config-field-hint">{t('backupSettings.importHint')}</p>
          <p className="config-field-warning">{t('backupSettings.importRisk')}</p>
          <button className="btn btn-sm btn-danger" disabled={importing} onClick={handleImport}>{t('backupSettings.importButton')}</button>
        </section>
      </div>
    </div>
  );
};

export default BackupSettings;
