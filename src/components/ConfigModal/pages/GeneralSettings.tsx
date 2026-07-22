import React from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../../stores/useAppStore';
import { open } from '@tauri-apps/plugin-dialog';
import type { AppConfig } from '../../../types';

/** Clamp a numeric input to [min, max], falling back to min on NaN (e.g. a cleared field). */
const clampNumber = (raw: string, min: number, max: number): number => {
  const value = Number(raw);
  return Number.isNaN(value) ? min : Math.max(min, Math.min(max, value));
};

const GeneralSettings: React.FC = () => {
  const { t } = useTranslation();
  const config = useAppStore((s) => s.config);
  const setConfig = useAppStore((s) => s.setConfig);

  return (
    <div className="config-page">
      <h3 className="config-page-title">{t('generalSettings.title')}</h3>

      <div className="config-row">
        <label>{t('generalSettings.closeBehaviorLabel')}</label>
        <select
          className="select"
          value={config.closeBehavior}
          onChange={(e) => setConfig({ closeBehavior: e.target.value as AppConfig['closeBehavior'] })}
        >
          <option value="minimize">{t('generalSettings.closeBehavior.minimize')}</option>
          <option value="exit">{t('generalSettings.closeBehavior.exit')}</option>
        </select>
      </div>

      <div className="config-row">
        <label>{t('generalSettings.memoryLimitLabel')}</label>
        <input
          className="input"
          type="number"
          value={config.memoryLimitMb}
          onChange={(e) => setConfig({ memoryLimitMb: clampNumber(e.target.value, 64, 4096) })}
          min={64}
          max={4096}
          step={64}
        />
      </div>

      <div className="config-row">
        <label>{t('generalSettings.languageLabel')}</label>
        <select
          className="select"
          value={config.language}
          onChange={(e) => setConfig({ language: e.target.value as AppConfig['language'] })}
        >
          <option value="zh-CN">{t('generalSettings.language.zhCN')}</option>
          <option value="en-US">{t('generalSettings.language.enUS')}</option>
        </select>
      </div>

      <div className="config-row">
        <label>{t('generalSettings.themeLabel')}</label>
        <select
          className="select"
          value={config.theme}
          onChange={(e) => setConfig({ theme: e.target.value as AppConfig['theme'] })}
        >
          <option value="light">{t('generalSettings.theme.light')}</option>
          <option value="dark">{t('generalSettings.theme.dark')}</option>
          <option value="system">{t('generalSettings.theme.system')}</option>
        </select>
      </div>

      <div className="config-row">
        <label className="checkbox-wrapper">
          <input type="checkbox" checked={config.preventScreenOff} onChange={(e) => setConfig({ preventScreenOff: e.target.checked })} />
          {t('generalSettings.preventScreenOff')}
        </label>
        <label className="checkbox-wrapper">
          <input type="checkbox" checked={config.preventSleep} onChange={(e) => setConfig({ preventSleep: e.target.checked })} />
          {t('generalSettings.preventSleep')}
        </label>
        <label className="checkbox-wrapper">
          <input type="checkbox" checked={config.restoreSession} onChange={(e) => setConfig({ restoreSession: e.target.checked })} />
          {t('generalSettings.restoreSession')}
        </label>
      </div>

      <div className="divider-h" />
      <h4 className="config-section-title">{t('settings.reconnect.sectionTitle')}</h4>

      <div className="config-row">
        <label className="checkbox-wrapper">
          <input
            type="checkbox"
            checked={config.autoReconnect}
            onChange={(e) => setConfig({ autoReconnect: e.target.checked })}
          />
          {t('settings.reconnect.autoReconnect.label')}
        </label>
      </div>

      <div className="config-row">
        <label>{t('settings.reconnect.maxRetries.label')}:</label>
        <input
          className="input"
          type="number"
          value={config.maxRetries}
          onChange={(e) => setConfig({ maxRetries: clampNumber(e.target.value, 1, 10) })}
          min={1}
          max={10}
          step={1}
          style={{ width: 80 }}
        />
      </div>

      <div className="divider-h" />
      <h4 className="config-section-title">{t('generalSettings.fontSectionTitle')}</h4>

      <div className="config-row">
        <label>{t('generalSettings.terminalFontLabel')}</label>
        <input className="input" value={config.terminalFont} onChange={(e) => setConfig({ terminalFont: e.target.value })} />
        <input className="input" type="number" value={config.terminalFontSize} onChange={(e) => setConfig({ terminalFontSize: clampNumber(e.target.value, 8, 96) })} min={8} max={96} style={{ width: 60 }} />
        <span>{t('generalSettings.pxUnit')}</span>
      </div>

      <div className="config-row">
        <label>{t('generalSettings.uiFontLabel')}</label>
        <input className="input" value={config.uiFont} onChange={(e) => setConfig({ uiFont: e.target.value })} />
        <input className="input" type="number" value={config.uiFontSize} onChange={(e) => setConfig({ uiFontSize: clampNumber(e.target.value, 8, 96) })} min={8} max={96} style={{ width: 60 }} />
        <span>{t('generalSettings.pxUnit')}</span>
      </div>

      <div className="config-row">
        <label>{t('generalSettings.backgroundImageLabel')}</label>
        <input className="input" value={config.backgroundImage || ''} placeholder={t('generalSettings.backgroundImagePlaceholder')} readOnly />
        <button className="btn btn-sm" onClick={async () => {
          const result = await open({ directory: false, multiple: false, filters: [{ name: t('generalSettings.imageFilterName'), extensions: ['png', 'jpg', 'jpeg', 'bmp', 'webp'] }] });
          if (result) setConfig({ backgroundImage: result });
        }}>{t('generalSettings.browseButton')}</button>
      </div>
    </div>
  );
};

export default GeneralSettings;
