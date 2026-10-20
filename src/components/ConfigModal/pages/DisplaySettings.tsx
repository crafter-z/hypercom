import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { open } from '@tauri-apps/plugin-dialog';
import { useAppStore } from '../../../stores/useAppStore';
import type { AppConfig } from '../../../types';
import { CONFIG_BOUNDS } from '../../../utils/bounds';
import { NumericInput } from '../../shared/NumericInput';
import { LINE_ENDING_VALUES, lineEndingLabelKey } from '../../../utils/sendUtils';

const DisplaySettings: React.FC = () => {
  const { t } = useTranslation();
  const defaultBaudRates = useAppStore(s => s.config.defaultBaudRates);
  const showPortType = useAppStore(s => s.config.showPortType);
  const defaultLineEnding = useAppStore(s => s.config.defaultLineEnding);
  const sendPrefix = useAppStore(s => s.config.sendPrefix);
  const timestampMode = useAppStore(s => s.config.timestampMode);
  const timestampFormat = useAppStore(s => s.config.timestampFormat);
  const backgroundImage = useAppStore(s => s.config.backgroundImage);
  const backgroundImageEnabled = useAppStore(s => s.config.backgroundImageEnabled);
  const backgroundImageOpacity = useAppStore(s => s.config.backgroundImageOpacity);
  const backgroundImageBlur = useAppStore(s => s.config.backgroundImageBlur);
  const setConfig = useAppStore((s) => s.setConfig);

  // Raw text draft: committing on every keystroke turned a typed comma into
  // `[9600, NaN] → [9600]`, rewriting the field and deleting the separator.
  // Parse/commit on blur or Enter; mirror external (loaded) changes back.
  const [baudDraft, setBaudDraft] = useState(defaultBaudRates.join(','));
  useEffect(() => {
    setBaudDraft(defaultBaudRates.join(','));
  }, [defaultBaudRates]);
  const commitBaudDraft = () => {
    const rates = baudDraft
      .split(',')
      .map((part) => Number(part.trim()))
      .filter((rate) => Number.isFinite(rate) && rate > 0)
      .map((rate) => Math.round(rate));
    setConfig({ defaultBaudRates: rates });
    setBaudDraft(rates.join(','));
  };

  const handleBrowseImage = async () => {
    const result = await open({
      multiple: false,
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'webp', 'gif'] }],
    }).catch((e) => { console.debug('[DisplaySettings] image dialog failed:', e); return null; });
    if (result && typeof result === 'string') setConfig({ backgroundImage: result });
  };

  return (
    <div className="config-page">
      <h3 className="config-page-title">{t('displaySettings.title')}</h3>

      <div className="config-row">
        <label>{t('displaySettings.defaultBaudRatesLabel')}</label>
        <input
          className="input"
          value={baudDraft}
          onChange={(e) => setBaudDraft(e.target.value)}
          onBlur={commitBaudDraft}
          onKeyDown={(e) => { if (e.key === 'Enter') commitBaudDraft(); }}
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
          {LINE_ENDING_VALUES.map((value) => (
            <option key={value} value={value}>{t(lineEndingLabelKey(value, 'sendSection'))}</option>
          ))}
        </select>
      </div>

      <div className="config-row">
        <label>{t('displaySettings.sendPrefixLabel')}</label>
        <input className="input" value={sendPrefix} onChange={(e) => setConfig({ sendPrefix: e.target.value })} />
      </div>

      <div className="divider-h" />
      <h4 className="config-section-title">{t('displaySettings.background.sectionTitle')}</h4>

      <label className="checkbox-wrapper">
        <input type="checkbox" checked={backgroundImageEnabled} onChange={(e) => setConfig({ backgroundImageEnabled: e.target.checked })} />
        {t('displaySettings.background.enable')}
      </label>

      {backgroundImageEnabled && (
        <>
          <div className="config-row">
            <label>{t('displaySettings.background.pathLabel')}</label>
            <input
              className="input"
              value={backgroundImage}
              placeholder={t('displaySettings.background.pathPlaceholder')}
              readOnly
              style={{ flex: 1 }}
            />
            <button className="btn btn-sm" onClick={handleBrowseImage}>{t('displaySettings.background.browseButton')}</button>
          </div>

          <div className="config-row">
            <label>{t('displaySettings.background.opacityLabel')}</label>
            <NumericInput
              className="input"
              value={backgroundImageOpacity}
              onCommit={(value) => setConfig({ backgroundImageOpacity: value })}
              min={CONFIG_BOUNDS.backgroundImageOpacity[0]} max={CONFIG_BOUNDS.backgroundImageOpacity[1]} step={1}
              style={{ width: 80 }}
            />
            <span>%</span>
          </div>

          <div className="config-row">
            <label>{t('displaySettings.background.blurLabel')}</label>
            <NumericInput
              className="input"
              value={backgroundImageBlur}
              onCommit={(value) => setConfig({ backgroundImageBlur: value })}
              min={CONFIG_BOUNDS.backgroundImageBlur[0]} max={CONFIG_BOUNDS.backgroundImageBlur[1]} step={1}
              style={{ width: 80 }}
            />
            <span>px</span>
          </div>
        </>
      )}

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
