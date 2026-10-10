import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getActivePortId, useAppStore } from '../../stores/useAppStore';
import { useSystemStore } from '../../stores/useSystemStore';
import { useOperationStore } from '../../stores/useOperationStore';
import { clearTerminal } from '../../utils/terminal/viewportManager';
import { useSerialSend, useSerialConnection } from '../../hooks';
import { serialService, logService } from '../../services/tauri';
import { notifyError, notifyInfo } from '../../stores/useToastStore';
import { open, save } from '@tauri-apps/plugin-dialog';
import { ChevronDown, Cable, Eraser, Save, FolderOpen, FileSearch, History, Square, Type } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import SendSection from './SendSection';
import ParamsSection from './ParamsSection';
import { useLogReplay } from '../MainDisplay/hooks/useLogReplay';
import { useCyclicSend } from './hooks/useCyclicSend';
import { getPluginViewState, isRawSerialDisplay, subscribePluginViewState } from '../../utils/pluginViewRuntime';

const OperationPanel: React.FC = () => {
  const { t } = useTranslation();
  const activePortId = useAppStore(s => getActivePortId(s));
  const activeTab = useAppStore((state) => state.tabs.find((tab) => tab.id === state.activeTabId));
  useAppStore((state) => activeTab?.kind === 'serial' ? state.ports.find((port) => port.id === activeTab.portId)?.displayView : undefined);
  useSyncExternalStore(subscribePluginViewState, () => activeTab ? getPluginViewState(activeTab.id).status : null);
  const rawPortId = activeTab?.kind === 'serial' && isRawSerialDisplay(activeTab) ? activeTab.portId : null;
  const collapsed = useSystemStore(s => s.ui.isOperationPanelCollapsed);
  const panelHeight = useSystemStore(s => s.ui.operationPanelHeight);
  const dataBits = useOperationStore(s => s.dataBits);
  const parity = useOperationStore(s => s.parity);
  const stopBits = useOperationStore(s => s.stopBits);
  const handshake = useOperationStore(s => s.handshake);
  const dtr = useOperationStore(s => s.dtr);
  const rts = useOperationStore(s => s.rts);
  // 订阅 baudRate：自定义输入走 ParamsSection 本地 draft，opStore.baudRate 仅在
  // 预设选择 / 输入框失焦提交时更新，订阅不会在逐键输入时重渲染面板。
  const baudRate = useOperationStore(s => s.baudRate);
  const setUIState = useSystemStore(s => s.setUIState);
  const terminalFontSize = useAppStore(s => s.config.terminalFontSize);
  const setConfig = useAppStore(s => s.setConfig);

  const { sendData, historyUp, historyDown } = useSerialSend();
  const { toggleConnection } = useSerialConnection();
  const { isReplaying, startReplay, stopReplay } = useLogReplay(rawPortId ?? '');
  const [replaySpeed, setReplaySpeed] = useState(4);

  // 拆成两个原语选择器（zustand Object.is 比较）——`ports.find(...)` 每次返回
  // 新对象引用，会随 3s 端口轮询/状态更新无条件重渲染整个面板。状态位足够
  // 驱动按钮态，需要具体端口时用 getState() 现取。
  const activePortStatus = useAppStore((state) => {
    const portId = getActivePortId(state);
    return state.ports.find((port) => port.id === portId)?.status;
  });
  const isConnected = activePortStatus === 'connected';
  const isConnecting = activePortStatus === 'connecting';
  const isPortError = activePortStatus === 'error';
  const isPortActive = !!activePortId;

  // 每端口独立循环发送引擎（issue #12）：目标端口由 hook 内部绑定——在哪个
  // 端口上启动就持续发给它，切换标签/窗口聚焦不影响已在运行的循环；运行标志
  // 存 useOperationStore.cyclicLoops（每端口 Record），SendSection 按钮按当前
  // 聚焦端口查询状态。
  useCyclicSend({ sendData });

  // 参数同步（issue #4-2）：记录「已应用参数」的所属端口与签名，用于区分
  // 「切换标签」与「参数变更」——切换标签时把该端口的已存参数载入操作面板；
  // 参数变更时实时应用到后端（已连接）+ 回写端口字段同步显示 + 供重连使用。
  const paramsSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAppliedRef = useRef<{ portId: string; frameKey: string } | null>(null);

  useEffect(() => {
    if (paramsSyncTimerRef.current) {
      clearTimeout(paramsSyncTimerRef.current);
      paramsSyncTimerRef.current = null;
    }
    if (!activePortId) return;
    const frameKey = `${baudRate}-${dataBits}-${parity}-${stopBits}-${handshake}`;
    const fullKey = `${frameKey}-${dtr}-${rts}`;

    // 切换标签：把目标端口的已存帧参数载入操作面板（dtr/rts 为全局态，不载入）。
    // 端口无已存参数时保留当前操作面板值作为默认工作集。
    if (lastAppliedRef.current?.portId !== activePortId) {
      const port = useAppStore.getState().ports.find((p) => p.id === activePortId);
      const loaded = {
        baudRate: port?.baudRate ?? baudRate,
        dataBits: port?.dataBits ?? dataBits,
        parity: port?.parity ?? parity,
        stopBits: port?.stopBits ?? stopBits,
        handshake: port?.handshake ?? handshake,
      };
      useOperationStore.getState().setOpState(loaded);
      lastAppliedRef.current = {
        portId: activePortId,
        frameKey: `${loaded.baudRate}-${loaded.dataBits}-${loaded.parity}-${loaded.stopBits}-${loaded.handshake}`,
      };
      return;
    }
    if (fullKey === `${lastAppliedRef.current.frameKey}-${dtr}-${rts}`) return;

    // 帧参数变化 → 回写端口字段（侧边栏 / 标题栏同步显示；重连时 openPort 读到最新值）。
    if (frameKey !== lastAppliedRef.current.frameKey) {
      lastAppliedRef.current = { portId: activePortId, frameKey };
      useAppStore.getState().updatePort(activePortId, { baudRate, dataBits, parity, stopBits, handshake });
    }

    // 已连接时实时应用（防抖 300ms 合并连续输入为一次后端调用）。
    if (!isConnected) return;
    paramsSyncTimerRef.current = setTimeout(() => {
      if (getActivePortId(useAppStore.getState()) !== activePortId) return;
      serialService.setSerialParams(activePortId, {
        baudRate,
        dataBits,
        parity,
        stopBits,
        handshake,
      }).catch(e => { console.debug('[OperationPanel] setSerialParams failed:', e); notifyError(e); });
      serialService.setFlowControl(activePortId, dtr, rts).catch(e => { console.debug('[OperationPanel] setFlowControl failed:', e); notifyError(e); });
    }, 300);
  }, [activePortId, isConnected, baudRate, dataBits, parity, stopBits, handshake, dtr, rts]);

  useEffect(() => () => {
    clearTimeout(paramsSyncTimerRef.current ?? undefined);
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
    const portId = getActivePortId(useAppStore.getState());
    if (portId) await toggleConnection(portId);
  };

  const handleClear = () => {
    const state = useAppStore.getState();
    const tab = state.tabs.find((item) => item.id === state.activeTabId);
    if (tab?.kind === 'serial' && isRawSerialDisplay(tab)) clearTerminal(tab.portId);
  };

  // ---- Log handlers (moved up from the old view strip) ----
  const handleSaveLogAs = async () => {
    const state = useAppStore.getState();
    const tab = state.tabs.find((item) => item.id === state.activeTabId);
    if (tab?.kind !== 'serial' || !isRawSerialDisplay(tab)) return;
    const portId = tab.portId;
    try {
      const filePath = await save({
        title: t('paramsSection.saveDialog.title'),
        defaultPath: `${portId}.log`,
        filters: [{ name: t('paramsSection.saveDialog.filterName'), extensions: ['log', 'txt'] }],
      });
      const current = useAppStore.getState();
      const currentTab = current.tabs.find((item) => item.id === current.activeTabId);
      if (filePath && currentTab?.id === tab.id && isRawSerialDisplay(currentTab)) await logService.saveLogAs(portId, filePath);
    } catch (e) { console.error('Failed to save log:', e); notifyError(e); }
  };

  const handleOpenLogFile = async () => {
    if (!activePortId) return;
    try {
      const files = await logService.getLogFiles();
      const candidates = files.filter(f => f.portId === activePortId);
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
    if (!rawPortId) return;
    const path = await open({ multiple: false, filters: [{ name: 'Log', extensions: ['log', 'txt'] }] });
    if (!path || typeof path !== 'string') return;
    const state = useAppStore.getState();
    const tab = state.tabs.find((item) => item.id === state.activeTabId);
    if (tab?.kind !== 'serial' || tab.portId !== rawPortId || !isRawSerialDisplay(tab)) return;
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
            <span className="operation-panel-port">{activePortId}</span>
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
              <button className="btn btn-icon btn-sm" title={t('sendSection.clearButton')} onClick={handleClear} disabled={!rawPortId}>
                <Eraser size={14} />
              </button>
              <span className="toolbar-sep" />
              <select
                className="select op-replay-speed"
                value={replaySpeed}
                onChange={e => setReplaySpeed(Number(e.target.value))}
                title={t('terminal.replay.speedTooltip')}
                disabled={isReplaying || !rawPortId}
              >
                <option value={1}>1×</option>
                <option value={4}>4×</option>
                <option value={16}>16×</option>
                <option value={0}>{t('terminal.replay.speedMax')}</option>
              </select>
              <button
                className={`btn btn-icon btn-sm${isReplaying ? ' active' : ''}`}
                onClick={isReplaying ? stopReplay : handleStartReplay}
                disabled={!rawPortId}
                title={isReplaying ? t('terminal.replay.stop') : t('terminal.replay.start')}
              >
                {isReplaying ? <Square size={14} /> : <History size={14} />}
              </button>
              <span className="toolbar-sep" />
              <button className="btn btn-icon btn-sm" title={t('paramsSection.log.saveAs')} disabled={!rawPortId} onClick={handleSaveLogAs}><Save size={14} /></button>
              <button className="btn btn-icon btn-sm" title={t('paramsSection.log.openFile')} disabled={!isPortActive} onClick={handleOpenLogFile}><FileSearch size={14} /></button>
              <button className="btn btn-icon btn-sm" title={t('paramsSection.log.openDir')} onClick={handleOpenLogDir}><FolderOpen size={14} /></button>
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
              activePortId={activePortId}
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
