/**
 * RxPipeline — 按端口聚合的 RX 批处理管线（RX 管线第二层）。
 *
 * 第一层 RxLineAssembler 把字节流切成「已完成行的字节块」；本层负责：
 * 1. 解码：按端口当前编码 label 解码成完整行。解码器统一由 `lineText.ts`
 *    缓存（K8；本层曾自持一份 per-port 缓存，`ignoreBOM` 与其它路径不一致）；
 *    行已由字节级切分保证同一编码内多字节字符不跨行，故无需 {stream:true}；
 *    行首 UTF-8 BOM 作为编码标记被剥离，不进入行文本（trigger/搜索/复制一致）；
 * 2. 批写：成行先入每端口队列，scheduleFlush 调度一个覆盖全管线的 tick
 *    （默认 rAF，node 环境回退 setTimeout 16ms），每帧对每端口只做一次
 *    appendLines——高频 RX 下把逐行 store 更新压成每帧一次；
 * 3. 静默 flush：feed 后仍有未终结尾部时启动 silenceFlushMs 定时器，超时把
 *    尾部成行（时间戳取最后一次事件时间而非 flush 时间）；
 * 4. 生命周期：flushAndReset（编码切换前）/ disconnect（断线）/ dispose（销毁）。
 *
 * 主窗与弹出窗各持一个模块单例：弹窗是独立 webview（独立模块作用域与 store
 * 实例），getRxPipeline() 在那里自然接线到本窗自己的 store——绝不跨窗共享。
 *
 * 方案B（issue #14）：批写目标从 useTerminalStore 的行数组改为
 * viewportManager 的环形缓冲区（appendTerminalLines）。行不再携带解码后的
 * content 字符串——渲染/搜索/过滤按需惰性解码。
 */

import type { TerminalLine } from '../types';
import { RxLineAssembler } from './rxAssembler';
import { decodeBytes } from './lineText';
import { useTerminalStore } from '../stores/useTerminalStore';
import { useOperationStore } from '../stores/useOperationStore';
import { appendTerminalLines } from './terminal/viewportManager';

/** 一条组装完成的 RX 完整行（行级钩子载荷，issue #14 P1-1）。
 *  rawData 为原始字节（未解码）；text 为当前 per-port 编码下的解码文本——
 *  观察者（触发引擎/插件）按需取用。评审 v2 P1b：插件观察者需要未解码字节 +
 *  编码 label 时用 rawData 自解码，宿主不强制编码选择。 */
export interface AssembledLine {
  rawData: Uint8Array;
  text: string;
  timestamp: number;
}

/** 行级钩子回调签名（主触发器 + 附加观察者共用）。 */
export type AssembledLineCallback = (portId: string, line: AssembledLine) => void;

export interface RxPipelineOptions {
  /** 批量写入终端 store（每端口每 tick 一次） */
  appendLines: (portId: string, lines: TerminalLine[]) => void;
  /** 读取端口当前编码 label（调用方已做 ascii→utf-8 归一与小写化） */
  getEncodingLabel: (portId: string) => string;
  /** 是否丢弃解码后 trim 为空（纯空白）的行 */
  getIgnoreEmptyChars: () => boolean;
  /** 主行级触发器（issue #14 P1-1）：完整行边界匹配而非读事件块边界。
   *  注入/覆盖经 `setOnLineAssembled`（多次 set 取最后一次——触发器唯一）。
   *  附加观察者（插件 rx.onLine，评审 v2 P1）经
   *  `addOnLineAssembledListener`/`removeOnLineAssembledListener` 注册，二者并存。 */
  onLineAssembled?: AssembledLineCallback;
  /** 静默 flush 超时（ms）：距上次事件这么久仍未终结的尾部会被冲刷。默认 250 */
  silenceFlushMs?: number;
  /** 转发给组装器的强制发射阈值（字节）。默认 4096 */
  maxPendingBytes?: number;
  /** 每端口每 tick 最多写入 store 的行数（issue #6-2 写量限制）。
   * 超出部分留在队列里，下一帧继续写；仅显式 TX precedence / 生命周期
   * 排空可同步多批写入。默认 2000 */
  maxLinesPerTick?: number;
  /** 每端口队列上限（行）（issue #6-10 方案3）：入队后超过该上限丢弃**最旧**的
   *  行——隐藏窗口长时间积压时最旧的行最无价值，防无界增长。默认 10000 */
  maxQueuedLines?: number;
  /** 页面是否隐藏（issue #6-10 方案3）：隐藏时 rAF 停摆，批写 tick 必须走
   *  setTimeout 兜底排空。默认读 `document.visibilityState === 'hidden'`；
   *  可注入以便测试。 */
  isDocumentHidden?: () => boolean;
  /** 调度批写 tick；可注入以便测试。默认 requestAnimationFrame，不可用时 setTimeout(cb,16) */
  scheduleFlush?: (cb: () => void) => number;
  /** 取消批写 tick，与 scheduleFlush 配对 */
  cancelFlush?: (handle: number) => void;
}

