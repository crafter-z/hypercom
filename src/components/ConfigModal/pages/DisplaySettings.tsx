import React from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../../stores/useAppStore';
import type { AppConfig } from '../../../types';

const DisplaySettings: React.FC = () => {
  const { t } = useTranslation();
  const defaultBaudRates = useAppStore(s => s.config.defaultBaudRates);
  const showPortType = useAppStore(s => s.config.showPortType);
  const defaultLineEnding = useAppStore(s => s.config.defaultLineEnding);
  const sendPrefix = useAppStore(s => s.config.sendPrefix);
  const timestampMode = useAppStore(s => s.config.timestampMode);
  const timestampFormat = useAppStore(s => s.config.timestampFormat);
  const setConfig = useAppStore((s) => s.setConfig);

  return (
    <div className="config-page">
      <h3 className="config-page-title">{t('displaySettings.title')}</h3>

      <div className="config-row">
        <label>{t('displaySettings.defaultBaudRatesLabel')}</label>
        <input
          className="input"
          value={defaultBaudRates.join(', ')}
          onChange={(e) => setConfig({ defaultBaudRates: e.target.value.split(',').map(s => Number(s.trim())).filter(Boolean) })}
          style={{ flex: 1 }}
        />
      </div>

      <label className="checkbox-wrapper">
        <input type="checkbox" checked={showPortType} onChange={(e) => setConfig({ showPortType: e.target.checked })} />
        {t('displaySettings.showPortType')}
      </label>

      <div className="config-row">
        <label>{t('displaySettings.defaultLineEndingLabel')}</label>
        <select className="select" value={defaultLineEnding} onChange={(e) => setConfig({ defaultLineEnding: e.target.value as AppConfig['defaultLineEnding'] })}>
          <option value="\\r\\n">{t('displaySettings.lineEnding.crlf')}</option>
          <option value="\\r">{t('displaySettings.lineEnding.cr')}</option>
          <option value="\\n">{t('displaySettings.lineEnding.lf')}</option>
        </select>
      </div>

      <div className="config-row">
        <label>{t('displaySettings.sendPrefixLabel')}</label>
        <input className="input" value={sendPrefix} onChange={(e) => setConfig({ sendPrefix: e.target.value })} />
      </div>

      <div className="config-row">
        <label>{t('displaySettings.timestampModeLabel')}</label>
        <select className="select" value={timestampMode} onChange={(e) => setConfig({ timestampMode: e.target.value as AppConfig['timestampMode'] })}>
          <option value="perLine">{t('displaySettings.timestampMode.perLine')}</option>
          <option value="perRound">{t('displaySettings.timestampMode.perRound')}</option>
        </select>
      </div>

      <div className="config-row">
        <label>{t('displaySettings.timestampFormat.label')}</label>
        <select className="select" value={timestampFormat} onChange={(e) => setConfig({ timestampFormat: e.target.value as AppConfig['timestampFormat'] })}>
          <option value="absolute">{t('displaySettings.timestampFormat.absolute')}</option>
          <option value="relative">{t('displaySettings.timestampFormat.relative')}</option>
          <option value="uptime">{t('displaySettings.timestampFormat.uptime')}</option>
        </select>
      </div>
    </div>
  );
};

export default DisplaySettings;
