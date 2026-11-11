import { useCallback, useEffect, useRef } from 'react';
import { getActivePortId, useAppStore } from '../../../stores/useAppStore';
import { useOperationStore } from '../../../stores/useOperationStore';
import { useRuleStore } from '../../../stores/useRuleStore';
import { notifyError, useToastStore } from '../../../stores/useToastStore';
import { createSendLoop, type SendLoop, type SendLoopStepContext } from './useSequentialSend';
import type { SendCommand, SendCommandSet } from '../../../types';
import { orderedCommands } from '../../../utils/commandOrder';
import { serialService } from '../../../services/tauri';
import { sendToPort } from '../../../hooks/useSerialSend';
import {
  getCommandStepKind,
  isEnhancedCommandSet,
  validateCommandSetSteps,
} from '../../../utils/commandSteps';
import { advanceFlow } from '../../../utils/flowSchedule';
import {
  getFlowStatus,
  isFlowRunning,
  setFlowStatus,
  type FlowPhase,
} from '../../../utils/flowRuntime';

/** 目标端口暂不可用（未连接）时的重试间隔——循环不终止，等端口恢复。 */
const TARGET_WAIT_MS = 500;
/** 普通旧命令循环发送失败后的重试间隔。 */
const RETRY_MS = 500;

export interface UseCyclicSendOptions {
  sendData: (portId: string, data: string, isHex: boolean, lineEnding: string, silent?: boolean) => Promise<number>;
}

interface PortLoopState {
  commandSet: SendCommandSet;
  currentCmdIdx: number;
  completedRounds: number;
  notified: boolean;
  runId: string;
  enhanced: boolean;
  terminalPhase?: Extract<FlowPhase, 'completed' | 'stopped' | 'failed'>;
  /** 当前迭代是否仍在 await（发送 / 改参）——停止时据此决定端口是否可释放。 */
  inFlight: boolean;
  /** 用户已请求停止（终止阶段由在途迭代收尾后发布）。 */
  stopRequested: boolean;
}

function newRunId(portId: string): string {
  const uuid = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID() : `${portId}-${Date.now()}-${Math.random()}`;
  return `flow-${uuid}`;
}

function setStatus(portId: string, state: PortLoopState, phase: FlowPhase, detail?: string): void {
  if (!state.enhanced) return;
  setFlowStatus({
    portId,
    runId: state.runId,
    name: state.commandSet.name,
    phase,
    round: state.completedRounds + 1,
    totalRounds: state.commandSet.repeatCount > 0 ? state.commandSet.repeatCount : undefined,
    step: state.currentCmdIdx + 1,
    totalSteps: state.commandSet.commands.length,
    detail,
    exclusive: true,
  });
}

function currentPort(portId: string) {
  return useAppStore.getState().ports.find((port) => port.id === portId);
}

/**
 * Apply the MVP setParams step: only the baud rate is changed. Other serial
 * parameters remain the target port's confirmed values. Updating the port
 * metadata and the operation controls after the backend succeeds keeps the
 * sidebar, params panel and subsequent flow steps on the same value.
 */
async function applyParamsStep(portId: string, command: SendCommand, context: SendLoopStepContext): Promise<void> {
  const port = currentPort(portId);
  if (!port || port.status !== 'connected') throw new Error(`Port unavailable: ${portId}`);
  const operation = useOperationStore.getState();
  const baudRate = command.baudRate;
  if (!Number.isInteger(baudRate) || baudRate! < 1 || baudRate! > 4_000_000) {
    throw new Error('Invalid flow baud rate');
  }
  await serialService.setSerialParams(portId, {
    baudRate: baudRate!,
    dataBits: port.dataBits ?? operation.dataBits,
    parity: port.parity ?? operation.parity,
    stopBits: port.stopBits ?? operation.stopBits,
    handshake: port.handshake ?? operation.handshake,
  });
  if (!context.isCurrent()) return;
  useAppStore.getState().updatePort(portId, { baudRate: baudRate! });
  if (getActivePortId(useAppStore.getState()) === portId) {
    useOperationStore.getState().setOpState({ baudRate: baudRate! });
  }
}

