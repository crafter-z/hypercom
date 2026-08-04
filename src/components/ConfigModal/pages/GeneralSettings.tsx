import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../../stores/useAppStore';
import { useOperationStore } from '../../../stores/useOperationStore';
import { configService, storageService } from '../../../services/tauri';
import type { PortPreset } from '../../../types';
import type { AppConfig, DataBits, Parity, StopBits, Handshake } from '../../../types';
import { notifyError, notifySuccess } from '../../../stores/useToastStore';

/** Clamp a numeric input to [min, max], falling back to min on NaN (e.g. a cleared field). */
const clampNumber = (raw: string, min: number, max: number): number => {
  const value = Number(raw);
  return Number.isNaN(value) ? min : Math.max(min, Math.min(max, value));
};

const GeneralSettings: React.FC = () => {
  const { t } = useTranslation();
  const closeBehavior = useAppStore(s => s.config.closeBehavior);
  const memoryLimitMb = useAppStore(s => s.config.memoryLimitMb);
  const language = useAppStore(s => s.config.language);
  const theme = useAppStore(s => s.config.theme);
  const preventScreenOff = useAppStore(s => s.config.preventScreenOff);
  const preventSleep = useAppStore(s => s.config.preventSleep);
  const restoreSession = useAppStore(s => s.config.restoreSession);
  const sendOnEnter = useAppStore(s => s.config.sendOnEnter);
  const autoReconnect = useAppStore(s => s.config.autoReconnect);
  const maxRetries = useAppStore(s => s.config.maxRetries);
  const terminalFont = useAppStore(s => s.config.terminalFont);
  const terminalFontSize = useAppStore(s => s.config.terminalFontSize);
  const uiFont = useAppStore(s => s.config.uiFont);
  const uiFontSize = useAppStore(s => s.config.uiFontSize);
  const setConfig = useAppStore((s) => s.setConfig);

  const [configPath, setConfigPath] = useState('');
  useEffect(() => {
    configService.getConfigPath().then(setConfigPath).catch(() => {});
  }, []);

  const [presets, setPresets] = useState<PortPreset[]>([]);
  const [presetName, setPresetName] = useState('');

  const loadPresets = useCallback(async () => {
    try {
      const list = await storageService.loadPortPresets();
      setPresets(list);
    } catch (e) {
      console.debug('[GeneralSettings] loadPortPresets failed:', e);
    }
  }, []);

  useEffect(() => {
    loadPresets();
  }, [loadPresets]);

  const handleApplyPreset = (p: PortPreset) => {
    useOperationStore.getState().setOpState({
      baudRate: p.baudRate,
      dataBits: p.dataBits as DataBits,
      parity: p.parity as Parity,
      stopBits: p.stopBits as StopBits,
      handshake: p.handshake as Handshake,
      dtr: p.dtr,
      rts: p.rts,
    });
  };

  const handleDeletePreset = async (id: string) => {
    try {
      await storageService.deletePortPreset(id);
      await loadPresets();
      notifySuccess('paramsSection.preset.deleted');
    } catch (e) {
      notifyError(e);
    }
  };

  const handleSavePreset = async () => {
    const name = presetName.trim();
    if (!name) return;
    try {
      const op = useOperationStore.getState();
      await storageService.savePortPreset({
        id: `preset-${Date.now()}`,
        name,
        baudRate: op.baudRate,
        dataBits: op.dataBits,
        parity: op.parity,
        stopBits: op.stopBits,
        handshake: op.handshake,
        dtr: op.dtr,
        rts: op.rts,
      });
      setPresetName('');
      await loadPresets();
      notifySuccess('paramsSection.preset.saved');
    } catch (e) {
      notifyError(e);
    }
  };

  return (
    <div className="config-page">
      <h3 className="config-page-title">{t('generalSettings.title')}</h3>

      <div className="config-row">
        <label>{t('generalSettings.closeBehaviorLabel')}</label>
        <select
          className="select"
          value={closeBehavior}
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
          value={memoryLimitMb}
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
          value={language}
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
          value={theme}
          onChange={(e) => setConfig({ theme: e.target.value as AppConfig['theme'] })}
        >
          <option value="light">{t('generalSettings.theme.light')}</option>
          <option value="dark">{t('generalSettings.theme.dark')}</option>
          <option value="system">{t('generalSettings.theme.system')}</option>
        </select>
      </div>

      <div className="config-row">
        <label className="checkbox-wrapper">
          <input type="checkbox" checked={preventScreenOff} onChange={(e) => setConfig({ preventScreenOff: e.target.checked })} />
          {t('generalSettings.preventScreenOff')}
        </label>
        <label className="checkbox-wrapper">
          <input type="checkbox" checked={preventSleep} onChange={(e) => setConfig({ preventSleep: e.target.checked })} />
          {t('generalSettings.preventSleep')}
        </label>
        <label className="checkbox-wrapper">
          <input type="checkbox" checked={restoreSession} onChange={(e) => setConfig({ restoreSession: e.target.checked })} />
          {t('generalSettings.restoreSession')}
        </label>
      </div>

      <div className="config-row">
        <label className="checkbox-wrapper" title={t('generalSettings.enterNewline.hint')}>
          <input
            type="checkbox"
            checked={!sendOnEnter}
            onChange={(e) => setConfig({ sendOnEnter: !e.target.checked })}
          />
          {t('generalSettings.enterNewline')}
        </label>
      </div>

      <div className="divider-h" />
      <h4 className="config-section-title">{t('settings.reconnect.sectionTitle')}</h4>

      <div className="config-row">
        <label className="checkbox-wrapper">
          <input
            type="checkbox"
            checked={autoReconnect}
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
          value={maxRetries}
          onChange={(e) => setConfig({ maxRetries: clampNumber(e.target.value, 1, 10) })}
          min={1}
          max={10}
          step={1}
          style={{ width: 80 }}
        />
      </div>

      <div className="divider-h" />
      <h4 className="config-section-title">{t('generalSettings.presets.sectionTitle')}</h4>

      <div className="config-row">
        <input
          className="input"
          style={{ flex: 1 }}
          value={presetName}
          placeholder={t('generalSettings.presets.namePlaceholder')}
          onChange={(e) => setPresetName(e.target.value)}
        />
        <button className="btn btn-sm" disabled={!presetName.trim()} onClick={handleSavePreset}>
          {t('generalSettings.presets.saveCurrent')}
        </button>
      </div>

      {presets.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('generalSettings.presets.empty')}</div>
      ) : (
        presets.map((p) => (
          <div className="config-row" key={p.id}>
            <span style={{ flex: 1, fontSize: 13 }}>
              {p.name}
              <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-terminal)' }}>
                {p.baudRate},{p.dataBits}{(p.parity ?? 'None')[0]}{p.stopBits === 'One' ? '1' : p.stopBits === 'Two' ? '2' : '1.5'}
              </span>
            </span>
            <button className="btn btn-sm" onClick={() => handleApplyPreset(p)}>{t('generalSettings.presets.apply')}</button>
            <button className="btn btn-sm" onClick={() => handleDeletePreset(p.id)}>{t('generalSettings.presets.delete')}</button>
          </div>
        ))
      )}

      <div className="divider-h" />
      <h4 className="config-section-title">{t('generalSettings.fontSectionTitle')}</h4>

      <div className="config-row">
        <label>{t('generalSettings.terminalFontLabel')}</label>
        <input className="input" value={terminalFont} onChange={(e) => setConfig({ terminalFont: e.target.value })} />
        <input className="input" type="number" value={terminalFontSize} onChange={(e) => setConfig({ terminalFontSize: clampNumber(e.target.value, 8, 96) })} min={8} max={96} style={{ width: 60 }} />
        <span>{t('generalSettings.pxUnit')}</span>
      </div>

      <div className="config-row">
        <label>{t('generalSettings.uiFontLabel')}</label>
        <input className="input" value={uiFont} onChange={(e) => setConfig({ uiFont: e.target.value })} />
        <input className="input" type="number" value={uiFontSize} onChange={(e) => setConfig({ uiFontSize: clampNumber(e.target.value, 8, 96) })} min={8} max={96} style={{ width: 60 }} />
        <span>{t('generalSettings.pxUnit')}</span>
      </div>

      <div style={{ marginTop: 16, fontSize: 12, color: 'var(--text-secondary)' }}>
        {t('general.configPath')}: {configPath}
      </div>
    </div>
  );
};

export default GeneralSettings;
