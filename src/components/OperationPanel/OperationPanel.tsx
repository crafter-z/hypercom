import React, { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { useOperationStore } from '../../stores/useOperationStore';
import { useRuleStore } from '../../stores/useRuleStore';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { useSerialSend, useSerialConnection } from '../../hooks';
import { serialService, logService } from '../../services/tauri';
import { notifyError, notifyInfo } from '../../stores/useToastStore';
import { open, save } from '@tauri-apps/plugin-dialog';
import { ChevronDown, Cable, Eraser, FileText, FolderOpen, FileSearch, History, Square, Type } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import SendSection from './SendSection';
import RulesSection from './RulesSection';
import ParamsSection from './ParamsSection';
import { useLogReplay } from '../MainDisplay/hooks/useLogReplay';
import { useCyclicSend } from './hooks/useCyclicSend';

const OperationPanel: React.FC = () => {
  const { t } = useTranslation();
  const activeTabId = useAppStore(s => s.activeTabId);
  const collapsed = useAppStore(s => s.ui.isOperationPanelCollapsed);
  const panelHeight = useAppStore(s => s.ui.operationPanelHeight);
  const baudRate = useOperationStore(s => s.baudRate);
  const dataBits = useOperationStore(s => s.dataBits);
  const parity = useOperationStore(s => s.parity);
  const stopBits = useOperationStore(s => s.stopBits);
  const handshake = useOperationStore(s => s.handshake);
  const dtr = useOperationStore(s => s.dtr);
  const rts = useOperationStore(s => s.rts);
  const isLoopSending = useOperationStore(s => s.isLoopSending);
  const sendCommandSets = useRuleStore(s => s.sendCommandSets);
  const activeSendCommandSetId = useRuleStore(s => s.activeSendCommandSetId);
  const setOpState = useOperationStore(s => s.setOpState);
  const setUIState = useAppStore(s => s.setUIState);
  const clearTerminal = useTerminalStore(s => s.clearTerminal);
  const terminalFontSize = useAppStore(s => s.config.terminalFontSize);
  const setConfig = useAppStore(s => s.setConfig);

  const { sendData, historyUp, historyDown } = useSerialSend();
  const { toggleConnection } = useSerialConnection();
  const { isReplaying, startReplay, stopReplay } = useLogReplay(activeTabId ?? '');
  const [replaySpeed, setReplaySpeed] = useState(4);

  const activePort = useAppStore(s => s.ports.find(p => p.id === s.activeTabId));
  const isConnected = activePort?.status === 'connected';
  const isConnecting = activePort?.status === 'connecting';
  const isPortError = activePort?.status === 'error';
  const isPortActive = !!activeTabId;

  const activeCommands = sendCommandSets.find(s => s.id === activeSendCommandSetId)?.commands ?? [];

  // Cyclic send state machine (extracted to useCyclicSend hook)
  useCyclicSend({
    activeTabId,
    commands: activeCommands,
    isLooping: isLoopSending,
    isPortActive,
    isConnected,
    activeSendCommandSetId,
    sendData,
    setOpState,
  });

  const prevParamsRef = useRef(`${baudRate}-${dataBits}-${parity}-${stopBits}-${handshake}-${dtr}-${rts}`);

  // Sync serial params to backend when they change
  useEffect(() => {
    if (!activeTabId || !isConnected) return;
    const key = `${baudRate}-${dataBits}-${parity}-${stopBits}-${handshake}-${dtr}-${rts}`;
    if (key !== prevParamsRef.current) {
      prevParamsRef.current = key;
      serialService.setSerialParams(activeTabId, {
        baudRate,
        dataBits,
        parity,
        stopBits,
        handshake,
      }).catch(e => { console.debug('[OperationPanel] setSerialParams failed:', e); notifyError(e); });
      serialService.setFlowControl(activeTabId, dtr, rts).catch(e => { console.debug('[OperationPanel] setFlowControl failed:', e); notifyError(e); });
    }
  }, [activeTabId, isConnected, baudRate, dataBits, parity, stopBits, handshake, dtr, rts]);

  const toggleCollapse = () => {
    setUIState({ isOperationPanelCollapsed: !collapsed });
  };

  // ---- Connect button state (moved up from SendSection) ----
  const connectButtonLabel = isConnected
    ? t('sendSection.connectBtn.disconnect')
    : isConnecting
    ? t('sendSection.connectBtn.connecting')
    : isPortError
    ? t('sendSection.connectBtn.retry')
    : t('sendSection.connectBtn.open');
  const connectButtonDisabled = !isPortActive || isConnecting;
  const showAccent = isPortActive && !isConnected && !isConnecting;

  const handleToggleConnection = async () => {
    if (!activeTabId) return;
    await toggleConnection(activeTabId);
  };

  const handleClear = () => {
    if (activeTabId) clearTerminal(activeTabId);
  };

  // ---- Log handlers (moved up from the old view strip) ----
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

  const handleStartReplay = async () => {
    if (!activeTabId) return;
    const path = await open({ multiple: false, filters: [{ name: 'Log', extensions: ['log', 'txt'] }] });
    if (!path || typeof path !== 'string') return;
    await startReplay(path, replaySpeed);
  };

  return (
    <div
      className={`operation-panel${collapsed ? ' collapsed' : ''}`}
      style={!collapsed ? { height: panelHeight } : undefined}
    >
      <div
        className="operation-panel-header"
        title={t('operationPanel.collapse')}
        onClick={toggleCollapse}
      >
        <div className="operation-panel-header-group">
          <ChevronDown size={12} className="operation-panel-chevron" />
          <span className="operation-panel-title">{t('operationPanel.title')}</span>
          {isPortActive && (
            <span className="operation-panel-port">{activeTabId}</span>
          )}
        </div>
      </div>

      {!collapsed && (
        <>
          <div className="op-strip">
            <div className="op-strip-group">
              <button
                className={`btn btn-sm op-connect-btn${showAccent ? ' op-connect-accent' : ''}`}
                onClick={handleToggleConnection}
                disabled={connectButtonDisabled}
              >
                <Cable size={13} /> {connectButtonLabel}
              </button>
              <button className="btn btn-icon btn-sm" title={t('sendSection.clearButton')} onClick={handleClear} disabled={!isPortActive}>
                <Eraser size={14} />
              </button>
              <span className="toolbar-sep" />
              <select
                className="select op-replay-speed"
                value={replaySpeed}
                onChange={e => setReplaySpeed(Number(e.target.value))}
                title={t('terminal.replay.speedTooltip')}
                disabled={isReplaying || !isPortActive}
              >
                <option value={1}>1×</option>
                <option value={4}>4×</option>
                <option value={16}>16×</option>
                <option value={0}>{t('terminal.replay.speedMax')}</option>
              </select>
              <button
                className={`btn btn-icon btn-sm${isReplaying ? ' active' : ''}`}
                onClick={isReplaying ? stopReplay : handleStartReplay}
                disabled={!isPortActive}
                title={isReplaying ? t('terminal.replay.stop') : t('terminal.replay.start')}
              >
                {isReplaying ? <Square size={14} /> : <History size={14} />}
              </button>
              <span className="toolbar-sep" />
              <button className="btn btn-icon btn-sm" title={t('paramsSection.log.saveAs')} disabled={!isPortActive} onClick={handleSaveLogAs}><FileText size={14} /></button>
              <button className="btn btn-icon btn-sm" title={t('paramsSection.log.openFile')} disabled={!isPortActive} onClick={handleOpenLogFile}><FolderOpen size={14} /></button>
              <button className="btn btn-icon btn-sm" title={t('paramsSection.log.openDir')} onClick={handleOpenLogDir}><FileSearch size={14} /></button>
            </div>
            <div className="op-strip-group">
              <Type size={13} className="op-strip-icon" />
              <input type="range" className="op-strip-slider" min={8} max={48} step={1}
                value={terminalFontSize}
                onChange={e => setConfig({ terminalFontSize: Number(e.target.value) })} />
              <span className="op-strip-value">{terminalFontSize}px</span>
            </div>
          </div>
          <div className="operation-panel-content">
            <SendSection
              activeTabId={activeTabId}
              isPortActive={isPortActive}
              isConnected={isConnected}
              sendData={sendData}
              historyUp={historyUp}
              historyDown={historyDown}
            />
            <RulesSection isPortActive={isPortActive} isConnected={isConnected} />
            <ParamsSection isPortActive={isPortActive} />
          </div>
        </>
      )}
    </div>
  );
};

export default OperationPanel;
