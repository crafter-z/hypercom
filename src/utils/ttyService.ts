/**
 * ttyService — TTY 模式（xterm.js）按端口聚合的 RX/TX 服务单例（issue #11）。
 *
 * TTY 模式取代 TRX 的«行级»管线的角色：xterm.js 自带完整终端模拟（ANSI/VT100、
 * 备用屏幕、滚动区、尺寸协商），这里只负责把 `serial:data` 的原始字节流解码后
 * 批写进 xterm，并把 xterm 的 onData 输出转成串口 TX。
 *
 * 架构镜像 `getRxPipeline()` 的模块单例模式：
 * 1. 每 webview 一个模块级单例；弹出窗是独立 webview（独立模块作用域），自然隔离；
 * 2. 流式解码：每端口缓存一个 `TextDecoder('utf-8', { stream: true })`——多字节
 *    UTF-8 字符跨事件分片时由解码器内部缓冲，两段 feed 拼回完整字符；
 * 3. 批写：解码结果先入每端口队列，scheduleFlush 调度 flush（页面可见 rAF、
 *    隐藏/无 rAF 时 setTimeout(16ms) 兜底——镜像 rxPipeline 的 visibility-aware
 *    调度），flush = join 队列 + `term.write(text)`；
 * 4. 队列上限：MAX_TTY_QUEUE（10000 条）超限丢**最旧**——隐藏窗口长时间积压时
 *    最旧的数据最无价值，防无界增长；
 * 5. 生命周期：attach（TtyView 挂载）/ detach（TtyView 卸载，**不** dispose
 *    Terminal——视图拥有实例）/ disconnect（断线 flush 队列、保留 term，视图跨
 *    重连保持挂载）/ dispose（测试用，移除 visibilitychange 监听）。
 *
 * TX 路径刻意不经过 `sendToPort`（那是 TRX 管线：TX 回显 + 发送历史）。TTY 无本地
 * 回显（由对端 echo），按键高频——发送失败只 console.error，不弹 toast 刷屏。
 */

import type { Terminal } from '@xterm/xterm';
import { serialService, gitBashSimService } from '../services/tauri';
import { useAppStore } from '../stores/useAppStore';

/** 每端口等待批写的解码字符串队列上限（条）：超过即丢弃最旧（issue #6-10 同款策略）。 */
export const MAX_TTY_QUEUE = 10_000;
/** 页面隐藏（rAF 停摆）时的兜底批写周期（ms）。 */
const FALLBACK_TICK_MS = 16;

/** 每端口运行时状态 */
export interface TtyPortState {
  /** xterm 实例（由 TtyView 创建并 attach；TtyView 拥有 dispose） */
  term: Terminal | null;
  /** UTF-8 流式解码器（{stream:true}，跨 feed 缓存多字节字符） */
  decoder: TextDecoder | null;
  /** 解码后等待批写的字符串（按流顺序） */
  queue: string[];
  /** rAF 批写句柄（页面可见时用） */
  rafId: number | null;
  /** setTimeout 兜底批写句柄（页面隐藏 / 无 rAF 时用） */
  timerId: number | null;
  /** 最近一次已知的 xterm 尺寸（issue #11）：打开 GIT:BASH 端口时随请求传给后端，
   *  使 pty 以正确尺寸 spawn；连接后 resync 亦复用。 */
  lastCols: number | null;
  lastRows: number | null;
}

/** 每端口状态表（模块级单例） */
const ports = new Map<string, TtyPortState>();

/** 页面是否隐藏：document.hidden / visibilityState === 'hidden' 时 rAF 停摆（issue #6-10） */
const defaultIsDocumentHidden = (): boolean =>
  typeof document !== 'undefined' && document.visibilityState === 'hidden';

/** 取消 pending 批写：rAF 与 setTimeout 的句柄命名空间不同，但对错误命名空间的 id，
 *  cancelAnimationFrame / clearTimeout 都是静默 no-op——同时调用两种取消保证都能真正取消。 */
function cancelPending(state: TtyPortState): void {
  if (state.rafId !== null) {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(state.rafId);
    state.rafId = null;
  }
  if (state.timerId !== null) {
    clearTimeout(state.timerId);
    state.timerId = null;
  }
}

/** 取（或惰性创建）端口状态 */
function getPortState(portId: string): TtyPortState {
  let state = ports.get(portId);
  if (!state) {
    state = {
      term: null,
      decoder: null,
      queue: [],
      rafId: null,
      timerId: null,
      lastCols: null,
      lastRows: null,
    };
    ports.set(portId, state);
  }
  return state;
}

