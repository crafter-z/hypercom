/**
 * 共享顺序发送引擎（S-F1）——主窗循环发送（命令集）与弹窗文本模式逐行发送的唯一调度实现。
 *
 * 抽出来之前是两套各自生长的状态机（`OperationPanel/hooks/useCyclicSend.ts` 与
 * 弹窗的 `Popout/usePanelCyclicSend.ts`），递归 setTimeout 链 + 可见性补发 +
 * 重入防护被抄了两遍，且细节已经漂移（补发阈值 100ms vs 50ms、首次 tick 100ms
 * vs 0ms）。旧弹窗循环器已删除，文本模式改由 `Popout/QuickSendText.tsx` 直接
 * 使用本 hook。这里只保留**纯调度**：什么时候跑下一轮、被窗口隐藏节流后怎么补、
 * 什么时候停。「这一轮做了什么」（发命令集的一条 / 发文本区的一行）由调用方的
 * step 决定，两处语义因此互不干扰。
 *
 * 关键不变量（两处共用）：
 * 1. 任一次迭代最多在飞一个（`busy` 重入防护）——可见性补发与到期的定时器
 *    不得双触发，否则同一行会被发两次。
 * 2. 迭代开始时消费定时器句柄，使补发逻辑判定「已到期」为假。
 * 3. `stop()` 幂等，且 `onStop` 每次运行至多回调一次（弹窗靠它复位 running）。
 */
import { useEffect, useRef } from 'react';

/** 首次迭代延迟（ms）。首个 tick 与后续 tick 一样走计时器，避免同步递归。 */
export const SEND_LOOP_FIRST_TICK_MS = 100;

/**
 * 可见性补发阈值（ms）：窗口被遮挡时 WebView2 会把 setTimeout 链节流到 ~1s，
 * 恢复可见后若原定迭代已过期这么久仍未触发，立即补发一次把节奏拉回用户配置。
 * 阈值太小会把「计时器本来就要在几毫秒后触发」的正常情况误判为节流（重复发送）。
 */
export const SEND_LOOP_OVERDUE_MS = 100;

export interface SendLoopOptions {
  /**
   * 一次迭代：返回下一次迭代的延迟（ms），返回 `null` 结束循环。
   * 抛出的错误交给 `onStepError`（缺省 = 结束循环）。
   */
  step: () => Promise<number | null> | number | null;
  /** `step` 抛错时的决策：返回下一次延迟继续（重试），或 `null` 结束。 */
  onStepError?: (err: unknown) => number | null;
  /** 首次迭代延迟，默认 {@link SEND_LOOP_FIRST_TICK_MS}。 */
  firstTickMs?: number;
  /** 循环结束（自然结束或 `stop()`）时回调，每次运行至多一次。 */
  onStop?: () => void;
}

export interface SendLoop {
  /** 开始循环；已在运行 / 已结束时 no-op（结束后的再次调用可重新开始）。 */
  start(): void;
  /** 停止循环（幂等）。未运行时 no-op。 */
  stop(): void;
  isRunning(): boolean;
  /**
   * 可见性补发：已过期仍未触发的迭代立即执行。
   *
   * 引擎自身不碰 `document`——调用方（React hook 或每端口管理器）统一注册
   * `visibilitychange` 并转调本方法，这样调度逻辑保持纯函数式、可在 node
   * 环境下用假定时器直接测。
   */
  catchUpIfOverdue(): void;
}

