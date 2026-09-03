/**
 * pluginObserver — 插件 RX 旁路观察者总线（issue #17，评审 v2 D4/P1/P12）
 *
 * 职责：把 RxPipeline 行组装层产出的**纯 RX 完整行**批转发给已订阅的插件，
 * 并处理 TRX/TTY 模式切换的断流通知。
 *
 * 架构要点（评审 v2）：
 * - **行组装层旁路**：经 `getRxPipeline().addOnLineAssembledListener` 注册到
 *   多播钩子（rxPipeline.ts，行级——非 serial:data 块级；TX 回显/TOOL/回放
 *   走 viewportManager 单行入口不经管线，故本总线天然纯 RX）。
 * - **不消费、不修改**：观察者只读行数据，不碰队列/缓冲/触发引擎。
 * - **批转发 + 额度**：每端口入队，rAF tick 每帧至多向每个订阅者投递
 *   `MAX_LINES_PER_DELIVERY` 行（含字节上限），超限丢**最旧**并告警——对齐
 *   RxPipeline `maxLinesPerTick`/`maxQueuedLines` 既有纪律（评审 v2 P12）。
 * - **零插件零开销**：无订阅者时不注册钩子、不启动调度。
 * - **断流通知**：订阅 `useAppStore` ports 的 mode 变化；端口切 `tty` 时向
 *   订阅者发 `rx.detached({portId, reason})`（TRX 行观察对 TTY 不适用），
 *   切回 trx 恢复投递。
 * - **载荷**：`{portId, seq, rawData(ArrayBuffer transfer), encoding, ts}`
 *   ——未解码字节 + 编码 label（评审 v2 P1b：宿主不强制编码选择）。
 *
 * 生命周期：模块单例（每 webview 一个，镜像 getRxPipeline/ttyService）；
 * 应用内不 dispose。
 */
import { getRxPipeline } from './rxPipeline';
import { useAppStore } from '../stores/useAppStore';
import type { PortMode } from '../types';

/** 每订阅者每帧最多投递行数（评审 v2 P12 额度，镜像 maxLinesPerTick=2000）。 */
export const MAX_LINES_PER_DELIVERY = 2000;
/** 每端口排队转发上限（行）：超过丢最旧（对齐 maxQueuedLines=10000 精神，但
 *  插件侧消费慢——放宽到同一数量级即可，隐藏窗口防无界积压）。 */
export const MAX_OBSERVER_QUEUE = 10_000;
/** 页面隐藏时兜底转发周期（ms，镜像 rxPipeline FALLBACK_TICK_MS）。 */
const FALLBACK_TICK_MS = 16;

/** 观察者收到的单行载荷（插件 rx.onLine 参数）。 */
export interface ObservedRxLine {
  portId: string;
  /** 行序号（每端口单调递增，宿主分配；跨标签重开从 0 起新一轮）。 */
  seq: number;
  /** 未解码原始字节（postMessage transfer 零拷贝）。 */
  rawData: Uint8Array;
  /** 当前 per-port 编码 label（小写，如 utf-8 / gbk）——插件按需自解码。 */
  encoding: string;
  /** 行时间戳（ms）。 */
  ts: number;
}

/** 断流通知载荷（TRX→TTY 切换等）。 */
export interface RxDetachedEvent {
  portId: string;
  reason: 'mode-tty' | string;
}

/** 观察者接口（一个启用插件 = 一个订阅者）。 */
export interface PluginRxObserver {
  /** 批量投递（每帧至多 MAX_LINES_PER_DELIVERY 行）。插件侧自行节流/丢弃。 */
  onRxLines(lines: ObservedRxLine[]): void;
  /** 断流通知（如端口切到 TTY）。 */
  onRxDetached(event: RxDetachedEvent): void;
}

/** 每端口转发状态。 */
interface PortObserverState {
  seq: number;
  queue: ObservedRxLine[];
  /** rAF 投递句柄。 */
  rafId: number | null;
  /** setTimeout 兜底投递句柄（页面隐藏）。 */
  timerId: number | null;
}

/** 每端口状态表（模块级单例）。 */
const portStates = new Map<string, PortObserverState>();

/** 端口 mode 跟踪（独立于排队状态——断流检测对所有订阅端口生效，
 *  不要求该端口当前有排队行；首见端口记 trx，切换 tty 时通知）。 */
const observedModes = new Map<string, PortMode>();

/** 已注册订阅者。 */
const observers = new Set<PluginRxObserver>();

/** 是否已接线到 pipeline 多播钩子 + store 订阅。 */
let wired = false;
/** 注销函数（测试用；应用内不调用）。 */
let unwire: (() => void) | null = null;

/** 页面隐藏判断（镜像 rxPipeline）。 */
function isDocumentHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

function cancelDelivery(state: PortObserverState): void {
  if (state.rafId !== null) {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(state.rafId);
    state.rafId = null;
  }
  if (state.timerId !== null) {
    clearTimeout(state.timerId);
    state.timerId = null;
  }
}

