import React from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../../stores/useAppStore';
import { open, save } from '@tauri-apps/plugin-dialog';
import { storageService, configService, fileService } from '../../../services/tauri';
import type { AppConfig, HighlightRuleSet, SendCommandSet, ProtocolTemplate } from '../../../types';
import { notifyError, notifySuccess } from '../../../stores/useToastStore';

/** 配置 bundle 标记，导入时校验文件来源 */
const BUNDLE_APP = 'hypercom';
const BUNDLE_VERSION = 1;

/** Clamp a numeric input to [min, max], falling back to min on NaN (e.g. a cleared field). */
const clampNumber = (raw: string, min: number, max: number): number => {
  const value = Number(raw);
  return Number.isNaN(value) ? min : Math.max(min, Math.min(max, value));
};

/** 配置导出 bundle 结构（config + 三类规则集） */
interface ConfigBundle {
  app?: string;
  version?: number;
  exportedAt?: string;
  config?: AppConfig;
  highlightSets?: HighlightRuleSet[];
  commandSets?: SendCommandSet[];
  protocolTemplates?: ProtocolTemplate[];
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
      const currentConfig = useAppStore.getState().config;
      const [highlightSets, commandSets, protocolTemplates] = await Promise.all([
        storageService.loadHighlightSets(),
        storageService.loadCommandSets(),
        storageService.loadProtocolTemplates(),
      ]);
      const bundle: ConfigBundle = {
        app: BUNDLE_APP,
        version: BUNDLE_VERSION,
        exportedAt: new Date().toISOString(),
        config: currentConfig,
        highlightSets,
        commandSets,
        protocolTemplates,
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
      if (bundle.config) {
        await configService.setConfig(bundle.config);
        useAppStore.getState().setConfig(bundle.config);
      }
      for (const set of bundle.highlightSets ?? []) {
        await storageService.saveHighlightSet(set);
      }
      for (const set of bundle.commandSets ?? []) {
        await storageService.saveCommandSet(set);
      }
      for (const tpl of bundle.protocolTemplates ?? []) {
        await storageService.saveProtocolTemplate(tpl);
      }
      notifySuccess('backupSettings.importSuccess');
      // 延时重载，让所有 store 与组件重新加载导入的数据
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