/** 队列上限：超过 MAX_TTY_QUEUE 丢弃最旧（issue #6-10 方案3 同款策略）。 */
function enforceQueueCap(state: TtyPortState): void {
  const overflow = state.queue.length - MAX_TTY_QUEUE;
  if (overflow > 0) {
    state.queue.splice(0, overflow);
  }
}

/** 排空队列写入 xterm；term 为空（未 attach）时保留队列等 attach 时 replay。 */
function flushState(state: TtyPortState): void {
  if (state.queue.length === 0) return;
  if (state.term) {
    state.term.write(state.queue.join(''));
    state.queue.length = 0;
  }
  // term === null：队列保留（容量已在 feed 时裁剪），attach 时一次性 replay。
}

/**
 * visibility-aware 调度批写（镜像 rxPipeline 的 defaultScheduleFlush）：
 * 页面可见且 rAF 可用 → rAF；隐藏（rAF 停摆）或无 rAF → setTimeout(16ms) 兜底。
 * 每端口至多一个 pending 批写（第二 feed 只入队，不重复调度）。
 */
function scheduleFlushFor(state: TtyPortState): void {
  if (state.rafId !== null || state.timerId !== null) return;
  const useRaf = typeof requestAnimationFrame === 'function' && !defaultIsDocumentHidden();
  const cb = (): void => {
    state.rafId = null;
    state.timerId = null;
    flushState(state);
  };
  if (useRaf) {
    state.rafId = requestAnimationFrame(cb);
  } else {
    state.timerId = setTimeout(cb, FALLBACK_TICK_MS);
  }
}

/** visibilitychange 处理：取消未触发的批写，按当前可见性重排（隐藏→setTimeout 兜底，
 *  恢复→rAF 更低延迟）。不重新调度时队列留待 attach/下一次 feed。 */
const handleVisibilityChange = (): void => {
  for (const state of ports.values()) {
    if (state.rafId !== null || state.timerId !== null) {
      cancelPending(state);
      if (state.queue.length > 0 && state.term) {
        scheduleFlushFor(state);
      }
    }
  }
};

// 模块级注册（模块作用域即「每 webview」一次，与 getRxPipeline 单例同寿命）。
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('visibilitychange', handleVisibilityChange);
}

