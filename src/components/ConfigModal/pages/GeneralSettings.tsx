import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../../stores/useAppStore';
import { configService } from '../../../services/tauri';
import { updateTiming } from '../../../utils/updateService';
import type { AppConfig } from '../../../types';
import type { UpdateCheckMode } from '../../../types';

/** Clamp a numeric input to [min, max], falling back to min on NaN (e.g. a cleared field). */
const clampNumber = (raw: string, min: number, max: number): number => {
  const value = Number(raw);
  return Number.isNaN(value) ? min : Math.max(min, Math.min(max, value));
};

const GeneralSettings: React.FC = () => {
  const { t } = useTranslation();
  const closeBehavior = useAppStore(s => s.config.closeBehavior);
  const memoryLimitMb = useAppStore(s => s.config.memoryLimitMb);
  const memoryPerPortBudgetMb = useAppStore(s => s.config.memoryPerPortBudgetMb);
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
  const updateCheckMode = useAppStore(s => s.config.updateCheckMode);
  const setConfig = useAppStore((s) => s.setConfig);

  const [configPath, setConfigPath] = useState('');
  // issue #12 二轮：上次自动检查时间（localStorage 记账，挂载时读取——页面卸载
  // 重挂即刷新，保存边界触发的后台检查落账后下次打开可见）。
  const [lastCheckAt] = useState<number | null>(() => updateTiming.getLastCheckAt());
  useEffect(() => {
    configService.getConfigPath().then(setConfigPath).catch(() => {});
  }, []);

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

      {/* issue #6-2：内存预算拆为「总预算（软兜底）」+「每端口预算（硬约束）」双配置 */}
      <div className="config-row" title={t('generalSettings.memoryLimitHint')}>
        <label>{t('generalSettings.memoryLimitLabel')}</label>
        <input
          className="input"
          type="number"
          value={memoryLimitMb}
          onChange={(e) => setConfig({ memoryLimitMb: clampNumber(e.target.value, 64, 8192) })}
          min={64}
          max={8192}
          step={64}
        />
      </div>

      <div className="config-row" title={t('generalSettings.memoryPerPortBudgetHint')}>
        <label>{t('generalSettings.memoryPerPortBudgetLabel')}</label>
        <input
          className="input"
          type="number"
          value={memoryPerPortBudgetMb}
          onChange={(e) => setConfig({ memoryPerPortBudgetMb: clampNumber(e.target.value, 16, 2048) })}
          min={16}
          max={2048}
          step={16}
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
      <h4 className="config-section-title">{t('update.sectionTitle')}</h4>

      {/* issue #12：自动更新三态模式。模式变更的清账副作用（clearSnooze +
          clearLastCheck）在 ConfigModal.handleSave 保存边界执行——取消时不泄漏。 */}
      <div className="config-row" title={t('update.periodHint')}>
        <label>{t('update.modeLabel')}</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
          {(['none', 'stable', 'preview'] as UpdateCheckMode[]).map((mode) => (
            <label key={mode} className="checkbox-wrapper">
              <input
                type="radio"
                name="updateCheckMode"
                value={mode}
                checked={updateCheckMode === mode}
                onChange={() => setConfig({ updateCheckMode: mode })}
              />
              {t(`update.mode.${mode}`)}
            </label>
          ))}
        </div>
      </div>

      <div className="config-row">
        <label>{t('update.lastCheckLabel')}</label>
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          {lastCheckAt === null ? t('update.lastCheckNever') : new Date(lastCheckAt).toLocaleString()}
        </span>
      </div>

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
