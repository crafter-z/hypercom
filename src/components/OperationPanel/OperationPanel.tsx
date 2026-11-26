import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { getActivePortId, useAppStore } from '../../stores/useAppStore';
import { useSystemStore } from '../../stores/useSystemStore';
import { useOperationStore, type ControlLines } from '../../stores/useOperationStore';
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
import { useCyclicStatus } from './hooks/cyclicRuntime';
import { getPluginViewState, isRawSerialDisplay, subscribePluginViewState } from '../../utils/pluginViewRuntime';
import { isFlowRunning, useFlowStatus } from '../../utils/flowRuntime';
import type { DataBits, Handshake, Parity, StopBits } from '../../types';

interface FrameParams {
  baudRate: number;
  dataBits: DataBits;
  parity: Parity;
  stopBits: StopBits;
  handshake: Handshake;
}

function makeFrameKey(frame: FrameParams): string {
  return `${frame.baudRate}-${frame.dataBits}-${frame.parity}-${frame.stopBits}-${frame.handshake}`;
}

function makeControlKey(control: ControlLines): string {
  return `${control.dtr}-${control.rts}`;
}

export interface FlowRunningBadgeProps {
  /** 流程当前步骤（1-based）与总步数；缺失时只显示徽标文案。 */
  step?: number;
  totalSteps?: number;
  /** 可选自定义徽标文案（缺省为增强流程文案）。 */
  label?: string;
  /** 可选停止按钮提示/无障碍标签（缺省为停止流程）。 */
  stopLabel?: string;
  onStop: () => void;
}

/**
 * 折叠态流程徽标：操作面板收起后，运行中的增强流程或普通循环在主窗里唯一的可见入口
 * 与停止入口（展开态由 `.op-flow-status` 状态条承担，两处不重复显示）。
 *
 * 必须定义在模块级——组件函数体内定义会让它在每帧重建（仓库硬规则）。
 * 停止按钮同时要 `stopPropagation`：避免事件冒泡触发外层点击。
 */
export function FlowRunningBadge({ step, totalSteps, label, stopLabel, onStop }: FlowRunningBadgeProps) {
  const { t } = useTranslation();
  const resolvedLabel = label ?? t('operationPanel.flowBadge');
  const resolvedStopLabel = stopLabel ?? t('operationPanel.flowStop');
  return (
    <span className="op-flow-badge">
      <span className="op-flow-badge-dot" aria-hidden="true" />
      <span className="op-flow-badge-text">{resolvedLabel}</span>
      {step !== undefined && totalSteps !== undefined && (
        <span className="op-flow-badge-step">{t('operationPanel.flowBadgeStep', { step, totalSteps })}</span>
      )}
      <button
        type="button"
        className="btn btn-icon btn-sm op-flow-badge-stop"
        title={resolvedStopLabel}
        aria-label={resolvedStopLabel}
        onClick={(event) => { event.stopPropagation(); onStop(); }}
      >
        <Square size={11} />
      </button>
    </span>
  );
}

interface BackgroundLoopsBadgeProps {
  portIds: string[];
  onStopAll: () => void;
}

