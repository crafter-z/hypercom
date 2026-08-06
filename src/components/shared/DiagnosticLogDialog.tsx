import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../stores/useAppStore';
import { useRuleStore } from '../../stores/useRuleStore';
import { useConfigPersistence } from '../../hooks';
import { mergeLiveRuleEntities } from '../../utils/configMerge';
import { diagLogService, fileService } from '../../services/tauri';
import { save } from '@tauri-apps/plugin-dialog';
import { X, RefreshCw, Trash2, Download, Eraser } from 'lucide-react';
import { dropDiagLogPending, parseDiagLogLine } from '../../utils/diagLog';

type LevelFilter = 'all' | 'INFO' | 'WARN' | 'ERROR';

const LEVEL_CLASS: Record<string, string> = {
  TRACE: 'diag-level-trace',
  DEBUG: 'diag-level-debug',
  INFO: 'diag-level-info',
  WARN: 'diag-level-warn',
  ERROR: 'diag-level-error',
};

function levelClass(level: string): string {
  return LEVEL_CLASS[level] ?? 'diag-level-info';
}

const DiagnosticLogDialog: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { t } = useTranslation();
  const diagEnabled = useAppStore((s) => s.config.diagLogEnabled);
  const setConfig = useAppStore((s) => s.setConfig);
  const { saveConfig } = useConfigPersistence();

  const [logText, setLogText] = useState('');
  const [levelFilter, setLevelFilter] = useState<LevelFilter>('all');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [diagPath, setDiagPath] = useState('');
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const text = await diagLogService.readDiagLog(2000);
      setLogText(text);
    } catch (e) {
      console.debug('[DiagLog] read failed:', e);
    }
  }, []);

  // 初次加载路径 + 日志。
  useEffect(() => {
    diagLogService
      .getDiagLogPath()
      .then(setDiagPath)
      .catch((e) => console.debug('[DiagLog] get path failed:', e));
    refresh();
  }, [refresh]);

  // 自动刷新（1s 轮询）：跟随最新日志。
  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(refresh, 1000);
    return () => clearInterval(timer);
  }, [autoRefresh, refresh]);

  // 新日志到达时若贴近底部则跟随滚动。
  const prevLenRef = useRef(0);
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
    if (logText.length > prevLenRef.current && atBottom) {
      el.scrollTop = el.scrollHeight;
    }
    prevLenRef.current = logText.length;
  }, [logText]);

  const handleToggleDiag = async (checked: boolean) => {
    setConfig({ diagLogEnabled: checked });
    // 与 ConfigModal 页脚 Save 同款问题（issue #5-2）：全量保存必须携带
    // useRuleStore 的实时实体，否则用启动快照整体替换掉刚保存的规则。
    await saveConfig(mergeLiveRuleEntities(useAppStore.getState().config, useRuleStore.getState()));
  };

  const handleClear = async () => {
    setBusy(true);
    try {
      dropDiagLogPending(); // 丢弃前端待刷缓冲，避免清完又回写
      await diagLogService.clearDiagLog();
      await refresh();
    } catch (e) {
      console.debug('[DiagLog] clear failed:', e);
    } finally {
      setBusy(false);
    }
  };

  const handleExport = async () => {
    setBusy(true);
    try {
      const filePath = await save({
        title: t('diagLog.exportDialog.title'),
        defaultPath: `hypercom-diag-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.log`,
        filters: [{ name: t('diagLog.exportDialog.filterName'), extensions: ['log', 'txt'] }],
      });
      if (filePath) {
        await fileService.writeTextFile(filePath, logText);
      }
    } catch (e) {
      console.debug('[DiagLog] export failed:', e);
    } finally {
      setBusy(false);
    }
  };

  const lines = logText
    .split('\n')
    .map(parseDiagLogLine)
    .filter((l) => levelFilter === 'all' || l.level === levelFilter);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-dialog diag-log-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="diag-log-header">
          <h3 className="modal-content-title diag-log-title">{t('diagLog.title')}</h3>
          <div className="diag-log-toolbar">
            <label className="checkbox-wrapper diag-log-toggle">
              <input
                type="checkbox"
                checked={diagEnabled}
                onChange={(e) => handleToggleDiag(e.target.checked)}
              />
              {t('diagLog.enabled')}
            </label>
            <select
              className="select diag-log-filter"
              value={levelFilter}
              onChange={(e) => setLevelFilter(e.target.value as LevelFilter)}
              title={t('diagLog.filter')}
            >
              <option value="all">{t('diagLog.filterAll')}</option>
              <option value="INFO">INFO</option>
              <option value="WARN">WARN</option>
              <option value="ERROR">ERROR</option>
            </select>
            <label className="checkbox-wrapper diag-log-toggle">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
              />
              {t('diagLog.autoRefresh')}
            </label>
            <button className="btn btn-icon btn-sm" title={t('diagLog.refresh')} onClick={refresh} disabled={busy}>
              <RefreshCw size={14} />
            </button>
            <button className="btn btn-icon btn-sm" title={t('diagLog.export')} onClick={handleExport} disabled={busy}>
              <Download size={14} />
            </button>
            <button className="btn btn-icon btn-sm" title={t('diagLog.clear')} onClick={handleClear} disabled={busy}>
              <Trash2 size={14} />
            </button>
            <button className="btn btn-icon btn-sm" title={t('hotkeys.close')} onClick={onClose}>
              <X size={14} />
            </button>
          </div>
        </div>

        <div
          ref={logRef}
          className="diag-log-view"
        >
          {lines.length === 0 ? (
            <div className="diag-log-empty">{t('diagLog.empty')}</div>
          ) : (
            lines.map((l, i) => (
              <div key={i} className={`diag-log-line ${levelClass(l.level)}`}>
                {l.text}
              </div>
            ))
          )}
        </div>

        <div className="diag-log-footer">
          <button className="btn btn-sm diag-log-clear-scroll" title={t('diagLog.scrollToLatest')} onClick={() => { const el = logRef.current; if (el) el.scrollTop = el.scrollHeight; }}>
            <Eraser size={12} />
            {t('diagLog.scrollToLatest')}
          </button>
          <span className="diag-log-path" title={diagPath}>{diagPath || t('diagLog.loadingPath')}</span>
        </div>
      </div>
    </div>
  );
};

export default DiagnosticLogDialog;