import React from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../../stores/useAppStore';
import { open, save } from '@tauri-apps/plugin-dialog';
import { storageService, configService, fileService } from '../../../services/tauri';
import type { HighlightSetInfo, CommandSetInfo, ProtocolTemplateInfo } from '../../../services/tauri';
import type { AppConfig } from '../../../types';
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
  highlightSets?: HighlightSetInfo[];
  commandSets?: CommandSetInfo[];
  protocolTemplates?: ProtocolTemplateInfo[];
}

const BackupSettings: React.FC = () => {
  const { t } = useTranslation();
  const config = useAppStore((s) => s.config);
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
      if (bundle.config) {
        await configService.setConfig(bundle.config);
      }
      for (const set of bundle.highlightSets ?? []) {
        await storageService.saveHighlightSet({
          id: set.id,
          name: set.name,
          is_enabled: set.is_enabled,
          rules: (set.rules ?? []).map((r) => ({
            id: r.id, name: r.name, pattern: r.pattern, is_regex: r.is_regex,
            color: r.color, bold: r.bold, italic: r.italic,
          })),
        });
      }
      for (const set of bundle.commandSets ?? []) {
        await storageService.saveCommandSet({
          id: set.id,
          name: set.name,
          is_loop: set.is_loop,
          loop_delay_ms: set.loop_delay_ms,
          commands: (set.commands ?? []).map((c) => ({
            id: c.id, name: c.name, order_idx: c.order_idx, delay_ms: c.delay_ms,
            cmd_type: c.cmd_type, content: c.content, append_line_ending: c.append_line_ending,
          })),
        });
      }
      for (const tpl of bundle.protocolTemplates ?? []) {
        await storageService.saveProtocolTemplate({
          id: tpl.id, name: tpl.name, is_enabled: tpl.is_enabled,
          header_bytes: tpl.header_bytes, length_field_offset: tpl.length_field_offset,
          length_field_size: tpl.length_field_size, length_endian: tpl.length_endian,
          length_adjust: tpl.length_adjust, checksum_algorithm: tpl.checksum_algorithm,
          checksum_offset: tpl.checksum_offset, footer_bytes: tpl.footer_bytes,
          color_header: tpl.color_header, color_length: tpl.color_length,
          color_payload: tpl.color_payload, color_checksum: tpl.color_checksum,
          color_footer: tpl.color_footer,
        });
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
        <input type="checkbox" checked={config.backupEnabled} onChange={(e) => setConfig({ backupEnabled: e.target.checked })} />
        {t('backupSettings.enabled')}
      </label>

      {config.backupEnabled && (
        <>
          <div className="config-row">
            <label>{t('backupSettings.intervalLabel')}</label>
            <input className="input" type="number" value={config.backupInterval} onChange={(e) => setConfig({ backupInterval: clampNumber(e.target.value, 1, 8760) })} min={1} max={8760} />
          </div>
          <div className="config-row">
            <label>{t('backupSettings.directoryLabel')}</label>
            <input className="input" value={config.backupDirectory} placeholder={t('backupSettings.directoryPlaceholder')} readOnly />
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
