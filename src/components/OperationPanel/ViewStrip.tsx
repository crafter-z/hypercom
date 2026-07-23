import React from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { useOperationStore } from '../../stores/useOperationStore';
import { logService } from '../../services/tauri';
import { notifyError, notifyInfo } from '../../stores/useToastStore';
import { save } from '@tauri-apps/plugin-dialog';
import { Pin, Clock, Type, FileText, FolderOpen, FileSearch } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export interface ViewStripProps {
  isPortActive: boolean;
  activeTabId: string | null;
}

const ViewStrip: React.FC<ViewStripProps> = ({ isPortActive, activeTabId }) => {
  const { t } = useTranslation();
  const scrollLocked = useOperationStore(s => s.scrollLocked);
  const showTimestamp = useOperationStore(s => s.showTimestamp);
  const displayFormat = useOperationStore(s => s.displayFormat);
  const setOpState = useOperationStore(s => s.setOpState);
  const config = useAppStore(s => s.config);

  const handleSaveLogAs = async () => {
    if (!activeTabId) return;
    try {
      const filePath = await save({
        title: t('paramsSection.saveDialog.title'),
        defaultPath: `${activeTabId}.log`,
        filters: [{ name: t('paramsSection.saveDialog.filterName'), extensions: ['log', 'txt'] }],
      });
      if (filePath) await logService.saveLogAs(activeTabId, filePath);
    } catch (e) { console.error('Failed to save log:', e); notifyError(e); }
  };

  const handleOpenLogFile = async () => {
    if (!activeTabId) return;
    try {
      const files = await logService.getLogFiles();
      const candidates = files.filter(f => f.portId === activeTabId);
      const match = candidates.length > 0
        ? candidates.reduce((newest, f) => f.createdAt > newest.createdAt ? f : newest)
        : undefined;
      if (match) {
        await logService.openPath(match.path);
      } else {
        // Previously a silent no-op — users read it as a dead button.
        notifyInfo('paramsSection.log.notFound');
      }
    } catch (e) { console.error('Failed to open log file:', e); notifyError(e); }
  };

  const handleOpenLogDir = async () => {
    try { await logService.openLogDirectory(); }
    catch (e) { console.error('Failed to open log dir:', e); notifyError(e); }
  };

  return (
    <div className="op-strip">
      <div className="op-strip-group">
        <button
          className={`btn btn-icon btn-sm${scrollLocked ? ' active' : ''}`}
          title={t('paramsSection.scrollLock')}
          onClick={() => setOpState({ scrollLocked: !scrollLocked })}
        >
          <Pin size={14} />
        </button>
        <button
          className={`btn btn-icon btn-sm${showTimestamp ? ' active' : ''}`}
          title={t('paramsSection.timestamp')}
          onClick={() => setOpState({ showTimestamp: !showTimestamp })}
        >
          <Clock size={14} />
        </button>
        <span className="toolbar-sep" />
        <div className="segmented">
          <button
            className={`segmented-btn${displayFormat === 'hex' ? ' active' : ''}`}
            onClick={() => setOpState({ displayFormat: 'hex' })}
          >
            HEX
          </button>
          <button
            className={`segmented-btn${displayFormat === 'string' ? ' active' : ''}`}
            onClick={() => setOpState({ displayFormat: 'string' })}
          >
            {t('paramsSection.displayFormat.string')}
          </button>
        </div>
      </div>
      <div className="op-strip-group">
        <Type size={13} className="op-strip-icon" />
        <input
          type="range"
          className="op-strip-slider"
          min={8}
          max={48}
          step={1}
          value={config.terminalFontSize}
          onChange={e => useAppStore.getState().setConfig({ terminalFontSize: Number(e.target.value) })}
        />
        <span className="op-strip-value">{config.terminalFontSize}px</span>
        <span className="toolbar-sep" />
        <button
          className="btn btn-icon btn-sm"
          title={t('paramsSection.log.saveAs')}
          disabled={!isPortActive}
          onClick={handleSaveLogAs}
        >
          <FileText size={14} />
        </button>
        <button
          className="btn btn-icon btn-sm"
          title={t('paramsSection.log.openFile')}
          disabled={!isPortActive}
          onClick={handleOpenLogFile}
        >
          <FolderOpen size={14} />
        </button>
        <button
          className="btn btn-icon btn-sm"
          title={t('paramsSection.log.openDir')}
          onClick={handleOpenLogDir}
        >
          <FileSearch size={14} />
        </button>
      </div>
    </div>
  );
};

export default ViewStrip;