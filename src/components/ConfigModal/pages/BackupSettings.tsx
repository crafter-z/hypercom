import React from 'react';
import { useTranslation } from 'react-i18next';
import { RotateCcw } from 'lucide-react';
import { useAppStore } from '../../../stores/useAppStore';
import { confirm } from '@tauri-apps/plugin-dialog';
import { configService, fileService, pluginService } from '../../../services/tauri';
import type { AppConfig } from '../../../types';
import { notifyError, notifySuccess } from '../../../stores/useToastStore';
import { syncPluginListSnapshot } from '../../../utils/pluginConfigSnapshot';
import { requestEditorLeave } from '../../../utils/editorLeave';
import { adoptEntityEditorBaselineFromConfig } from '../../../utils/entityEditor';
import { getOrdinaryConfigDefaults, markOrdinaryConfigSaved, useConfigPersistence } from '../../../hooks/useConfigPersistence';
import { enqueueConfigWrite } from '../../../utils/configWriteQueue';
import { applyUiScale } from '../../../utils/uiScale';
import ConfirmDialog from '../../shared/ConfirmDialog';

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

/** Validate an imported config bundle's config section. Returns localized error message or null if valid. */
function validateConfigBundle(
  bundle: ConfigBundle,
  t: (key: string, options?: Record<string, unknown>) => string,
): string | null {
  if (!bundle || typeof bundle !== 'object') return t('backupSettings.validation.invalidBundle');
  if (bundle.config) {
    const c = bundle.config;
    if (typeof c.maxDisplayLines !== 'number') return t('backupSettings.validation.invalidField', { field: 'maxDisplayLines', type: 'number' });
    if (typeof c.theme !== 'string') return t('backupSettings.validation.invalidField', { field: 'theme', type: 'string' });
    if (typeof c.language !== 'string') return t('backupSettings.validation.invalidField', { field: 'language', type: 'string' });
    if (c.terminalFontSize !== undefined && typeof c.terminalFontSize !== 'number') return t('backupSettings.validation.invalidField', { field: 'terminalFontSize', type: 'number' });
    if (c.uiScalePercent !== undefined && typeof c.uiScalePercent !== 'number') return t('backupSettings.validation.invalidField', { field: 'uiScalePercent', type: 'number' });
    if (c.autoSaveLog !== undefined && typeof c.autoSaveLog !== 'boolean') return t('backupSettings.validation.invalidField', { field: 'autoSaveLog', type: 'boolean' });
  }
  return null;
}

const BackupSettings: React.FC = () => {
  const { t } = useTranslation();
  const { saveConfig } = useConfigPersistence();
  const importInFlight = React.useRef(false);
  const [importing, setImporting] = React.useState(false);
  const [confirmReset, setConfirmReset] = React.useState(false);
  const [resetting, setResetting] = React.useState(false);
  const busy = importing || resetting;

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
      const validationError = validateConfigBundle(bundle, t);
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

  const handleResetAll = async () => {
    setConfirmReset(false);
    setResetting(true);
    try {
      const defaults = getOrdinaryConfigDefaults();
      if (!(await saveConfig(defaults, true))) return;
      useAppStore.getState().setConfig(defaults);
      if (typeof defaults.uiScalePercent === 'number') {
        void applyUiScale(defaults.uiScalePercent);
      }
      notifySuccess('backupSettings.resetSuccess');
    } catch (e) {
      notifyError(e);
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="config-page">
      <p className="config-page-summary">{t('backupSettings.exportImportHint')}</p>
      <div className="backup-actions-grid">
        <section className="backup-action-card" aria-labelledby="backup-export-title">
          <h3 id="backup-export-title" className="config-section-title">{t('backupSettings.exportTitle')}</h3>
          <p className="config-field-hint">{t('backupSettings.exportHint')}</p>
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={handleExport}>{t('backupSettings.exportButton')}</button>
        </section>
        <section className="backup-action-card backup-action-card-warning" aria-labelledby="backup-import-title">
          <h3 id="backup-import-title" className="config-section-title">{t('backupSettings.importTitle')}</h3>
          <p className="config-field-hint">{t('backupSettings.importHint')}</p>
          <p className="config-field-warning">{t('backupSettings.importRisk')}</p>
          <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={handleImport}>{t('backupSettings.importButton')}</button>
        </section>
      </div>
      <section className="backup-action-card backup-action-card-danger" aria-labelledby="backup-reset-title">
        <h3 id="backup-reset-title" className="config-section-title">{t('backupSettings.resetTitle')}</h3>
        <p className="config-field-hint">{t('backupSettings.resetHint')}</p>
        <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => setConfirmReset(true)}>
          <RotateCcw size={13} aria-hidden="true" />
          {t('backupSettings.resetButton')}
        </button>
      </section>
      <ConfirmDialog
        open={confirmReset}
        title={t('backupSettings.resetConfirmTitle')}
        message={t('backupSettings.resetConfirmMessage')}
        confirmLabel={t('backupSettings.resetButton')}
        cancelLabel={t('confirmDialog.cancel')}
        danger
        onConfirm={() => { void handleResetAll(); }}
        onCancel={() => setConfirmReset(false)}
      />
    </div>
  );
};

export default BackupSettings;
