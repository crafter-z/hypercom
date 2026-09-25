import { useCallback, useEffect, useRef } from 'react';
import { useAppStore } from '../../../stores/useAppStore';
import { useOperationStore } from '../../../stores/useOperationStore';
import { useRuleStore } from '../../../stores/useRuleStore';
import { notifyError } from '../../../stores/useToastStore';
import { createSendLoop, type SendLoop } from './useSequentialSend';

/** 目标端口暂不可用（未连接）时的重试间隔——循环不终止，等端口恢复。 */
const TARGET_WAIT_MS = 500;

/** 单次发送失败后的重试间隔（与端口等待同量级：一次失败不刷屏，按节奏重试）。 */
const RETRY_MS = 500;

export interface UseCyclicSendOptions {
  sendData: (portId: string, data: string, isHex: boolean, lineEnding: string, silent?: boolean) => Promise<number>;
}

/** 单个端口循环的运行态（端口固定、聚焦无关）。 */
interface PortLoopState {
  currentCmdIdx: number;
  completedRounds: number;
  /** 本次运行是否已弹过错误 toast（重试不刷屏）。 */
  notified: boolean;
}

/**
 * 每端口独立循环发送引擎（issue #12 → 每端口同步语义）。
 *
 * 「在一个串口点循环发送后，就要一直在这串口发到结束或手动停止」：
 * - 每个端口一个 runtime，目标端口**永远绑定启动它的端口**——不跟随活动标签、
 *   不受窗口/标签聚焦切换影响。COM3 启动循环后切到 COM4，COM3 继续发。
 * - 运行开关来自 `useOperationStore.cyclicLoops[portId]`（Record），SendSection
 *   的按钮按**当前聚焦端口**查状态——切回 COM3 时按钮自然变回「停止」。
 * - 多端口可并行：每个 runtime 独立的循环，互不干扰。
 * - 每 tick 实时读取活动命令集（useRuleStore.getState()），命令集编辑即时生效；
 *   命令集缺失/为空时自动停止该端口循环。
 * - 目标端口未连接时跳过 tick 并不推进索引（等端口恢复自动续发）。
 * - 调度本身（计时器链 / 重入防护 / 可见性补发）来自共享引擎
 *   `useSequentialSend.createSendLoop`，与弹窗文本模式逐行发送同一实现。
 */
export function useCyclicSend(options: UseCyclicSendOptions): void {
  const { sendData } = options;
  const sendDataRef = useRef(sendData);
  sendDataRef.current = sendData;

  const loopsRef = useRef<Map<string, SendLoop>>(new Map());
  const statesRef = useRef<Map<string, PortLoopState>>(new Map());
  const cyclicLoops = useOperationStore((s) => s.cyclicLoops);

  /** 一个端口的一轮：返回下一次延迟，或 null 结束该端口循环。 */
  const step = useCallback(async (portId: string, state: PortLoopState): Promise<number | null> => {
    // 目标端口读取（端口固定、非活动标签）：端口不可用时跳过本次 tick
    // 并不推进索引，等下一轮重试——不终止循环（切聚焦/短暂断开皆不中断）。
    const port = useAppStore.getState().ports.find((p) => p.id === portId);
    if (!port || port.status !== 'connected') return TARGET_WAIT_MS;

    // Re-read from store for freshness (same as original behaviour).
    const store = useRuleStore.getState();
    const currentSet = store.sendCommandSets.find((s) => s.id === store.activeSendCommandSetId);
    if (!currentSet || currentSet.commands.length === 0) {
      // 命令集缺失/为空：该端口循环没有可发内容，自动停止。
      useOperationStore.getState().setCyclicLoop(portId, false);
      return null;
    }
    const cmd = currentSet.commands[state.currentCmdIdx % currentSet.commands.length];

    // silent：失败时由共享引擎的 onStepError 聚合为一条 toast，逐次发送不刷屏。
    await sendDataRef.current(portId, cmd.content, cmd.type === 'hex', cmd.appendLineEnding, true);

    // 重复轮数优先：>0 时发送 N 轮后停止（覆盖命令集 isLoop）；
    // 0 时跟随命令集 isLoop（无限循环或单轮）。
    // 重复轮数为每命令集自有配置（repeatCount），不再是全局操作态。
    const loopRepeatCount = currentSet.repeatCount ?? 0;
    // 轮次边界用「是否本轮最后一条」判定，而非 `nextIdx >= length`：
    // currentCmdIdx 持续自增、从不归零会让后者在第一轮之后恒为真，
    // 导致第二轮起每条命令都误用 loopDelay（用户配置的 per-command
    // delay 失效）、且 completedRounds 按「条」而非「轮」累加 → 提前停发。
    const isLastInRound = state.currentCmdIdx === currentSet.commands.length - 1;
    if (!isLastInRound) {
      state.currentCmdIdx += 1;
      return cmd.delay ?? 0;
    }
    state.completedRounds += 1;
    const reachedLimit = loopRepeatCount > 0
      ? state.completedRounds >= loopRepeatCount
      : !currentSet.isLoop;
    if (reachedLimit) {
      // 本端口循环自然结束：清运行标志，按钮回到「开始循环」。
      useOperationStore.getState().setCyclicLoop(portId, false);
      return null;
    }
    // 轮间间隔用 loopDelay，索引归零进入下一轮（轮内仍用 per-command delay）。
    state.currentCmdIdx = 0;
    return currentSet.loopDelay ?? 0;
  }, []);

  const stopLoop = useCallback((portId: string) => {
    loopsRef.current.get(portId)?.stop();
  }, []);

  const startLoop = useCallback((portId: string) => {
    if (loopsRef.current.has(portId)) return;
    const state: PortLoopState = { currentCmdIdx: 0, completedRounds: 0, notified: false };
    statesRef.current.set(portId, state);
    const loop = createSendLoop({
      step: () => step(portId, state),
      onStepError: (err) => {
        console.warn('[useCyclicSend] Cyclic send failed:', err);
        if (!state.notified) {
          state.notified = true;
          notifyError(err);
        }
        // 失败重试：不推进索引、不终止循环，交给下一次迭代。
        return RETRY_MS;
      },
      onStop: () => {
        loopsRef.current.delete(portId);
        statesRef.current.delete(portId);
      },
    });
    loopsRef.current.set(portId, loop);
    loop.start();
  }, [step]);

  // 运行开关（cyclicLoops）与 runtime 的同步：开启的端口没有 runtime → 启动；
  // 已有 runtime 的端口开关被关/移除 → 停止。reconcile 幂等，重复执行无害。
  useEffect(() => {
    for (const [portId, running] of Object.entries(cyclicLoops)) {
      if (running) startLoop(portId);
    }
    // 快照键：stopLoop 的 onStop 会从 map 里删除条目，边遍历边删容易漏项。
    for (const portId of [...loopsRef.current.keys()]) {
      if (!cyclicLoops[portId]) stopLoop(portId);
    }
  }, [cyclicLoops, startLoop, stopLoop]);

  // 焦点无关（可见性补发，issue #12）：窗口从隐藏/遮挡恢复可见时，若任意
  // 端口循环的 tick 已到期却尚未触发（隐藏窗口节流 setTimeout 链），立刻补发。
  useEffect(() => {
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') {
      return;
    }
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      for (const loop of loopsRef.current.values()) loop.catchUpIfOverdue();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  // 卸载：停止全部端口循环（主窗 OperationPanel 常驻，正常不会卸载）。
  useEffect(() => {
    const loops = loopsRef.current;
    return () => {
      for (const loop of [...loops.values()]) loop.stop();
    };
  }, []);
}
