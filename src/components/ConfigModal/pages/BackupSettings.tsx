import React from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../../stores/useAppStore';
import { open } from '@tauri-apps/plugin-dialog';

const BackupSettings: React.FC = () => {
  const { t } = useTranslation();
  const config = useAppStore((s) => s.config);
  const setConfig = useAppStore((s) => s.setConfig);

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
            <input className="input" type="number" value={config.backupInterval} onChange={(e) => setConfig({ backupInterval: Number(e.target.value) })} min={1} />
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
    </div>
  );
};

export default BackupSettings;