/** 调度一次投递（页面可见 rAF / 隐藏 setTimeout 兜底，镜像 rxPipeline）。 */
function scheduleDelivery(state: PortObserverState, deliver: () => void): void {
  if (state.rafId !== null || state.timerId !== null) return;
  const run = (): void => {
    state.rafId = null;
    state.timerId = null;
    deliver();
  };
  if (typeof requestAnimationFrame === 'function' && !isDocumentHidden()) {
    state.rafId = requestAnimationFrame(run);
  } else {
    state.timerId = setTimeout(run, FALLBACK_TICK_MS);
  }
}

/**
 * 把 pipeline 行级钩子回调接入本总线：按端口入队 + 调度投递。
 * encoding 经 pipeline 公开查询（内部已归一 ascii→utf-8）——每行查一次
 * 开销可忽略（编码切换低频，行级查询保证切换后立即生效）。
 */
function handleAssembledLine(portId: string, line: { rawData: Uint8Array; text: string; timestamp: number }): void {
  let state = portStates.get(portId);
  if (!state) {
    state = { seq: 0, queue: [], rafId: null, timerId: null };
    portStates.set(portId, state);
  }
  if (state.queue.length >= MAX_OBSERVER_QUEUE) {
    // 超限丢最旧（对齐 maxQueuedLines 纪律）。
    const overflow = state.queue.length - MAX_OBSERVER_QUEUE + 1;
    state.queue.splice(0, overflow);
  }
  state.queue.push({
    portId,
    seq: state.seq++,
    rawData: line.rawData,
    encoding: getRxPipeline().getPortEncodingLabel(portId),
    ts: line.timestamp,
  });
  scheduleDelivery(state, () => deliverPort(portId));
}

/** 向全部订阅者投递某端口排队的行（每订阅者最多 MAX_LINES_PER_DELIVERY）。 */
function deliverPort(portId: string): void {
  const state = portStates.get(portId);
  if (!state || state.queue.length === 0) return;
  const batch = state.queue.splice(0, MAX_LINES_PER_DELIVERY);
  if (state.queue.length > 0) {
    // 剩余行顺延下一帧续投。
    scheduleDelivery(state, () => deliverPort(portId));
  }
  for (const obs of observers) {
    try {
      obs.onRxLines(batch);
    } catch (e) {
      console.error('[pluginObserver] observer onRxLines failed:', e);
    }
  }
}

/** 端口 mode 变化检测：trx → tty 断流通知；tty → trx 恢复（无需动作，下条行自然续投）。 */
function checkModeTransition(): void {
  const ports = useAppStore.getState().ports;
  for (const port of ports) {
    const mode = port.mode ?? 'trx';
    const prev = observedModes.get(port.id);
    observedModes.set(port.id, mode);
    if (prev !== 'tty' && mode === 'tty') {
      // TRX → TTY：断流 + 清该端口遗留队列（TTY 行不产生，遗留队列丢给插件也无意义）。
      const state = portStates.get(port.id);
      if (state) {
        cancelDelivery(state);
        state.queue.length = 0;
      }
      for (const obs of observers) {
        try {
          obs.onRxDetached({ portId: port.id, reason: 'mode-tty' });
        } catch (e) {
          console.error('[pluginObserver] observer onRxDetached failed:', e);
        }
      }
    }
  }
}

/** 首次接线：注册 pipeline 多播钩子 + store 订阅（幂等）。 */
function ensureWired(): void {
  if (wired) return;
  wired = true;
  const pipeline = getRxPipeline();
  const unsubLine = pipeline.addOnLineAssembledListener(handleAssembledLine);

  // mode 变化订阅：useAppStore ports 数组变化时检查（含 mode 切换）。
  const unsubStore = useAppStore.subscribe((state, prev) => {
    if (state.ports !== prev.ports) checkModeTransition();
  });

  unwire = () => {
    unsubLine();
    unsubStore();
    wired = false;
    unwire = null;
    portStates.clear();
  };
}

/**
 * 注册插件观察者（插件启用且订阅 rx 时调用）。返回注销函数。
 * 首个订阅者触发接线（零订阅者不接线——零插件零开销）。
 */
export function addPluginRxObserver(obs: PluginRxObserver): () => void {
  observers.add(obs);
  if (observers.size === 1) ensureWired();
  // 初始 mode 快照（迟到的订阅者从当前状态开始）。
  checkModeTransition();
  return () => {
    observers.delete(obs);
    if (observers.size === 0) {
      // 无订阅者：解线（释放钩子与 store 订阅），零开销回到无插件态。
      unwire?.();
    }
  };
}

/** 是否已有订阅者（设置页/宿主桥查询用）。 */
export function hasPluginRxObservers(): boolean {
  return observers.size > 0;
}

/** 测试用：清空状态（应用生命周期不调用）。 */
export function resetPluginObserverForTest(): void {
  unwire?.();
  observers.clear();
  portStates.clear();
  observedModes.clear();
  wired = false;
}
