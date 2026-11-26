import React, { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { open } from '@tauri-apps/plugin-dialog';
import { RotateCcw, X } from 'lucide-react';
import { useAppStore } from '../../../stores/useAppStore';
import type { AppConfig } from '../../../types';
import { CONFIG_BOUNDS } from '../../../utils/bounds';
import { LINE_ENDING_VALUES, lineEndingLabelKey } from '../../../utils/sendUtils';

const DisplaySettings: React.FC = () => {
  const { t } = useTranslation();
  const baudRatesId = useId();
  const lineEndingId = useId();
  const sendPrefixId = useId();
  const bgPathId = useId();
  const bgOpacityId = useId();
  const bgBlurId = useId();
  const timestampModeId = useId();
  const timestampFormatId = useId();
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
  const [baudWarning, setBaudWarning] = useState(false);
  useEffect(() => {
    setBaudDraft(defaultBaudRates.join(','));
    setBaudWarning(false);
  }, [defaultBaudRates]);
  const commitBaudDraft = () => {
    const rates = baudDraft
      .split(',')
      .map((part) => Number(part.trim()))
      .filter((rate) => Number.isFinite(rate) && rate > 0)
      .map((rate) => Math.round(rate));
    if (rates.length === 0) {
      const fallback = defaultBaudRates.length > 0
        ? defaultBaudRates
        : useAppStore.getInitialState().config.defaultBaudRates;
      setBaudDraft(fallback.join(','));
      setBaudWarning(true);
      return;
    }
    setBaudWarning(false);
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

  const handleResetDefaults = () => {
    const defaults = useAppStore.getInitialState().config;
    setBaudWarning(false);
    setConfig({
      defaultBaudRates: [...defaults.defaultBaudRates],
      showPortType: defaults.showPortType,
      defaultLineEnding: defaults.defaultLineEnding,
      sendPrefix: defaults.sendPrefix,
      timestampMode: defaults.timestampMode,
      timestampFormat: defaults.timestampFormat,
      backgroundImage: defaults.backgroundImage,
      backgroundImageEnabled: defaults.backgroundImageEnabled,
      backgroundImageOpacity: defaults.backgroundImageOpacity,
      backgroundImageBlur: defaults.backgroundImageBlur,
    });
  };

  return (
    <div className="config-page">
      <div className="config-page-top-bar">
        <p className="config-page-summary">{t('displaySettings.summary')}</p>
        <button type="button" className="btn btn-sm" onClick={handleResetDefaults}>
          <RotateCcw size={13} aria-hidden="true" />
          {t('configModal.resetPageDefaults')}
        </button>
      </div>
      <div className="config-row">
        <label htmlFor={baudRatesId}>{t('displaySettings.defaultBaudRatesLabel')}</label>
        <input
          id={baudRatesId}
          className={`input config-flex-input${baudWarning ? ' is-invalid' : ''}`}
          value={baudDraft}
          aria-invalid={baudWarning}
          onChange={(e) => { setBaudDraft(e.target.value); if (baudWarning) setBaudWarning(false); }}
          onBlur={commitBaudDraft}
          onKeyDown={(e) => { if (e.key === 'Enter') commitBaudDraft(); }}
        />
      </div>
      {baudWarning && (
        <p className="config-field-warning" role="alert">{t('displaySettings.baudRatesEmptyWarning')}</p>
      )}

      <label className="checkbox-wrapper">
        <input type="checkbox" checked={showPortType} onChange={(e) => setConfig({ showPortType: e.target.checked })} />
        {t('displaySettings.showPortType')}
      </label>

      <div className="config-row">
        <label htmlFor={lineEndingId}>{t('displaySettings.defaultLineEndingLabel')}</label>
        <select id={lineEndingId} className="select" value={defaultLineEnding} onChange={(e) => setConfig({ defaultLineEnding: e.target.value as AppConfig['defaultLineEnding'] })}>
          {LINE_ENDING_VALUES.map((value) => (
            <option key={value} value={value}>{t(lineEndingLabelKey(value, 'sendSection'))}</option>
          ))}
        </select>
      </div>

      <div className="config-row">
        <label htmlFor={sendPrefixId}>{t('displaySettings.sendPrefixLabel')}</label>
        <input id={sendPrefixId} className="input" value={sendPrefix} onChange={(e) => setConfig({ sendPrefix: e.target.value })} />
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
            <label htmlFor={bgPathId}>{t('displaySettings.background.pathLabel')}</label>
            <input
              id={bgPathId}
              className="input config-flex-input"
              value={backgroundImage}
              placeholder={t('displaySettings.background.pathPlaceholder')}
              readOnly
            />
            <button type="button" className="btn btn-sm" onClick={handleBrowseImage}>{t('displaySettings.background.browseButton')}</button>
            {backgroundImage && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setConfig({ backgroundImage: '' })}
                title={t('displaySettings.background.clearButton')}
                aria-label={t('displaySettings.background.clearButton')}
              >
                <X size={13} aria-hidden="true" />
                {t('displaySettings.background.clearButton')}
              </button>
            )}
          </div>

          <div className="config-row">
            <label htmlFor={bgOpacityId}>{t('displaySettings.background.opacityLabel')}</label>
            <input
              id={bgOpacityId}
              type="range"
              className="config-range-input"
              value={backgroundImageOpacity}
              onChange={(e) => setConfig({ backgroundImageOpacity: Number(e.target.value) })}
              min={CONFIG_BOUNDS.backgroundImageOpacity[0]}
              max={CONFIG_BOUNDS.backgroundImageOpacity[1]}
              step={1}
            />
            <span className="config-range-value">{backgroundImageOpacity}%</span>
          </div>

          <div className="config-row">
            <label htmlFor={bgBlurId}>{t('displaySettings.background.blurLabel')}</label>
            <input
              id={bgBlurId}
              type="range"
              className="config-range-input"
              value={backgroundImageBlur}
              onChange={(e) => setConfig({ backgroundImageBlur: Number(e.target.value) })}
              min={CONFIG_BOUNDS.backgroundImageBlur[0]}
              max={CONFIG_BOUNDS.backgroundImageBlur[1]}
              step={1}
            />
            <span className="config-range-value">{backgroundImageBlur}px</span>
          </div>
        </>
      )}

      <div className="divider-h" />
      <h4 className="config-section-title">{t('displaySettings.timestampSectionTitle')}</h4>

      <div className="config-row">
        <label htmlFor={timestampModeId}>{t('displaySettings.timestampModeLabel')}</label>
        <select id={timestampModeId} className="select" value={timestampMode} onChange={(e) => setConfig({ timestampMode: e.target.value as AppConfig['timestampMode'] })}>
          <option value="perLine">{t('displaySettings.timestampMode.perLine')}</option>
          <option value="perRound">{t('displaySettings.timestampMode.perRound')}</option>
        </select>
      </div>

      <div className="config-row">
        <label htmlFor={timestampFormatId}>{t('displaySettings.timestampFormat.label')}</label>
        <select id={timestampFormatId} className="select" value={timestampFormat} onChange={(e) => setConfig({ timestampFormat: e.target.value as AppConfig['timestampFormat'] })}>
          <option value="absolute">{t('displaySettings.timestampFormat.absolute')}</option>
          <option value="relative">{t('displaySettings.timestampFormat.relative')}</option>
          <option value="uptime">{t('displaySettings.timestampFormat.uptime')}</option>
        </select>
      </div>
    </div>
  );
};

export default DisplaySettings;