/** 每端口运行时状态 */
interface PortRxState {
  assembler: RxLineAssembler;
  /** 已完成、等待批写的行（按流顺序） */
  queue: TerminalLine[];
  /** 最后一次事件的时间戳：静默/强制 flush 出来的尾行沿用该时间，而非 flush 时刻 */
  lastEventTs: number | null;
  /** 静默 flush 定时器 */
  silenceTimer: number | null;
}

const DEFAULT_SILENCE_FLUSH_MS = 250;
const DEFAULT_MAX_PENDING_BYTES = 4096;
const DEFAULT_MAX_LINES_PER_TICK = 2000;
/** 每端口队列上限（行）：超过即丢弃最旧，防隐藏窗口期间无界积压（issue #6-10） */
const DEFAULT_MAX_QUEUED_LINES = 10_000;
const FALLBACK_TICK_MS = 16;

/** 页面是否隐藏：document.hidden / visibilityState === 'hidden' 时 rAF 停摆（issue #6-10） */
const defaultIsDocumentHidden = (): boolean =>
  typeof document !== 'undefined' && document.visibilityState === 'hidden';

const defaultCancelFlush = (handle: number): void => {
  // 与 defaultScheduleFlush 的 visibility-aware 调度对应：tick 可能由 rAF 或
  // setTimeout 任一机制产生。rAF 与 setTimeout 的句柄命名空间不同，但对
  // 错误命名空间的 id，cancelAnimationFrame / clearTimeout 都是静默 no-op——
  // 同时调用两种取消，保证无论 tick 由哪种机制调度都能真正取消。
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle);
  clearTimeout(handle);
};

export class RxPipeline {
  private readonly opts: RxPipelineOptions;
  private readonly silenceFlushMs: number;
  private readonly maxPendingBytes: number;
  private readonly maxLinesPerTick: number;
  private readonly maxQueuedLines: number;
  private readonly isHidden: () => boolean;
  private readonly scheduleFlush: (cb: () => void) => number;
  private readonly cancelFlush: (handle: number) => void;
  private readonly ports = new Map<string, PortRxState>();
  /** 主行级触发器（P1-1）：由 useSerialReceive 在挂载时注入，每条完整行组装
   *  完成后触发。唯一（多次 set 取最后一次）——见 `setOnLineAssembled`。 */
  private onLineAssembledCb?: AssembledLineCallback;
  /** 附加行级观察者（评审 v2 P1：插件 rx.onLine 等多播注册）。
   *  与主触发器并存；add/remove 管理，不覆盖触发器。 */
  private readonly extraOnLineAssembledCbs = new Set<AssembledLineCallback>();

  /** 全管线唯一的批写 tick 句柄（非每端口一个） */
  private flushTickHandle: number | null = null;

