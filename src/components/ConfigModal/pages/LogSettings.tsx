import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../../stores/useAppStore';
import { open } from '@tauri-apps/plugin-dialog';
import { logService } from '../../../services/tauri';
import { notifyError, useToastStore } from '../../../stores/useToastStore';
import type { AppConfig } from '../../../types';

/** Clamp a numeric input to [min, max], falling back to min on NaN (e.g. a cleared field). */
const clampNumber = (raw: string, min: number, max: number): number => {
  const value = Number(raw);
  return Number.isNaN(value) ? min : Math.max(min, Math.min(max, value));
};

interface DirChangeDialogProps {
  oldDir: string;
  newDir: string;
  /** 仅切换目录，不迁移旧日志 */
  onSwitchOnly: () => void;
  /** 迁移旧日志到新目录后切换 */
  onMigrate: () => void;
  onCancel: () => void;
  migrating: boolean;
}

/** 日志目录变更确认弹窗（模块级组件，避免重渲染销毁） */
const DirChangeDialog: React.FC<DirChangeDialogProps> = ({
  oldDir, newDir, onSwitchOnly, onMigrate, onCancel, migrating,
}) => {
  const { t } = useTranslation();
  return (
    <div className="modal-overlay" onClick={migrating ? undefined : onCancel}>
      <div className="modal-dialog-compact animate-slide-up" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-dialog-title">{t('logSettings.dirChange.title')}</h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 8, wordBreak: 'break-all' }}>
          {t('logSettings.dirChange.message')}
        </p>
        <p style={{ color: 'var(--text-secondary)', fontSize: 12, marginBottom: 4, wordBreak: 'break-all' }}>
          {t('logSettings.dirChange.from')}: {oldDir}
        </p>
        <p style={{ color: 'var(--text-secondary)', fontSize: 12, marginBottom: 12, wordBreak: 'break-all' }}>
          {t('logSettings.dirChange.to')}: {newDir}
        </p>
        <div className="modal-dialog-actions">
          <button className="btn" onClick={onCancel} disabled={migrating}>
            {t('logSettings.dirChange.cancel')}
          </button>
          <button className="btn" onClick={onSwitchOnly} disabled={migrating}>
            {t('logSettings.dirChange.switchOnly')}
          </button>
          <button className="btn btn-primary" onClick={onMigrate} disabled={migrating}>
            {migrating ? t('logSettings.dirChange.migrating') : t('logSettings.dirChange.migrate')}
          </button>
        </div>
      </div>
    </div>
  );
};