export function useCyclicSend(options: UseCyclicSendOptions): void {
  const { sendData } = options;
  const sendDataRef = useRef(sendData);
  sendDataRef.current = sendData;

  const loopsRef = useRef<Map<string, SendLoop>>(new Map());
  const statesRef = useRef<Map<string, PortLoopState>>(new Map());

  const runStep = useCallback(async (portId: string, state: PortLoopState, context: SendLoopStepContext): Promise<number | null> => {
    const port = currentPort(portId);
    if (!port || port.status !== 'connected') return TARGET_WAIT_MS;

    const currentSet = state.commandSet;
    const cmd = currentSet.commands[state.currentCmdIdx];
    const kind = getCommandStepKind(cmd);
    if (kind === 'unknown') throw new Error('Unknown flow command step');

    if (kind === 'setParams') {
      setStatus(portId, state, 'applyingParams', `baud ${cmd.baudRate}`);
      await applyParamsStep(portId, cmd, context);
      if (!context.isCurrent()) return null;
    } else {
      setStatus(portId, state, 'running');
      // Legacy send commands intentionally retain the old semantics: a 0-byte
      // silent result does not advance the index, while thrown backend errors
      // are handled by the old retry callback.
      if (state.enhanced) {
        await sendToPort(portId, cmd.content, cmd.type === 'hex', cmd.appendLineEnding, true, undefined, 'flow');
      } else {
        await sendDataRef.current(portId, cmd.content, cmd.type === 'hex', cmd.appendLineEnding, true);
      }
      if (!context.isCurrent()) return null;
    }

    const schedule = advanceFlow({
      stepIndex: state.currentCmdIdx,
      stepCount: currentSet.commands.length,
      stepDelay: cmd.delay,
      loopDelay: currentSet.loopDelay,
      repeatCount: currentSet.repeatCount,
      isLoop: currentSet.isLoop,
      completedRounds: state.completedRounds,
    });
    state.completedRounds = schedule.completedRounds;
    if (schedule.kind === 'finish') {
      state.terminalPhase = 'completed';
      setStatus(portId, state, 'completed', 'done');
      useOperationStore.getState().setCyclicLoop(portId, false);
      return null;
    }
    state.currentCmdIdx = schedule.kind === 'continue' ? schedule.nextIndex : 0;
    // 「之后等待」由调度器的计时器承担：把它显示出来，用户看到的是
    // 「等待 200 ms」而不是一个没有任何反馈的黑盒；停止会直接清掉这个计时器。
    if (schedule.delayMs > 0) setStatus(portId, state, 'waiting', `${schedule.delayMs} ms`);
    return schedule.delayMs;
  }, []);

  /**
   * 迭代包装：登记在途状态。用户停止时，正在 await 的发送/改参不能立刻
   * 释放端口独占——先进入 `stopping`（仍独占），等这次迭代收尾后再发布终止态；
   * 否则手动发送可能与在途的参数切换交错。
   */
  const step = useCallback(async (portId: string, state: PortLoopState, context: SendLoopStepContext): Promise<number | null> => {
    state.inFlight = true;
    try {
      return await runStep(portId, state, context);
    } finally {
      state.inFlight = false;
      if (state.stopRequested && !state.terminalPhase) {
        state.terminalPhase = 'stopped';
        setStatus(portId, state, 'stopped', 'stopped by user');
      }
    }
  }, [runStep]);

  const stopLoop = useCallback((portId: string) => {
    const state = statesRef.current.get(portId);
    if (state && !state.terminalPhase) {
      state.stopRequested = true;
      if (state.inFlight) {
        // 在途操作（发送 / 参数应用）有界收尾，期间保持独占。
        setStatus(portId, state, 'stopping', 'stopping');
      } else {
        // 步骤之间的「之后等待」是调度器的计时器，`stop()` 会直接清掉它。
        state.terminalPhase = 'stopped';
        setStatus(portId, state, 'stopped', 'stopped by user');
      }
    }
    loopsRef.current.get(portId)?.stop();
  }, []);

  const startLoop = useCallback((portId: string) => {
    if (loopsRef.current.has(portId)) return;
    // A flow status is the shared runtime occupancy guard. This also prevents
    // a stale reconcile callback from starting a second loop on the same port.
    if (isFlowRunning(portId) || getFlowStatus(portId)?.phase === 'starting') {
      useOperationStore.getState().setCyclicLoop(portId, false);
      useToastStore.getState().push({ severity: 'warning', messageKey: 'flow.start.blocked', portId });
      return;
    }
    const rules = useRuleStore.getState();
    const saved = rules.sendCommandSets.find(set => set.id === rules.activeSendCommandSetId);
    if (!saved || saved.commands.length === 0) {
      useOperationStore.getState().setCyclicLoop(portId, false);
      return;
    }
    const validationError = validateCommandSetSteps(saved);
    if (validationError) {
      useOperationStore.getState().setCyclicLoop(portId, false);
      // `notifyError` 按原文显示 message——这里是 i18n key，必须走 messageKey 通道。
      useToastStore.getState().push({ severity: 'error', messageKey: validationError, portId });
      return;
    }
    const state: PortLoopState = {
      commandSet: { ...saved, commands: orderedCommands(saved.commands) },
      currentCmdIdx: 0,
      completedRounds: 0,
      notified: false,
      runId: newRunId(portId),
      enhanced: isEnhancedCommandSet(saved),
      inFlight: false,
      stopRequested: false,
    };
    statesRef.current.set(portId, state);
    setStatus(portId, state, state.enhanced ? 'starting' : 'running');
    const loop = createSendLoop({
      step: (context) => step(portId, state, context),
      onStepError: (err) => {
        console.warn('[useCyclicSend] Flow step failed:', err);
        if (!state.notified) {
          state.notified = true;
          notifyError(err);
        }
        if (state.enhanced) {
          state.terminalPhase = 'failed';
          setStatus(portId, state, 'failed', err instanceof Error ? err.message : String(err));
          useOperationStore.getState().setCyclicLoop(portId, false);
          return null;
        }
        // Preserve legacy retry behavior for old send-only command sets.
        return RETRY_MS;
      },
      onStop: () => {
        loopsRef.current.delete(portId);
        statesRef.current.delete(portId);
        // Keep terminal status visible to the UI. A newer run may already own
        // the port, so do not overwrite its status. While a step is still in
        // flight the wrapper's `finally` publishes the terminal phase instead —
        // otherwise the port lock would drop before the in-flight op settles.
        const status = getFlowStatus(portId);
        if (status?.runId === state.runId && !state.terminalPhase && !state.inFlight) {
          state.terminalPhase = 'stopped';
          setStatus(portId, state, 'stopped', 'stopped');
        }
      },
    });
    loopsRef.current.set(portId, loop);
    loop.start();
  }, [step, stopLoop]);

  useEffect(() => {
    const reconcile = (cyclicLoops: Record<string, boolean>) => {
      for (const [portId, running] of Object.entries(cyclicLoops)) {
        if (running) startLoop(portId);
      }
      for (const portId of [...loopsRef.current.keys()]) {
        if (!cyclicLoops[portId]) stopLoop(portId);
      }
    };
    const unsubscribe = useOperationStore.subscribe((state, previous) => {
      if (state.cyclicLoops !== previous.cyclicLoops) reconcile(state.cyclicLoops);
    });
    reconcile(useOperationStore.getState().cyclicLoops);
    return unsubscribe;
  }, [startLoop, stopLoop]);

  useEffect(() => {
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      for (const loop of loopsRef.current.values()) loop.catchUpIfOverdue();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  useEffect(() => {
    const loops = loopsRef.current;
    return () => {
      for (const [portId, loop] of [...loops.entries()]) {
        const state = statesRef.current.get(portId);
        if (state && !state.terminalPhase) {
          state.terminalPhase = 'stopped';
          setStatus(portId, state, 'stopped', 'owner unmounted');
        }
        loop.stop();
      }
    };
  }, []);
}