  constructor(opts: RxPipelineOptions) {
    this.opts = opts;
    this.silenceFlushMs = opts.silenceFlushMs ?? DEFAULT_SILENCE_FLUSH_MS;
    this.maxPendingBytes = opts.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;
    this.maxLinesPerTick = opts.maxLinesPerTick ?? DEFAULT_MAX_LINES_PER_TICK;
    this.maxQueuedLines = opts.maxQueuedLines ?? DEFAULT_MAX_QUEUED_LINES;
    this.isHidden = opts.isDocumentHidden ?? defaultIsDocumentHidden;
    // issue #6-10 方案3 visibility-aware 默认调度器：页面可见且 rAF 可用 → rAF；
    // 页面隐藏（rAF 停摆）或无 rAF → setTimeout(16ms) 兜底排空。注意调度时刻的
    // 可见性不代表触发时刻的可见性——真正的保险是下方的 visibilitychange 监听
    // （隐藏时把未触发的 rAF tick 重排成 setTimeout）。
    this.scheduleFlush =
      opts.scheduleFlush ??
      ((cb: () => void): number => {
        if (typeof requestAnimationFrame === 'function' && !this.isHidden()) {
          return requestAnimationFrame(cb);
        }
        return setTimeout(cb, FALLBACK_TICK_MS);
      });
    this.cancelFlush = opts.cancelFlush ?? defaultCancelFlush;
    this.onLineAssembledCb = opts.onLineAssembled;
    // issue #6-10 方案3：页面隐藏时 rAF 停摆，已调度的 rAF tick 永远不会触发——
    // 监听 visibilitychange，隐藏时把未触发的 tick 按当前调度器重排
    // （隐藏 → setTimeout 兜底排空；恢复可见 → 换回 rAF 更低延迟）。
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', this.handleVisibilityChange);
    }
  }
  /** P1-1：注入/覆盖主行级触发器（useSerialReceive 挂载时调用）。
   *  多次 set 取最后一次——触发器唯一，不叠加。 */
  setOnLineAssembled(cb: AssembledLineCallback): void {
    this.onLineAssembledCb = cb;
  }

  /** 注册附加行级观察者（评审 v2 P1：插件 rx.onLine）。与主触发器并存，
   *  互不覆盖；返回注销函数。同一回调重复 add 幂等（Set 语义）。 */
  addOnLineAssembledListener(cb: AssembledLineCallback): () => void {
    this.extraOnLineAssembledCbs.add(cb);
    return () => this.removeOnLineAssembledListener(cb);
  }

  /** 注销附加行级观察者。 */
  removeOnLineAssembledListener(cb: AssembledLineCallback): void {
    this.extraOnLineAssembledCbs.delete(cb);
  }

  /** visibilitychange 处理：取消未触发的批写 tick，按当前可见性用默认调度器重排 */
  private readonly handleVisibilityChange = (): void => {
    if (this.flushTickHandle !== null) {
      this.cancelFlush(this.flushTickHandle);
      this.flushTickHandle = null;
      this.scheduleTick();
    }
  };

  /**
   * 喂入一段 RX 字节（一个 serial:data 事件的 payload）。
   * 组装器切出的完成行解码后入队并调度批写；若仍有未终结尾部则（重新）武装
   * 静默定时器。流量统计不归这里管——由事件处理器在调用前完成。
   */
  feedBytes(portId: string, bytes: number[] | Uint8Array, timestamp: number): void {
    if (bytes.length === 0) return;
    // Do not gate on tab existence: popouts have a separate store without tabs.
    const state = this.getPortState(portId);
    state.lastEventTs = timestamp;
    const chunks = state.assembler.feed(bytes);
    for (const chunk of chunks) {
      const raw = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      this.enqueueRxLine(portId, state, raw, timestamp);
    }
    if (chunks.length > 0) this.scheduleTick();
    this.armSilenceTimer(portId, state);
    this.enforceQueueCap(state);
  }

  /** Add a protocol frame to the RX queue and notify observers exactly once.
   * Other externally constructed lines bypass RX observers via enqueueLines. */
  enqueueFrame(portId: string, line: TerminalLine): void {
    const state = this.getPortState(portId);
    this.enqueueRxLine(portId, state, line.rawData!, line.timestamp, line);
    this.enforceQueueCap(state);
    this.scheduleTick();
  }

  /** Enqueue externally constructed rows (e.g. replay) without RX callbacks. */
  enqueueLines(portId: string, lines: TerminalLine[]): void {
    if (lines.length === 0) return;
    const state = this.getPortState(portId);
    state.queue.push(...lines);
    this.enforceQueueCap(state);
    this.scheduleTick();
  }

  /**
   * 解码一段字节为文本（协议帧自成单元、不跨行，非流式即可）。
   * 输入可为 number[]（事件 payload / 协议帧）或 Uint8Array（feedBytes 已转换）。
   */
  decodeText(portId: string, bytes: number[] | Uint8Array): string {
    return this.decodeUnderCurrentLabel(portId, bytes);
  }

  /** 当前 per-port 编码 label（归一化小写，如 utf-8 / gbk）。
   *  插件观察者经此拿编码（评审 v2 P1b：行载荷给未解码字节 + 编码，宿主不强制
   *  解码选择）。不创建端口状态——纯读 opts 注入的查询。 */
  getPortEncodingLabel(portId: string): string {
    return this.opts.getEncodingLabel(portId);
  }

  /**
   * Bounded synchronous write (at most maxLinesPerTick per call). The remaining
   * queue is written on future ticks. For a TX echo or lifecycle boundary use
   * flushBeforeSend to guarantee all earlier RX is written first.
   */
  flushNow(portId: string): void {
    const state = this.ports.get(portId);
    if (!state || state.queue.length === 0) return;
    const take = Math.min(state.queue.length, this.maxLinesPerTick);
    const lines = state.queue.splice(0, take);
    this.opts.appendLines(portId, lines);
    if (state.queue.length > 0) {
      // 剩余行顺延到下一 tick 续写，避免同步写爆主线程
      this.scheduleTick();
    }
  }

  /** Synchronously write every queued RX row before a TX echo or a lifecycle boundary.
   * Normal flushNow and animation ticks remain bounded to maxLinesPerTick. */
  flushBeforeSend(portId: string): void {
    const state = this.ports.get(portId);
    if (!state) return;
    while (state.queue.length > 0) this.flushNow(portId);
  }

  /** Flush an unterminated tail into the queue with its last event timestamp.
   * The caller chooses when to write it to the terminal. */
  flushTail(portId: string): void {
    const state = this.ports.get(portId);
    if (!state) return;
    const tail = state.assembler.takeTail();
    if (tail.length === 0) return;
    const raw = new Uint8Array(tail);
    const timestamp = state.lastEventTs ?? Date.now();
    // Freeze the current encoding for this seam even when the display label changes.
    this.enqueueRxLine(portId, state, raw, timestamp, {
      timestamp, direction: 'RX', rawData: raw,
      content: this.decodeUnderCurrentLabel(portId, raw), isHex: false,
    });
    this.enforceQueueCap(state);
    if (state.silenceTimer !== null) {
      clearTimeout(state.silenceTimer);
      state.silenceTimer = null;
    }
  }

  /**
   * 编码切换前调用：先把尾部按**当前**编码冲刷落盘，再重置组装器与静默定时器——
   * 旧编码 buffered 的字节不允许在新编码下复活。解码器由 `lineText.ts` 共享缓存，
   * 非流式解码不留跨调用残字节，故这里无需（也无法）清理。
   */
  flushAndReset(portId: string): void {
    const state = this.ports.get(portId);
    if (!state) return;
    this.flushTail(portId);
    // Queued rows are normally decoded lazily, but the encoding switch is an
    // explicit boundary: rows written before the switch retain their old label.
    for (const line of state.queue) {
      if (line.direction === 'RX' && line.content === undefined && line.rawData) {
        line.content = this.decodeUnderCurrentLabel(portId, line.rawData);
      }
    }
    this.flushBeforeSend(portId);
    if (state.silenceTimer !== null) {
      clearTimeout(state.silenceTimer);
      state.silenceTimer = null;
    }
    state.assembler.reset();
  }

  /**
   * 断线：冲刷尾部后丢弃该端口全部状态（组装器/定时器/队列），
   * 重连必须从干净状态开始。
   */
  disconnect(portId: string): void {
    const state = this.ports.get(portId);
    if (!state) return;
    this.flushTail(portId);
    this.flushBeforeSend(portId);
    if (state.silenceTimer !== null) clearTimeout(state.silenceTimer);
    this.ports.delete(portId);
  }

  /** 取消未触发的批写 tick 与所有静默定时器（实例销毁时用） */
  dispose(): void {
    if (this.flushTickHandle !== null) {
      this.cancelFlush(this.flushTickHandle);
      this.flushTickHandle = null;
    }
    for (const state of this.ports.values()) {
      if (state.silenceTimer !== null) {
        clearTimeout(state.silenceTimer);
        state.silenceTimer = null;
      }
    }
    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    }
  }

  // ==================== 内部 ====================

  /**
   * 队列上限（issue #6-10 方案3）：超过 `maxQueuedLines` 时丢弃**最旧**的行。
   * 触发场景是排空跟不上入队（隐藏窗口 rAF 停摆 / 主线程长时间忙）——此时最旧
   * 的行最无价值（很快会被内存裁剪清掉），保留最新数据优先。
   */
  private enforceQueueCap(state: PortRxState): void {
    const overflow = state.queue.length - this.maxQueuedLines;
    if (overflow > 0) {
      state.queue.splice(0, overflow);
    }
  }

  private getPortState(portId: string): PortRxState {
    let state = this.ports.get(portId);
    if (!state) {
      state = {
        assembler: new RxLineAssembler({ maxPendingBytes: this.maxPendingBytes }),
        queue: [],
        lastEventTs: null,
        silenceTimer: null,
      };
      this.ports.set(portId, state);
    }
    return state;
  }

  /** Enqueue before notifying observers: auto-response TX echoes must follow the RX row. */
  private enqueueRxLine(
    portId: string, state: PortRxState, raw: Uint8Array, timestamp: number,
    assembled?: TerminalLine,
  ): void {
    const text = assembled?.content ?? this.decodeUnderCurrentLabel(portId, raw);
    if (this.opts.getIgnoreEmptyChars() && !text.trim()) return;
    state.queue.push(assembled ?? { timestamp, direction: 'RX', rawData: raw, isHex: false });
    const line: AssembledLine = { rawData: raw, text, timestamp };
    if (this.onLineAssembledCb) {
      try {
        this.onLineAssembledCb(portId, line);
      } catch (e) {
        console.error('[rxPipeline] onLineAssembled trigger failed:', e);
      }
    }
    for (const cb of this.extraOnLineAssembledCbs) {
      try {
        cb(portId, line);
      } catch (e) {
        console.error('[rxPipeline] onLineAssembled observer failed:', e);
      }
    }
  }
  /** 按端口当前 label 解码一段字节（解码器由 `lineText.ts` 统一缓存）。 */
  private decodeUnderCurrentLabel(
    portId: string,
    bytes: number[] | Uint8Array,
  ): string {
    // issue #6-2：已传 Uint8Array（feedBytes 转换的 raw）时不再次拷贝
    const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return decodeBytes(raw, this.opts.getEncodingLabel(portId));
  }

  /** 调度全管线唯一的批写 tick；tick 内对每个有排队的端口各做一次 appendLines */
  private scheduleTick(): void {
    if (this.flushTickHandle !== null) return;
    this.flushTickHandle = this.scheduleFlush(() => {
      this.flushTickHandle = null;
      for (const [portId, state] of this.ports) {
        if (state.queue.length > 0) {
          // 每端口每帧最多写 maxLinesPerTick 行（issue #6-2）：超出顺延到下一帧，
          // 避免一次 append 数千行阻塞主线程；队列仍在增长时下一帧继续写。
          const take = Math.min(state.queue.length, this.maxLinesPerTick);
          const lines = state.queue.splice(0, take);
          this.opts.appendLines(portId, lines);
          if (state.queue.length > 0) {
            this.scheduleTick();
          }
        }
      }
    });
  }

  /**
   * （重新）武装静默定时器：feed 后组装器仍有未终结尾部时，
   * silenceFlushMs 内无新完成行就把尾部冲刷出去，避免半行无限滞留。
   */
  private armSilenceTimer(portId: string, state: PortRxState): void {
    if (state.assembler.hasPending) {
      if (state.silenceTimer !== null) clearTimeout(state.silenceTimer);
      state.silenceTimer = setTimeout(() => {
        state.silenceTimer = null;
        this.flushTail(portId);
        this.flushNow(portId);
      }, this.silenceFlushMs);
    } else if (state.silenceTimer !== null) {
      // 尾部已随新事件终结：残留的定时器没有可冲刷的内容，取消
      clearTimeout(state.silenceTimer);
      state.silenceTimer = null;
    }
  }
}

