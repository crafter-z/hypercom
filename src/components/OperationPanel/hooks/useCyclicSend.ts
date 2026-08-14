import { useCallback, useEffect, useRef } from 'react';
import { useAppStore } from '../../../stores/useAppStore';
import { useOperationStore } from '../../../stores/useOperationStore';
import { useRuleStore } from '../../../stores/useRuleStore';
import { notifyError } from '../../../stores/useToastStore';

/** 目标端口暂不可用（未连接）时的重试间隔——循环不终止，等端口恢复。 */
const TARGET_WAIT_MS = 500;

/** 首次 tick 延迟（ms） */
const FIRST_TICK_MS = 100;

/** 窗口恢复可见时的立即补发阈值：距上次调度已过这么久仍未触发（WebView2 隐藏时
 *  会把 setTimeout 链节流到 ~1s），说明被节流了——恢复可见立刻补一 tick。 */
const OVERDUE_THRESHOLD_MS = 100;

export interface UseCyclicSendOptions {
  sendData: (portId: string, data: string, isHex: boolean, lineEnding: string, silent?: boolean) => Promise<number>;
}

/** 单个端口循环的运行态（端口固定、聚焦无关） */
interface LoopRuntime {
  portId: string;
  timeoutId: ReturnType<typeof setTimeout> | null;
  /** 下一 tick 的预期触发时间（防止隐藏窗口节流后节奏漂移） */
  nextTickAt: number;
  currentCmdIdx: number;
  completedRounds: number;
  stopped: boolean;
  /** tick 正在执行（await sendData 中）——防可见性补发与定时器双触发 */
  sending: boolean;
  /** 本运行周期是否已弹过错误 toast（重试不刷屏） */
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
 * - 多端口可并行：每个 runtime 独立的递归 setTimeout 链，互不干扰。
 * - 每 tick 实时读取活动命令集（useRuleStore.getState()），命令集编辑即时生效；
 *   命令集缺失/为空时自动停止该端口循环。
 * - 目标端口未连接时跳过 tick 并不推进索引（等端口恢复自动续发）。
 * - 可见性补发：窗口被遮挡恢复可见后，已到期的 tick 立即补发（与 rxPipeline
 *   的 visibility-aware 模式对齐）。
 */
export function useCyclicSend(options: UseCyclicSendOptions): void {
  const { sendData } = options;
  const sendDataRef = useRef(sendData);
  sendDataRef.current = sendData;

  const runtimesRef = useRef<Map<string, LoopRuntime>>(new Map());
  const cyclicLoops = useOperationStore((s) => s.cyclicLoops);

  const tick = useCallback(async (portId: string) => {
    const rt = runtimesRef.current.get(portId);
    if (!rt || rt.stopped || rt.sending) return;
    // 消费已到期的定时器句柄：可见性补发可能与本次 tick 竞争，句柄置空后
    // 补发逻辑不再重复触发（double-send 防护）。
    if (rt.timeoutId !== null) {
      clearTimeout(rt.timeoutId);
      rt.timeoutId = null;
    }
    rt.sending = true;
    try {
      // 目标端口读取（端口固定、非活动标签）：端口不可用时跳过本次 tick
      // 并不推进索引，等下一轮重试——不终止循环（切聚焦/短暂断开皆不中断）。
      const port = useAppStore.getState().ports.find((p) => p.id === portId);
      if (!port || port.status !== 'connected') {
        rt.nextTickAt = Date.now() + TARGET_WAIT_MS;
        rt.timeoutId = setTimeout(() => void tick(portId), TARGET_WAIT_MS);
        return;
      }

      // Re-read from store for freshness (same as original behaviour).
      const store = useRuleStore.getState();
      const currentSet = store.sendCommandSets.find((s) => s.id === store.activeSendCommandSetId);
      if (!currentSet || currentSet.commands.length === 0) {
        // 命令集缺失/为空：该端口循环没有可发内容，自动停止。
        useOperationStore.getState().setCyclicLoop(portId, false);
        return;
      }
      const cmd = currentSet.commands[rt.currentCmdIdx % currentSet.commands.length];

      try {
        await sendDataRef.current(
          portId,
          cmd.content,
          cmd.type === 'hex',
          cmd.appendLineEnding,
          true, // silent — failures are aggregated below, not toasted per-send
        );
      } catch (err) {
        console.warn('[useCyclicSend] Cyclic send failed:', err);
        if (!rt.notified) {
          rt.notified = true;
          notifyError(err);
        }
        rt.nextTickAt = Date.now() + 500;
        if (!rt.stopped) {
          rt.timeoutId = setTimeout(() => void tick(portId), 500);
        }
        return;
      }

      // 重复轮数优先：>0 时发送 N 轮后停止（覆盖命令集 isLoop）；
      // 0 时跟随命令集 isLoop（无限循环或单轮）。
      // 重复轮数为每命令集自有配置（repeatCount），不再是全局操作态。
      const loopRepeatCount = currentSet.repeatCount ?? 0;
      // 轮次边界用「是否本轮最后一条」判定，而非 `nextIdx >= length`：
      // currentCmdIdx 持续自增、从不归零会让后者在第一轮之后恒为真，
      // 导致第二轮起每条命令都误用 loopDelay（用户配置的 per-command
      // delay 失效）、且 completedRounds 按「条」而非「轮」累加 → 提前停发。
      const isLastInRound = rt.currentCmdIdx === currentSet.commands.length - 1;
      let nextDelay = cmd.delay ?? 0;
      if (isLastInRound) {
        rt.completedRounds += 1;
        const reachedLimit = loopRepeatCount > 0
          ? rt.completedRounds >= loopRepeatCount
          : !currentSet.isLoop;
        if (reachedLimit) {
          // 本端口循环自然结束：清运行标志，按钮回到「开始循环」。
          useOperationStore.getState().setCyclicLoop(portId, false);
          return;
        }
        // 轮间间隔用 loopDelay，索引归零进入下一轮（轮内仍用 per-command delay）。
        nextDelay = currentSet.loopDelay ?? 0;
        rt.currentCmdIdx = 0;
      } else {
        rt.currentCmdIdx += 1;
      }

      rt.nextTickAt = Date.now() + nextDelay;
      if (!rt.stopped) {
        rt.timeoutId = setTimeout(() => void tick(portId), nextDelay);
      }
    } finally {
      rt.sending = false;
    }
  }, []);

  const stopRuntime = useCallback((portId: string) => {
    const rt = runtimesRef.current.get(portId);
    if (!rt) return;
    rt.stopped = true;
    if (rt.timeoutId !== null) {
      clearTimeout(rt.timeoutId);
      rt.timeoutId = null;
    }
    runtimesRef.current.delete(portId);
  }, []);

  const startRuntime = useCallback((portId: string) => {
    if (runtimesRef.current.has(portId)) return;
    const rt: LoopRuntime = {
      portId,
      timeoutId: null,
      nextTickAt: 0,
      currentCmdIdx: 0,
      completedRounds: 0,
      stopped: false,
      sending: false,
      notified: false,
    };
    runtimesRef.current.set(portId, rt);
    rt.nextTickAt = Date.now() + FIRST_TICK_MS;
    rt.timeoutId = setTimeout(() => void tick(portId), FIRST_TICK_MS);
  }, [tick]);

  // 运行开关（cyclicLoops）与 runtime 的同步：开启的端口没有 runtime → 启动；
  // 已有 runtime 的端口开关被关/移除 → 停止。reconcile 幂等，重复执行无害。
  useEffect(() => {
    for (const [portId, running] of Object.entries(cyclicLoops)) {
      if (running) startRuntime(portId);
    }
    for (const portId of runtimesRef.current.keys()) {
      if (!cyclicLoops[portId]) stopRuntime(portId);
    }
  }, [cyclicLoops, startRuntime, stopRuntime]);

  // 焦点无关（可见性补发，issue #12）：窗口从隐藏/遮挡恢复可见时，若任意
  // 端口循环的 tick 已到期却尚未触发（隐藏窗口节流 setTimeout 链），立刻补发。
  useEffect(() => {
    const onVisibilityChange = () => {
      if (typeof document === 'undefined' || document.visibilityState !== 'visible') return;
      for (const rt of runtimesRef.current.values()) {
        if (rt.stopped || rt.sending) continue;
        if (rt.timeoutId !== null && Date.now() >= rt.nextTickAt + OVERDUE_THRESHOLD_MS) {
          clearTimeout(rt.timeoutId);
          rt.timeoutId = null;
          void tick(rt.portId);
        }
      }
    };
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
    return () => {
      if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    };
  }, [tick]);

  // 卸载：停止全部端口循环（主窗 OperationPanel 常驻，正常不会卸载）。
  useEffect(() => {
    const runtimes = runtimesRef.current;
    return () => {
      for (const portId of [...runtimes.keys()]) {
        stopRuntime(portId);
      }
    };
  }, [stopRuntime]);
}