const LogSettings: React.FC = () => {
  const { t } = useTranslation();
  const autoSaveLog = useAppStore(s => s.config.autoSaveLog);
  const logIncludeTimestamp = useAppStore(s => s.config.logIncludeTimestamp);
  const logIncludeDirection = useAppStore(s => s.config.logIncludeDirection);
  const logDirectory = useAppStore(s => s.config.logDirectory);
  const logFilenameFormat = useAppStore(s => s.config.logFilenameFormat);
  const logFormat = useAppStore(s => s.config.logFormat);
  const logEncoding = useAppStore(s => s.config.logEncoding);
  const logSplitEnabled = useAppStore(s => s.config.logSplitEnabled);
  const logSplitSizeMb = useAppStore(s => s.config.logSplitSizeMb);
  const setConfig = useAppStore((s) => s.setConfig);

  // 目录变更弹窗状态：pendingDir 非空时弹窗打开
  const [pendingDir, setPendingDir] = useState<string | null>(null);
  const [migrating, setMigrating] = useState(false);

  const handleBrowse = async () => {
    const result = await open({ directory: true });
    if (!result) return;
    // 目录未变化时直接跳过
    if (result === logDirectory) return;
    // 旧目录为空（首次设置）时直接设置，无需确认
    if (!logDirectory) {
      setConfig({ logDirectory: result });
      return;
    }
    setPendingDir(result);
  };

  const handleSwitchOnly = () => {
    if (pendingDir) setConfig({ logDirectory: pendingDir });
    setPendingDir(null);
  };

  const handleMigrate = async () => {
    if (!pendingDir) return;
    setMigrating(true);
    try {
      const count = await logService.migrateLogDirectory(logDirectory, pendingDir);
      setConfig({ logDirectory: pendingDir });
      // 单次本地化 toast：有迁移文件时显示数量，否则仅提示目录已更新
      const message = count > 0
        ? t('logSettings.dirChange.migratedCount', { count })
        : t('logSettings.dirChange.migrateSuccess');
      useToastStore.getState().push({ severity: 'success', message });
    } catch (e) {
      notifyError(e);
    } finally {
      setMigrating(false);
      setPendingDir(null);
    }
  };

  return (
    <div className="config-page">
      <h3 className="config-page-title">{t('logSettings.title')}</h3>

      <label className="checkbox-wrapper">
        <input type="checkbox" checked={autoSaveLog} onChange={(e) => setConfig({ autoSaveLog: e.target.checked })} />
        {t('logSettings.autoSaveLog')}
      </label>

      <div className="config-row">
        <label>{t('logSettings.directoryLabel')}</label>
        <input className="input" value={logDirectory} placeholder={t('logSettings.directoryPlaceholder')} readOnly />
        <button className="btn btn-sm" onClick={handleBrowse}>{t('logSettings.browseButton')}</button>
      </div>

      <div className="config-row">
        <label>{t('logSettings.filenameFormatLabel')}</label>
        <input className="input" value={logFilenameFormat} onChange={(e) => setConfig({ logFilenameFormat: e.target.value })} />
        <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{t('logSettings.filenameFormatHint')}</span>
      </div>

      <label className="checkbox-wrapper">
        <input type="checkbox" checked={logIncludeTimestamp} onChange={(e) => setConfig({ logIncludeTimestamp: e.target.checked })} />
        {t('logSettings.includeTimestamp')}
      </label>
      <label className="checkbox-wrapper">
        <input type="checkbox" checked={logIncludeDirection} onChange={(e) => setConfig({ logIncludeDirection: e.target.checked })} />
        {t('logSettings.includeDirection')}
      </label>

      <div className="config-row">
        <label>{t('logSettings.formatLabel')}</label>
        <select className="select" value={logFormat} onChange={(e) => setConfig({ logFormat: e.target.value as AppConfig['logFormat'] })}>
          <option value="string">{t('logSettings.format.string')}</option>
          <option value="hex">{t('logSettings.format.hex')}</option>
          <option value="binary">{t('logSettings.format.binary')}</option>
        </select>
      </div>

      <div className="config-row">
        <label>{t('logSettings.encodingLabel')}</label>
        <select className="select" value={logEncoding} onChange={(e) => setConfig({ logEncoding: e.target.value as AppConfig['logEncoding'] })}>
          <option value="ASCII">ASCII</option>
          <option value="UTF-8">UTF-8</option>
          <option value="GBK">GBK</option>
          <option value="ISO-8859-1">ISO-8859-1</option>
        </select>
      </div>

      <label className="checkbox-wrapper">
        <input type="checkbox" checked={logSplitEnabled} onChange={(e) => setConfig({ logSplitEnabled: e.target.checked })} />
        {t('logSettings.splitEnabled')}
      </label>

      {logSplitEnabled && (
        <div className="config-row">
          <label>{t('logSettings.splitSizeLabel')}</label>
          <input className="input" type="number" value={logSplitSizeMb} onChange={(e) => setConfig({ logSplitSizeMb: clampNumber(e.target.value, 1, 10240) })} min={1} max={10240} />
        </div>
      )}

      {pendingDir && (
        <DirChangeDialog
          oldDir={logDirectory}
          newDir={pendingDir}
          onSwitchOnly={handleSwitchOnly}
          onMigrate={handleMigrate}
          onCancel={() => setPendingDir(null)}
          migrating={migrating}
        />
      )}
    </div>
  );
};

export default LogSettings;
