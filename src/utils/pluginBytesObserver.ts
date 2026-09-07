/**
 * pluginBytesObserver — 插件 RX 原始字节旁路观察者总线（issue #17 能力补强）
 *
 * 与 pluginObserver（行旁路）互补：行旁路在 RxPipeline 行组装层（rx.onLine），
 * 字节旁路在 **serial:data 事件层**（rx.onBytes）——早于 TTY 分流 / 协议解析 /
 * 行组装，看到**原始字节流**，不受端口 mode（trx/tty）影响。用于把串口原始
 * 数据共享给第三方（HTTP 推送）。
 *
 * 馈入点：useSerialReceive 的 onSerialData 回调最顶部（trafficStats 之后，
 * 任何分流之前）调用 `feedPluginBytes`。零订阅者时该调用是 O(1) no-op
 * （observers.size 检查），零插件零开销。
 *
 * 批投递：每端口排队 + rAF/隐藏 setTimeout 兜底调度（镜像 pluginObserver），
 * 每帧至多 MAX_BYTES_PER_DELIVERY 字节，超过丢最旧——插件消费慢时防无界积压。
 */

/** 每订阅者每帧最多投递字节数（对齐 maxLinesPerTick 用量纪律的字节版）。 */
export const MAX_BYTES_PER_DELIVERY = 256 * 1024;
/** 每端口排队字节上限（超过丢最旧；对齐 maxQueuedLines 精神）。 */
export const MAX_OBSERVER_QUEUE_BYTES = 1024 * 1024;
/** 页面隐藏时兜底转发周期（ms，镜像 rxPipeline FALLBACK_TICK_MS）。 */
const FALLBACK_TICK_MS = 16;

/** 观察者收到的一个字节块（原始未解码）。 */
export interface ObservedRxBytes {
  portId: string;
  /** 原始字节（未解码；一次 serial:data 事件的 payload）。 */
  bytes: Uint8Array;
  /** 事件时间戳（ms）。 */
  ts: number;
}

/** 观察者接口（一个启用且授予 rx:bytes 的插件 = 一个订阅者）。 */
export interface PluginBytesObserver {
  /** 批量投递（每帧至多 MAX_BYTES_PER_DELIVERY 字节）。插件侧自行节流/转发。 */
  onRxBytes(batch: ObservedRxBytes[]): void;
}

/** 每端口转发状态。 */
interface PortBytesState {
  queue: ObservedRxBytes[];
  /** 当前排队总字节数（快速容量判定，避免每次 O(n) 求和）。 */
  queuedBytes: number;
  rafId: number | null;
  timerId: number | null;
}

/** 每端口状态表（模块级单例）。 */
const portStates = new Map<string, PortBytesState>();

/** 已注册订阅者。 */
const observers = new Set<PluginBytesObserver>();

/** 页面隐藏判断（镜像 rxPipeline）。 */
function isDocumentHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

function cancelDelivery(state: PortBytesState): void {
  if (state.rafId !== null) {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(state.rafId);
    state.rafId = null;
  }
  if (state.timerId !== null) {
    clearTimeout(state.timerId);
    state.timerId = null;
  }
}

/** 调度一次投递（页面可见 rAF / 隐藏 setTimeout 兜底，镜像 pluginObserver）。 */
function scheduleDelivery(state: PortBytesState, deliver: () => void): void {
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

/** 修剪每端口队列到字节上限（丢最旧）。 */
function enforceQueueCap(state: PortBytesState): void {
  while (state.queuedBytes > MAX_OBSERVER_QUEUE_BYTES && state.queue.length > 0) {
    const dropped = state.queue.shift();
    if (dropped) state.queuedBytes -= dropped.bytes.length;
  }
}

/** 向全部订阅者投递某端口排队的字节（每订阅者最多 MAX_BYTES_PER_DELIVERY 字节）。 */
function deliverPort(portId: string): void {
  const state = portStates.get(portId);
  if (!state || state.queue.length === 0) return;
  // 收集不超过字节上限的批次。
  let takeBytes = 0;
  const batch: ObservedRxBytes[] = [];
  let take = 0;
  for (; take < state.queue.length; take++) {
    if (take > 0 && takeBytes + state.queue[take].bytes.length > MAX_BYTES_PER_DELIVERY) break;
    takeBytes += state.queue[take].bytes.length;
    batch.push(state.queue[take]);
  }
  state.queue.splice(0, take);
  state.queuedBytes -= takeBytes;
  if (state.queue.length > 0) {
    scheduleDelivery(state, () => deliverPort(portId));
  }
  for (const obs of observers) {
    try {
      obs.onRxBytes(batch);
    } catch (e) {
      console.error('[pluginBytesObserver] observer onRxBytes failed:', e);
    }
  }
}

/**
 * 喂入一段 RX 原始字节（useSerialReceive 的 onSerialData 事件层调用）。
 * 零订阅者时 O(1) 早退——无插件不产生开销。
 */
export function feedPluginBytes(portId: string, bytes: number[] | Uint8Array, ts: number): void {
  if (observers.size === 0) return;
  if (bytes.length === 0) return;
  let state = portStates.get(portId);
  if (!state) {
    state = { queue: [], queuedBytes: 0, rafId: null, timerId: null };
    portStates.set(portId, state);
  }
  const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  state.queue.push({ portId, bytes: raw, ts });
  state.queuedBytes += raw.length;
  enforceQueueCap(state);
  scheduleDelivery(state, () => deliverPort(portId));
}

/**
 * 注册插件字节观察者（插件启用且授予 rx:bytes 时调用）。返回注销函数。
 * 首个订阅者触发接线（零订阅者不产生任何开销——feedPluginBytes 早退）。
 */
export function addPluginBytesObserver(obs: PluginBytesObserver): () => void {
  observers.add(obs);
  return () => {
    observers.delete(obs);
  };
}

/** 是否已有订阅者（设置页/宿主桥查询用）。 */
export function hasPluginBytesObservers(): boolean {
  return observers.size > 0;
}

/** 端口断线：清该端口遗留队列（断流，插件可感知——字节流没了）。 */
export function notifyBytesPortDisconnected(portId: string): void {
  const state = portStates.get(portId);
  if (state) {
    cancelDelivery(state);
    state.queue.length = 0;
    state.queuedBytes = 0;
    portStates.delete(portId);
  }
}

/** 测试用：清空状态（应用生命周期不调用）。 */
export function resetPluginBytesObserverForTest(): void {
  for (const state of portStates.values()) {
    cancelDelivery(state);
  }
  observers.clear();
  portStates.clear();
}
