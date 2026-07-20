import React from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../../stores/useAppStore';
import { open } from '@tauri-apps/plugin-dialog';
import type { AppConfig } from '../../../types';

const LogSettings: React.FC = () => {
  const { t } = useTranslation();
  const config = useAppStore((s) => s.config);
  const setConfig = useAppStore((s) => s.setConfig);

  return (
    <div className="config-page">
      <h3 className="config-page-title">{t('logSettings.title')}</h3>

      <label className="checkbox-wrapper">
        <input type="checkbox" checked={config.autoSaveLog} onChange={(e) => setConfig({ autoSaveLog: e.target.checked })} />
        {t('logSettings.autoSaveLog')}
      </label>

      <div className="config-row">
        <label>{t('logSettings.directoryLabel')}</label>
        <input className="input" value={config.logDirectory} placeholder={t('logSettings.directoryPlaceholder')} readOnly />
        <button className="btn btn-sm" onClick={async () => {
          const result = await open({ directory: true });
          if (result) setConfig({ logDirectory: result });
        }}>{t('logSettings.browseButton')}</button>
      </div>

      <div className="config-row">
        <label>{t('logSettings.filenameFormatLabel')}</label>
        <input className="input" value={config.logFilenameFormat} onChange={(e) => setConfig({ logFilenameFormat: e.target.value })} />
        <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{t('logSettings.filenameFormatHint')}</span>
      </div>

      <div className="config-row">
        <label>{t('logSettings.formatLabel')}</label>
        <select className="select" value={config.logFormat} onChange={(e) => setConfig({ logFormat: e.target.value as AppConfig['logFormat'] })}>
          <option value="string">{t('logSettings.format.string')}</option>
          <option value="hex">{t('logSettings.format.hex')}</option>
          <option value="binary">{t('logSettings.format.binary')}</option>
        </select>
      </div>

      <div className="config-row">
        <label>{t('logSettings.encodingLabel')}</label>
        <select className="select" value={config.logEncoding} onChange={(e) => setConfig({ logEncoding: e.target.value as AppConfig['logEncoding'] })}>
          <option value="ASCII">ASCII</option>
          <option value="UTF-8">UTF-8</option>
        </select>
      </div>

      <label className="checkbox-wrapper">
        <input type="checkbox" checked={config.logSplitEnabled} onChange={(e) => setConfig({ logSplitEnabled: e.target.checked })} />
        {t('logSettings.splitEnabled')}
      </label>

      {config.logSplitEnabled && (
        <div className="config-row">
          <label>{t('logSettings.splitSizeLabel')}</label>
          <input className="input" type="number" value={config.logSplitSizeMb} onChange={(e) => setConfig({ logSplitSizeMb: Number(e.target.value) })} min={1} />
        </div>
      )}
    </div>
  );
};

export default LogSettings;