// ==================== 应用级单例 ====================

let rxPipelineSingleton: RxPipeline | null = null;

/**
 * 取本窗的 RX 管线单例（惰性创建并接线到本窗 store）。
 *
 * 弹出窗是独立 webview：那里的模块作用域调用本函数会得到接在**弹窗自己**
 * store 上的另一个单例——不要尝试跨窗共享状态。
 *
 * 单例与应用同寿命：useSerialReceive / TerminalPopout 的 cleanup 都**不得**
 * 调 dispose()。
 */
export function getRxPipeline(): RxPipeline {
  if (!rxPipelineSingleton) {
    rxPipelineSingleton = new RxPipeline({
      appendLines: (portId, lines) => {
      // 方案B（issue #14）：批写入环形缓冲区（最大显示行数滚动窗口）。
      // issue #16 改版后无内存预算 toast——逐行覆盖是常态滚动，非异常事件。
      appendTerminalLines(portId, lines);
      },
      getEncodingLabel: (portId) => {
        const encoding = useTerminalStore.getState().terminals[portId]?.encoding || 'UTF-8';
        return encoding.toLowerCase() === 'ascii' ? 'utf-8' : encoding.toLowerCase();
      },
      getIgnoreEmptyChars: () => useOperationStore.getState().ignoreEmptyChars,
    });
  }
  return rxPipelineSingleton;
}