/** 创建一个独立循环的调度器（每端口 / 每面板一个实例）。 */
export function createSendLoop(options: SendLoopOptions): SendLoop {
  const { step, onStepError, onStop } = options;
  const firstTickMs = options.firstTickMs ?? SEND_LOOP_FIRST_TICK_MS;

  let stopped = true; // start() 之前视为停止
  let busy = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let nextFireAt = 0;
  let onStopFired = false;

  const clearTimer = () => {
    if (timeoutId === null) return;
    clearTimeout(timeoutId);
    timeoutId = null;
  };

  /** 结束本次运行：清定时器 + 通知一次。之后 `start()` 可重新开始。 */
  const finish = () => {
    if (onStopFired) return;
    onStopFired = true;
    stopped = true;
    clearTimer();
    onStop?.();
  };

  const schedule = (delayMs: number) => {
    if (stopped) return;
    nextFireAt = Date.now() + delayMs;
    timeoutId = setTimeout(() => {
      void tick();
    }, delayMs);
  };

  const tick = async () => {
    if (stopped || busy) return;
    // 消费定时器句柄：可见性补发可能与本次迭代竞争，句柄置空后补发不再重复触发。
    clearTimer();
    busy = true;
    let nextDelay: number | null;
    try {
      nextDelay = await step();
    } catch (err) {
      nextDelay = onStepError ? onStepError(err) : null;
    } finally {
      busy = false;
    }
    if (stopped) return; // step 内部可能已 stop()（端口关闭 / 用户停止）
    if (nextDelay === null) {
      finish();
      return;
    }
    schedule(nextDelay);
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      onStopFired = false;
      schedule(firstTickMs);
    },
    stop() {
      if (stopped) return;
      finish();
    },
    isRunning() {
      return !stopped;
    },
    catchUpIfOverdue() {
      if (stopped || busy || timeoutId === null) return;
      if (Date.now() < nextFireAt + SEND_LOOP_OVERDUE_MS) return;
      clearTimer();
      void tick();
    },
  };
}

export interface UseSequentialSendOptions extends SendLoopOptions {
  /**
   * 运行中该值发生变化 → 自动停止（同一个引用比较）。
   * 弹窗文本模式靠它做「行索引与内容错位」保护：文本区被编辑后继续按旧索引
   * 发送会串行，宁可终止。主窗按端口循环不需要（命令集每轮实时重读）。
   */
  autoStopOnChange?: unknown;
}

export interface UseSequentialSendReturn {
  start(): void;
  stop(): void;
  isRunning(): boolean;
}

/**
 * 单循环 React 绑定：生命周期（卸载自停）+ 可见性补发 + 可选的变更自停。
 * 每一步做什么仍由 `step` 决定，所以弹窗文本模式与（单端口形态的）命令集循环
 * 共用同一套调度语义。
 */
export function useSequentialSend(options: UseSequentialSendOptions): UseSequentialSendReturn {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const loopRef = useRef<SendLoop | null>(null);
  if (loopRef.current === null) {
    loopRef.current = createSendLoop({
      firstTickMs: options.firstTickMs,
      step: () => optionsRef.current.step(),
      onStepError: (err) => optionsRef.current.onStepError?.(err) ?? null,
      onStop: () => optionsRef.current.onStop?.(),
    });
  }
  const loop = loopRef.current;

  // 运行中「内容基线」变化 → 自停。基线在每次 start() 时刷新。
  const changeBaselineRef = useRef<unknown>(options.autoStopOnChange);
  const autoStopOnChange = options.autoStopOnChange;
  useEffect(() => {
    if (!loop.isRunning()) {
      changeBaselineRef.current = autoStopOnChange;
      return;
    }
    if (changeBaselineRef.current !== autoStopOnChange) loop.stop();
    // loop 是稳定引用（ref 惰性初始化），不应进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStopOnChange]);

  // 焦点无关：窗口从隐藏/遮挡恢复可见时，若迭代已过期未触发则立刻补发。
  useEffect(() => {
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') {
      return;
    }
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      loop.catchUpIfOverdue();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [loop]);

  // 卸载：停止循环（不再触发任何回调外的副作用）。
  useEffect(() => () => loop.stop(), [loop]);

  return {
    start() {
      changeBaselineRef.current = optionsRef.current.autoStopOnChange;
      loop.start();
    },
    stop() {
      loop.stop();
    },
    isRunning() {
      return loop.isRunning();
    },
  };
}