/** 折叠态后台端口循环徽标：其他非当前聚焦端口仍在循环发送时的可见提示与停止入口。 */
function BackgroundLoopsBadge({ portIds, onStopAll }: BackgroundLoopsBadgeProps) {
  const { t } = useTranslation();
  const label = portIds.length === 1
    ? t('operationPanel.bgLoopSingle', { port: portIds[0] })
    : t('operationPanel.bgLoopCount', { count: portIds.length });
  const stopLabel = portIds.length === 1
    ? t('operationPanel.stopPortLoop', { port: portIds[0] })
    : t('operationPanel.stopAllBgLoops');
  return (
    <FlowRunningBadge
      label={label}
      stopLabel={stopLabel}
      onStop={onStopAll}
    />
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
  const [clearTarget, setClearTarget] = useState<{ tabId: string; portId: string } | null>(null);
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
  const activePortIsReal = useAppStore((state) => {
    const portId = getActivePortId(state);
    return state.ports.find((port) => port.id === portId)?.type === 'real';
  });
  const cyclicLoops = useOperationStore((s) => s.cyclicLoops);
  const isConnected = activePortStatus === 'connected';
  const isConnecting = activePortStatus === 'connecting';
  const isPortError = activePortStatus === 'error';
  const isPortActive = !!activePortId;

  // 每端口独立循环发送引擎（issue #12）：目标端口由 hook 内部绑定——在哪个
  // 端口上启动就持续发给它，切换标签/窗口聚焦不影响已在运行的循环；运行标志
  // 存 useOperationStore.cyclicLoops（每端口 Record），SendSection 按钮按当前
  // 聚焦端口查询状态。
  useCyclicSend({ sendData });

  // 折叠态流程徽标（只读订阅，不新增 store 状态）：收起后运行中的增强流程与普通循环
  // 仍需在主窗可见、可停止。未运行时为 null / false，界面零变化。
  const flowStatus = useFlowStatus(activePortId);
  const flowRunning = isFlowRunning(activePortId);
  const activeCyclicStatus = useCyclicStatus(activePortId);
  const activePlainLoopRunning = !flowRunning && !!activePortId && !!cyclicLoops[activePortId];
  const backgroundLoopPortIds = useMemo(
    () => Object.keys(cyclicLoops).filter((id) => cyclicLoops[id] && id !== activePortId),
    [cyclicLoops, activePortId],
  );

  // 参数同步（issue #4-2）：记录「已应用参数」的所属端口、帧参数与每端口 DTR/RTS 控制线，
  // 区分「切换标签」与「用户手动修改」——切换标签只载入该端口已存参数与控制线，绝不静默
  // 下发 setFlowControl；仅当用户实际修改帧参数或控制线时才防抖 300ms 应用到后端，失败回滚。
  const paramsSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAppliedRef = useRef<{
    portId: string;
    frame: FrameParams;
    control: ControlLines;
    frameKey: string;
    controlKey: string;
    fullKey: string;
  } | null>(null);
  const confirmedFrameBaselineRef = useRef<FrameParams | null>(null);
  const confirmedControlBaselineRef = useRef<ControlLines | null>(null);
  // Keep frame and control updates independently pending across debounce cancellations
  // (e.g., toggling DTR immediately after changing baud rate dispatches both without
  // swallowing the first timer).
  const pendingFrameSyncRef = useRef<string | null>(null);
  const pendingControlSyncRef = useRef<string | null>(null);

  useEffect(() => {
    if (paramsSyncTimerRef.current) {
      clearTimeout(paramsSyncTimerRef.current);
      paramsSyncTimerRef.current = null;
    }
    if (!activePortId) return;
    const currentFrame: FrameParams = { baudRate, dataBits, parity, stopBits, handshake };
    const currentControl: ControlLines = { dtr, rts };
    const frameKey = makeFrameKey(currentFrame);
    const controlKey = makeControlKey(currentControl);
    const fullKey = `${frameKey}-${controlKey}`;

    // 切换标签：载入目标端口已存帧参数与每端口 DTR/RTS 状态，不触发后端 setFlowControl。
    if (lastAppliedRef.current?.portId !== activePortId) {
      const port = useAppStore.getState().ports.find((p) => p.id === activePortId);
      const opState = useOperationStore.getState();
      const loadedFrame: FrameParams = {
        baudRate: port?.baudRate ?? baudRate,
        dataBits: port?.dataBits ?? dataBits,
        parity: port?.parity ?? parity,
        stopBits: port?.stopBits ?? stopBits,
        handshake: port?.handshake ?? handshake,
      };
      const savedControl = opState.portControlLines[activePortId];
      // Initial mount preserves pre-existing store dtr/rts; subsequent tab switches
      // to an unconfigured port default cleanly to false/false without side effects.
      const loadedControl: ControlLines = savedControl
        ?? (lastAppliedRef.current === null ? { dtr, rts } : { dtr: false, rts: false });
      opState.setOpState({ ...loadedFrame, dtr: loadedControl.dtr, rts: loadedControl.rts });
      if (!savedControl) opState.setPortControlLines(activePortId, loadedControl);
      const loadedFrameKey = makeFrameKey(loadedFrame);
      const loadedControlKey = makeControlKey(loadedControl);
      pendingFrameSyncRef.current = null;
      pendingControlSyncRef.current = null;
      confirmedFrameBaselineRef.current = loadedFrame;
      confirmedControlBaselineRef.current = loadedControl;
      lastAppliedRef.current = {
        portId: activePortId,
        frame: loadedFrame,
        control: loadedControl,
        frameKey: loadedFrameKey,
        controlKey: loadedControlKey,
        fullKey: `${loadedFrameKey}-${loadedControlKey}`,
      };
      return;
    }
    if (fullKey === lastAppliedRef.current.fullKey) {
      // Opening a port applies the current frame values in its OpenPortArgs.
      // Do not carry a disconnected-session debounce marker into the first
      // DTR/RTS-only change after reconnecting.
      if (isConnected) {
        pendingFrameSyncRef.current = null;
        pendingControlSyncRef.current = null;
        confirmedFrameBaselineRef.current = currentFrame;
        confirmedControlBaselineRef.current = currentControl;
      }
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
      pendingControlSyncRef.current = null;
      return;
    }
    const confirmedFrameKey = `${confirmed.baudRate ?? baudRate}-${confirmed.dataBits ?? dataBits}-${confirmed.parity ?? parity}-${confirmed.stopBits ?? stopBits}-${confirmed.handshake ?? handshake}`;
    const flowControlUnchanged = controlKey === lastAppliedRef.current.controlKey;
    const framingUnchanged = lastAppliedRef.current.frameKey.endsWith(`-${dataBits}-${parity}-${stopBits}-${handshake}`);
    if (confirmed?.baudRate !== undefined && confirmedFrameKey === frameKey && framingUnchanged && flowControlUnchanged) {
      confirmedFrameBaselineRef.current = currentFrame;
      lastAppliedRef.current = {
        portId: activePortId,
        frame: currentFrame,
        control: currentControl,
        frameKey,
        controlKey,
        fullKey,
      };
      return;
    }

    // 帧参数变化 → 回写端口字段（侧边栏 / 标题栏同步显示；重连时 openPort 读到最新值）。
    // DTR/RTS 是独立的每端口控制线；仅切换它们时不重复提交整套帧参数。
    const frameChanged = frameKey !== lastAppliedRef.current.frameKey;
    const controlChanged = controlKey !== lastAppliedRef.current.controlKey;
    if (frameChanged) {
      if (pendingFrameSyncRef.current === null) {
        confirmedFrameBaselineRef.current = lastAppliedRef.current.frame;
      }
      pendingFrameSyncRef.current = frameKey;
      useAppStore.getState().updatePort(activePortId, currentFrame);
    }
    if (controlChanged) {
      if (pendingControlSyncRef.current === null) {
        confirmedControlBaselineRef.current = lastAppliedRef.current.control;
      }
      pendingControlSyncRef.current = controlKey;
      useOperationStore.getState().setPortControlLines(activePortId, currentControl);
    }
    lastAppliedRef.current = {
      portId: activePortId,
      frame: currentFrame,
      control: currentControl,
      frameKey,
      controlKey,
      fullKey,
    };

    // 已连接时实时应用（防抖 300ms 合并连续输入为一次后端调用）。
    if (!isConnected) return;
    const expectedGeneration = confirmed?.connectionGeneration;
    const frameSyncKey = pendingFrameSyncRef.current;
    const controlSyncKey = pendingControlSyncRef.current;
    const rollbackFrame = confirmedFrameBaselineRef.current;
    const rollbackControl = confirmedControlBaselineRef.current;
    if (frameSyncKey === null && controlSyncKey === null) return;

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
          if (pendingFrameSyncRef.current === frameSyncKey) {
            pendingFrameSyncRef.current = null;
            confirmedFrameBaselineRef.current = currentFrame;
          }
        }).catch(e => {
          console.debug('[OperationPanel] setSerialParams failed:', e);
          notifyError(e);
          // Roll back optimistic framing params if no newer edit superseded this request.
          if (rollbackFrame && pendingFrameSyncRef.current === frameSyncKey) {
            const latestPort = useAppStore.getState().ports.find(item => item.id === activePortId);
            if (latestPort?.connectionGeneration === expectedGeneration) {
              pendingFrameSyncRef.current = null;
              useAppStore.getState().updatePort(activePortId, rollbackFrame);
              if (getActivePortId(useAppStore.getState()) === activePortId && lastAppliedRef.current?.portId === activePortId) {
                const rbFrameKey = makeFrameKey(rollbackFrame);
                const curCtrl = lastAppliedRef.current.control;
                const curCtrlKey = lastAppliedRef.current.controlKey;
                lastAppliedRef.current = {
                  portId: activePortId,
                  frame: rollbackFrame,
                  control: curCtrl,
                  frameKey: rbFrameKey,
                  controlKey: curCtrlKey,
                  fullKey: `${rbFrameKey}-${curCtrlKey}`,
                };
                useOperationStore.getState().setOpState(rollbackFrame);
              }
            }
          }
        });
      }
      if (controlSyncKey !== null) {
        serialService.setFlowControl(activePortId, dtr, rts, expectedGeneration).then(() => {
          if (pendingControlSyncRef.current === controlSyncKey) {
            pendingControlSyncRef.current = null;
            confirmedControlBaselineRef.current = currentControl;
          }
        }).catch(e => {
          console.debug('[OperationPanel] setFlowControl failed:', e);
          notifyError(e);
          if (rollbackControl && pendingControlSyncRef.current === controlSyncKey) {
            const latestPort = useAppStore.getState().ports.find(item => item.id === activePortId);
            if (latestPort?.connectionGeneration === expectedGeneration) {
              pendingControlSyncRef.current = null;
              useOperationStore.getState().setPortControlLines(activePortId, rollbackControl);
              if (getActivePortId(useAppStore.getState()) === activePortId && lastAppliedRef.current?.portId === activePortId) {
                const rbCtrlKey = makeControlKey(rollbackControl);
                const curFrame = lastAppliedRef.current.frame;
                const curFrameKey = lastAppliedRef.current.frameKey;
                lastAppliedRef.current = {
                  portId: activePortId,
                  frame: curFrame,
                  control: rollbackControl,
                  frameKey: curFrameKey,
                  controlKey: rbCtrlKey,
                  fullKey: `${curFrameKey}-${rbCtrlKey}`,
                };
                useOperationStore.getState().setOpState(rollbackControl);
              }
            }
          }
        });
      }
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
    if (tab?.kind === 'serial' && isRawSerialDisplay(tab)) setClearTarget({ tabId: tab.id, portId: tab.portId });
  };

  const doClear = () => {
    const target = clearTarget;
    setClearTarget(null);
    if (!target) return;
    // A confirmation owns the original workspace tab, not a later focus or a
    // same-port replacement opened after that tab was closed.
    const tab = useAppStore.getState().tabs.find(item => item.id === target.tabId);
    if (tab?.kind === 'serial' && tab.portId === target.portId && isRawSerialDisplay(tab)) clearTerminal(target.portId);
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
      <div className="operation-panel-header">
        <button
          type="button"
          className="operation-panel-header-group operation-panel-header-toggle"
          aria-expanded={!collapsed}
          title={collapsed ? t('operationPanel.expand') : t('operationPanel.collapse')}
          onClick={toggleCollapse}
        >
          <ChevronDown size={12} className="operation-panel-chevron" />
          <span className="operation-panel-title">{t('operationPanel.title')}</span>
          {isPortActive && (
            <span
              className="operation-panel-port"
              title={activePortIsReal ? `${activePortId} · ${t('paramsSection.baudRateLabel')} ${baudRate}` : activePortId}
            >
              {collapsed && (
                <span
                  className={`operation-panel-port-dot${isConnected ? ' is-connected' : isPortError ? ' is-error' : ''}`}
                  aria-hidden="true"
                />
              )}
              <span className="operation-panel-port-name">{activePortId}</span>
              {activePortIsReal && (
                <span className="operation-panel-port-meta">{t('paramsSection.baudRateLabel')} {baudRate}</span>
              )}
            </span>
          )}
        </button>
        {/* 收起后才显示：展开态已有 `.op-flow-status` 状态条，不重复。 */}
        {collapsed && (flowRunning && flowStatus || activePlainLoopRunning || backgroundLoopPortIds.length > 0) && (
          <div className="operation-panel-header-badges">
            {flowRunning && flowStatus && (
              <FlowRunningBadge
                step={flowStatus.step}
                totalSteps={flowStatus.totalSteps}
                onStop={() => useOperationStore.getState().setCyclicLoop(flowStatus.portId, false)}
              />
            )}
            {activePlainLoopRunning && activePortId && (
              <FlowRunningBadge
                label={activeCyclicStatus?.waitingReconnect ? t('flow.status.waitingReconnect') : t('operationPanel.cyclicBadge')}
                step={activeCyclicStatus?.step}
                totalSteps={activeCyclicStatus?.totalSteps}
                stopLabel={t('rulesSection.stopLoop')}
                onStop={() => useOperationStore.getState().setCyclicLoop(activePortId, false)}
              />
            )}
            {backgroundLoopPortIds.length > 0 && (
              <BackgroundLoopsBadge
                portIds={backgroundLoopPortIds}
                onStopAll={() => {
                  const op = useOperationStore.getState();
                  for (const id of backgroundLoopPortIds) op.setCyclicLoop(id, false);
                }}
              />
            )}
          </div>
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
              <input
                type="range"
                className="op-strip-slider"
                min={8}
                max={48}
                step={1}
                aria-label={t('operationPanel.fontSize')}
                title={t('operationPanel.fontSize')}
                value={terminalFontSize}
                onChange={e => setConfig({ terminalFontSize: Number(e.target.value) })}
              />
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
        open={clearTarget !== null}
        title={t('operationPanel.clearTitle')}
        message={t('operationPanel.clearMessage')}
        confirmLabel={t('confirmDialog.confirm')}
        cancelLabel={t('confirmDialog.cancel')}
        danger
        onConfirm={doClear}
        onCancel={() => setClearTarget(null)}
      />
    </div>
  );
};

export default OperationPanel;
