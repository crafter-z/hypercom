import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getActivePortId, useAppStore } from '../../stores/useAppStore';
import { useSystemStore } from '../../stores/useSystemStore';
import { useOperationStore } from '../../stores/useOperationStore';
import { clearTerminal } from '../../utils/terminal/viewportManager';
import { useSerialSend, useSerialConnection } from '../../hooks';
import { serialService, logService } from '../../services/tauri';
import { notifyError, notifyInfo } from '../../stores/useToastStore';
import ReplayImportDialog from './ReplayImportDialog';
import ConfirmDialog from '../shared/ConfirmDialog';
import { ChevronDown, Cable, Eraser, Save, FolderOpen, FileSearch, History, Type, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import SendSection from './SendSection';
import ParamsSection from './ParamsSection';
import { useLogReplay } from '../MainDisplay/hooks/useLogReplay';
import { useCyclicSend } from './hooks/useCyclicSend';
import { getPluginViewState, isRawSerialDisplay, subscribePluginViewState } from '../../utils/pluginViewRuntime';
import { isFlowRunning, useFlowStatus } from '../../utils/flowRuntime';

export interface FlowRunningBadgeProps {
  /** 流程当前步骤（1-based）与总步数；缺失时只显示徽标文案。 */
  step?: number;
  totalSteps?: number;
  onStop: () => void;
}

/**
 * 折叠态流程徽标：操作面板收起后，运行中的增强流程在主窗里唯一的可见入口
 * 与停止入口（展开态由 `.op-flow-status` 状态条承担，两处不重复显示）。
 *
 * 必须定义在模块级——组件函数体内定义会让它在每帧重建（仓库硬规则）。
 * 停止按钮同时要 `stopPropagation`：`.operation-panel-header` 自身是
 * 「点一下展开/收起」的开关，否则停流程会顺带把面板展开。
 */
export function FlowRunningBadge({ step, totalSteps, onStop }: FlowRunningBadgeProps) {
  const { t } = useTranslation();
  return (
    <span className="op-flow-badge">
      <span className="op-flow-badge-dot" aria-hidden="true" />
      <span className="op-flow-badge-text">{t('operationPanel.flowBadge')}</span>
      {step !== undefined && totalSteps !== undefined && (
        <span className="op-flow-badge-step">{t('operationPanel.flowBadgeStep', { step, totalSteps })}</span>
      )}
      <button
        type="button"
        className="btn btn-icon btn-sm op-flow-badge-stop"
        title={t('operationPanel.flowStop')}
        aria-label={t('operationPanel.flowStop')}
        onClick={(event) => { event.stopPropagation(); onStop(); }}
      >
        <Square size={11} />
      </button>
    </span>
  );
}

const OperationPanel: React.FC = () => {
  const { t } = useTranslation();
  const activePortId = useAppStore(s => getActivePortId(s));
  const activeTab = useAppStore((state) => state.tabs.find((tab) => tab.id === state.activeTabId));
  useAppStore((state) => activeTab?.kind === 'serial' ? state.ports.find((port) => port.id === activeTab.portId)?.displayView : undefined);
  useSyncExternalStore(subscribePluginViewState, () => activeTab ? getPluginViewState(activeTab.id).status : null);
  const rawPortId = activeTab?.kind === 'serial' && isRawSerialDisplay(activeTab) ? activeTab.portId : null;
  const collapsed = useSystemStore(s => s.ui.isOperationPanelCollapsed);
  const panelHeight = useSystemStore(s => s.ui.operationPanelHeight);
  const [confirmClear, setConfirmClear] = useState(false);
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
  const replay = useLogReplay();

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

  // 折叠态流程徽标（只读订阅，不新增 store 状态）：收起后运行中的增强流程
  // 仍需在主窗可见、可停止。未运行时为 null / false，界面零变化。
  const flowStatus = useFlowStatus(activePortId);
  const flowRunning = isFlowRunning(activePortId);

  // 参数同步（issue #4-2）：记录「已应用参数」的所属端口与签名，用于区分
  // 「切换标签」与「参数变更」——切换标签时把该端口的已存参数载入操作面板；
  // 参数变更时实时应用到后端（已连接）+ 回写端口字段同步显示 + 供重连使用。
  const paramsSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAppliedRef = useRef<{ portId: string; frameKey: string; fullKey: string } | null>(null);
  // Keep a frame update pending across debounce cancellations (for example, a
  // DTR toggle immediately after changing baud rate must not swallow the frame
  // update whose timer was replaced).
  const pendingFrameSyncRef = useRef<string | null>(null);

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
      const loadedFrameKey = `${loaded.baudRate}-${loaded.dataBits}-${loaded.parity}-${loaded.stopBits}-${loaded.handshake}`;
      pendingFrameSyncRef.current = null;
      lastAppliedRef.current = {
        portId: activePortId,
        frameKey: loadedFrameKey,
        fullKey: `${loadedFrameKey}-${dtr}-${rts}`,
      };
      // DTR/RTS are global UI controls, but already-open ports may have been
      // opened before the global value changed. Re-apply the current control
      // lines when focusing a connected port so switching tabs cannot leave
      // the selected port with stale modem-line state.
      if (port?.status === 'connected' && port.type === 'real') {
        const expectedGeneration = port.connectionGeneration;
        paramsSyncTimerRef.current = setTimeout(() => {
          if (getActivePortId(useAppStore.getState()) !== activePortId || isFlowRunning(activePortId)) return;
          const current = useAppStore.getState().ports.find(item => item.id === activePortId);
          if (current?.status !== 'connected' || current.connectionGeneration !== expectedGeneration) return;
          serialService.setFlowControl(activePortId, dtr, rts, expectedGeneration).catch(e => {
            console.debug('[OperationPanel] setFlowControl failed:', e);
            notifyError(e);
          });
        }, 300);
      }
      return;
    }
    if (fullKey === lastAppliedRef.current.fullKey) {
      // Opening a port applies the current frame values in its OpenPortArgs.
      // Do not carry a disconnected-session debounce marker into the first
      // DTR/RTS-only change after reconnecting.
      if (isConnected) pendingFrameSyncRef.current = null;
      return;
    }

    // Flow/quick-command executors publish confirmed port metadata before
    // mirroring controls. Adopt that confirmation instead of sending the same
    // params again 300 ms later (which could overwrite a subsequent step).
    const confirmed = useAppStore.getState().ports.find(port => port.id === activePortId);
    // SIM/GIT:BASH ports do not expose real serial framing or modem-line
    // controls. Keep their operation state for a future real-port selection,
    // but never dispatch unsupported settings to the backend.
    if (confirmed?.type !== 'real') {
      pendingFrameSyncRef.current = null;
      return;
    }
    const confirmedFrameKey = `${confirmed.baudRate ?? baudRate}-${confirmed.dataBits ?? dataBits}-${confirmed.parity ?? parity}-${confirmed.stopBits ?? stopBits}-${confirmed.handshake ?? handshake}`;
    const flowControlUnchanged = lastAppliedRef.current.fullKey === `${lastAppliedRef.current.frameKey}-${dtr}-${rts}`;
    const framingUnchanged = lastAppliedRef.current.frameKey.endsWith(`-${dataBits}-${parity}-${stopBits}-${handshake}`);
    if (confirmed?.baudRate !== undefined && confirmedFrameKey === frameKey && framingUnchanged && flowControlUnchanged) {
      lastAppliedRef.current = { portId: activePortId, frameKey, fullKey };
      return;
    }

    // 帧参数变化 → 回写端口字段（侧边栏 / 标题栏同步显示；重连时 openPort 读到最新值）。
    // DTR/RTS 是独立的设备控制线；仅切换它们时不要重复提交整套帧参数，
    // 否则会和流控调用同时竞争后端串口句柄锁。
    const frameChanged = frameKey !== lastAppliedRef.current.frameKey;
    if (frameChanged) {
      pendingFrameSyncRef.current = frameKey;
      useAppStore.getState().updatePort(activePortId, { baudRate, dataBits, parity, stopBits, handshake });
    }
    lastAppliedRef.current = { portId: activePortId, frameKey, fullKey };

    // 已连接时实时应用（防抖 300ms 合并连续输入为一次后端调用）。
    if (!isConnected) return;
    const expectedGeneration = confirmed?.connectionGeneration;
    const frameSyncKey = pendingFrameSyncRef.current;
    paramsSyncTimerRef.current = setTimeout(() => {
      if (getActivePortId(useAppStore.getState()) !== activePortId || isFlowRunning(activePortId)) return;
      const port = useAppStore.getState().ports.find(item => item.id === activePortId);
      if (port?.status !== 'connected' || port.connectionGeneration !== expectedGeneration) return;
      if (frameSyncKey !== null) {
        serialService.setSerialParams(activePortId, {
          baudRate,
          dataBits,
          parity,
          stopBits,
          handshake,
          expectedGeneration,
        }).then(() => {
          if (pendingFrameSyncRef.current === frameSyncKey) pendingFrameSyncRef.current = null;
        }).catch(e => { console.debug('[OperationPanel] setSerialParams failed:', e); notifyError(e); });
      }
      serialService.setFlowControl(activePortId, dtr, rts, expectedGeneration).catch(e => { console.debug('[OperationPanel] setFlowControl failed:', e); notifyError(e); });
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
    if (tab?.kind === 'serial' && isRawSerialDisplay(tab)) setConfirmClear(true);
  };

  const doClear = () => {
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
      await logService.pickAndSaveLog(portId, {
        title: t('paramsSection.saveDialog.title'),
        defaultFileName: `${portId}.log`,
        filters: [{ name: t('paramsSection.saveDialog.filterName'), extensions: ['log', 'txt'] }],
      });
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

  const handleStartReplay = async () => { try { await replay.startImport(); } catch (error) { notifyError(error); } };

  return (
    <div
      className={`operation-panel${collapsed ? ' collapsed' : ''}`}
      style={!collapsed ? { height: panelHeight } : undefined}
    >
      {replay.picked && <ReplayImportDialog picked={replay.picked} busy={replay.isImporting} onConfirm={replay.confirmImport} onCancel={replay.cancelImport} />}
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
        {/* 收起后才显示：展开态已有 `.op-flow-status` 状态条，不重复。 */}
        {collapsed && flowRunning && flowStatus && (
          <FlowRunningBadge
            step={flowStatus.step}
            totalSteps={flowStatus.totalSteps}
            onStop={() => useOperationStore.getState().setCyclicLoop(flowStatus.portId, false)}
          />
        )}
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
              <button className="btn btn-icon btn-sm" onClick={handleStartReplay} disabled={replay.isPicking || replay.isImporting} title={t('replay.import')}><History size={14} /></button>
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
      <ConfirmDialog
        open={confirmClear}
        title={t('operationPanel.clearTitle')}
        message={t('operationPanel.clearMessage')}
        confirmLabel={t('confirmDialog.confirm')}
        cancelLabel={t('confirmDialog.cancel')}
        danger
        onConfirm={() => { setConfirmClear(false); doClear(); }}
        onCancel={() => setConfirmClear(false)}
      />
    </div>
  );
};

export default OperationPanel;