export const ttyService = {
  /**
   * TtyView 挂载时注册 xterm 实例；replay 未 attach 期间入队的字符串。
   * 不负责 dispose——Terminal 由 TtyView 拥有。
   */
  attach(portId: string, term: Terminal): void {
    const state = getPortState(portId);
    cancelPending(state);
    state.term = term;
    if (state.queue.length > 0) {
      term.write(state.queue.join(''));
      state.queue.length = 0;
    }
  },

  /**
   * TtyView 卸载时移除端口运行时状态（含 pending 批写）。不 dispose Terminal（视图拥有）。
   * 仅保留最近一次尺寸（lastCols/lastRows）——同端口再次挂载/打开 GIT:BASH 时
   * 仍能以正确尺寸 spawn pty（否则切走标签再重开会回退 80×24 首帧错乱）。
   */
  detach(portId: string): void {
    const state = ports.get(portId);
    if (!state) return;
    cancelPending(state);
    ports.set(portId, {
      term: null,
      decoder: null,
      queue: [],
      rafId: null,
      timerId: null,
      lastCols: state.lastCols,
      lastRows: state.lastRows,
    });
  },

  /**
   * 喂入一段 RX 字节（一个 serial:data 事件的 payload）。
   * 流式 UTF-8 解码 → 入队 → 剪裁容量 → term 已 attach 时调度批量 term.write。
   * term 未 attach 时只入队（上限裁剪），attach 时统一 replay。
   */
  feed(portId: string, bytes: number[] | Uint8Array): void {
    if (bytes.length === 0) return;
    const state = getPortState(portId);
    // issue #11：标签页关闭（TtyView 卸载 → detach，term=null）后串口仍可能
    // 保持连接、数据继续到达。除非端口有标签页（挂载前首帧窗口，等 attach
    // replay），否则直接丢弃——否则重开标签页会 replay 关闭期间积压的数据，
    // 违反「重新开始新一轮输出」的语义（TRX 侧 appendTerminalLines 同款丢弃）。
    // 只在 term 为 null 时查 store：正常挂载（term 非 null）零额外开销。
    if (state.term === null && !useAppStore.getState().tabs.some((t) => t.id === portId)) {
      return;
    }
    if (!state.decoder) {
      state.decoder = new TextDecoder('utf-8', { fatal: false });
    }
    const text = state.decoder.decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), {
      stream: true,
    });
    if (text) state.queue.push(text);
    enforceQueueCap(state);
    if (state.term) scheduleFlushFor(state);
  },

  /** 清屏：term.clear()（队列保留，下一次 feed/flush 照常）。 */
  clear(portId: string): void {
    ports.get(portId)?.term?.clear();
  },

  /**
   * 断线：取消 pending 批写，把队列剩余内容推向 xterm（term 为空则丢弃），
   * 并重建流式解码器——断线时 decoder 内可能残留未完成的多字节 UTF-8 字符，
   * 保留会在重连后与下一连接的首字节拼出错误字符（TRX 侧 pipeline.disconnect
   * 是全量丢弃 per-port 状态，此处对齐该语义）。端口状态与 term 保留——
   * 视图跨重连保持挂载，重连后继续接收。不 detach / 不 dispose。
   */
  disconnect(portId: string): void {
    const state = ports.get(portId);
    if (!state) return;
    cancelPending(state);
    if (state.queue.length > 0) {
      if (state.term) state.term.write(state.queue.join(''));
      state.queue.length = 0;
    }
    state.decoder = null;
  },

  /**
   * TTY 的 TX 路径（xterm onData）：UTF-8 编码 → send_serial_data → 更新流量统计。
   * 刻意不经过 sendToPort（那是 TRX 管线：TX 回显 + 发送历史）。失败仅 console.error
   * 不弹 toast——按键高频，逐个 toast 全是噪音。
   */
  async send(portId: string, text: string): Promise<void> {
    if (!text) return;
    try {
      const bytesWritten = await serialService.sendSerialData({
        port_id: portId,
        data: text,
        is_hex: false,
        append_line_ending: 'None',
      });
      const prev = useAppStore.getState().trafficStats[portId]?.txTotal ?? 0;
      useAppStore.getState().setTrafficStats(portId, { txTotal: prev + bytesWritten });
    } catch (err) {
      console.error('[ttyService] send failed for', portId, err);
    }
  },

  /**
   * 尺寸协商：记录到端口状态（供打开端口时随请求传给后端 pty），并仅对 GIT:
   * 模拟端口实时同步后端 pty 尺寸（vim/top 全屏应用据此重绘）。
   * 真实串口无需后端 resize——远端 getty 经 `\x1b[18t` 查询由 xterm 经 onData 自动回尺寸。
   * 先取整再校验：FitAddon 在容器未布局时可能产生 NaN/0.x 等非法值，取整后
   * 的 0/负数同样拒绝（避免把 0 尺寸推给后端 ConPTY 报错）。
   */
  resize(portId: string, cols: number, rows: number): void {
    const c = Math.round(cols);
    const r = Math.round(rows);
    if (!Number.isFinite(c) || !Number.isFinite(r) || c <= 0 || r <= 0) return;
    const state = ports.get(portId);
    if (state) {
      state.lastCols = c;
      state.lastRows = r;
    }
    const port = useAppStore.getState().ports.find((p) => p.id === portId);
    if (port && port.id.startsWith('GIT:')) {
      gitBashSimService.resizeGitBashSim(portId, c, r).catch((err) => {
        console.error('[ttyService] resize failed for', portId, err);
      });
    }
  },

  /**
   * 连接后重新同步尺寸（issue #11 保险）：端口刚 open 时 pty 已按打开请求的尺寸
   * spawn，此处把最近一次 xterm 尺寸再推一次，覆盖「spawn 后容器才完成布局」的
   * 边角时序。仅对已有有效尺寸的 GIT: 端口生效，其余为 no-op。
   */
  resync(portId: string): void {
    const state = ports.get(portId);
    if (!state || state.lastCols == null || state.lastRows == null) return;
    const port = useAppStore.getState().ports.find((p) => p.id === portId);
    if (port && port.id.startsWith('GIT:')) {
      gitBashSimService.resizeGitBashSim(portId, state.lastCols, state.lastRows).catch((err) => {
        console.error('[ttyService] resync failed for', portId, err);
      });
    }
  },

  /** 取端口状态（测试/诊断用）。 */
  get(portId: string): TtyPortState | undefined {
    return ports.get(portId);
  },

  /** 清空全部端口状态（测试用；应用生命周期内不得调用）。 */
  reset(): void {
    for (const state of ports.values()) cancelPending(state);
    ports.clear();
  },

  /** 清空状态并移除 visibilitychange 监听（仅测试用）。 */
  dispose(): void {
    for (const state of ports.values()) cancelPending(state);
    ports.clear();
    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    }
  },
};