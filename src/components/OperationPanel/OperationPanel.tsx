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
import ParamsSection from './ParamsSection';
import { useLogReplay } from '../MainDisplay/hooks/useLogReplay';
import { useCyclicSend } from './hooks/useCyclicSend';

const OperationPanel: React.FC = () => {
  const { t } = useTranslation();
  const activeTabId = useAppStore(s => s.activeTabId);
  const collapsed = useAppStore(s => s.ui.isOperationPanelCollapsed);
  const panelHeight = useAppStore(s => s.ui.operationPanelHeight);
  const dataBits = useOperationStore(s => s.dataBits);
  const parity = useOperationStore(s => s.parity);
  const stopBits = useOperationStore(s => s.stopBits);
  const handshake = useOperationStore(s => s.handshake);
  const dtr = useOperationStore(s => s.dtr);
  const rts = useOperationStore(s => s.rts);
  // 订阅 baudRate：自定义输入走 ParamsSection 本地 draft，opStore.baudRate 仅在
  // 预设选择 / 输入框失焦提交时更新，订阅不会在逐键输入时重渲染面板。
  const baudRate = useOperationStore(s => s.baudRate);
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

  // 参数同步（issue #4-2）：记录「已应用参数」的所属端口与签名，用于区分
  // 「切换标签」与「参数变更」——切换标签时把该端口的已存参数载入操作面板；
  // 参数变更时实时应用到后端（已连接）+ 回写端口字段同步显示 + 供重连使用。
  const paramsSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAppliedRef = useRef<{ portId: string; frameKey: string } | null>(null);

  useEffect(() => {
    if (!activeTabId) return;
    const frameKey = `${baudRate}-${dataBits}-${parity}-${stopBits}-${handshake}`;
    const fullKey = `${frameKey}-${dtr}-${rts}`;

    // 切换标签：把目标端口的已存帧参数载入操作面板（dtr/rts 为全局态，不载入）。
    // 端口无已存参数时保留当前操作面板值作为默认工作集。
    if (lastAppliedRef.current?.portId !== activeTabId) {
      const port = useAppStore.getState().ports.find((p) => p.id === activeTabId);
      const loaded = {
        baudRate: port?.baudRate ?? baudRate,
        dataBits: port?.dataBits ?? dataBits,
        parity: port?.parity ?? parity,
        stopBits: port?.stopBits ?? stopBits,
        handshake: port?.handshake ?? handshake,
      };
      useOperationStore.getState().setOpState(loaded);
      lastAppliedRef.current = {
        portId: activeTabId,
        frameKey: `${loaded.baudRate}-${loaded.dataBits}-${loaded.parity}-${loaded.stopBits}-${loaded.handshake}`,
      };
      return;
    }
    if (fullKey === `${lastAppliedRef.current.frameKey}-${dtr}-${rts}`) return;

    // 帧参数变化 → 回写端口字段（侧边栏 / 标题栏同步显示；重连时 openPort 读到最新值）。
    if (frameKey !== lastAppliedRef.current.frameKey) {
      lastAppliedRef.current = { portId: activeTabId, frameKey };
      useAppStore.getState().updatePort(activeTabId, { baudRate, dataBits, parity, stopBits, handshake });
    }

    // 已连接时实时应用（防抖 300ms 合并连续输入为一次后端调用）。
    if (!isConnected) return;
    if (paramsSyncTimerRef.current) clearTimeout(paramsSyncTimerRef.current);
    paramsSyncTimerRef.current = setTimeout(() => {
      serialService.setSerialParams(activeTabId, {
        baudRate,
        dataBits,
        parity,
        stopBits,
        handshake,
      }).catch(e => { console.debug('[OperationPanel] setSerialParams failed:', e); notifyError(e); });
      serialService.setFlowControl(activeTabId, dtr, rts).catch(e => { console.debug('[OperationPanel] setFlowControl failed:', e); notifyError(e); });
    }, 300);
  }, [activeTabId, isConnected, baudRate, dataBits, parity, stopBits, handshake, dtr, rts]);

  useEffect(() => () => {
    if (paramsSyncTimerRef.current) clearTimeout(paramsSyncTimerRef.current);
  }, []);

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
            <ParamsSection isPortActive={isPortActive} />
          </div>
        </>
      )}
    </div>
  );
};

export default OperationPanel;
