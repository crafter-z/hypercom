/**
 * pluginHost — 插件 Worker 宿主（issue #17，评审 v2 D1/D3/D5/P5/P6）
 *
 * 职责：
 * - 一个启用插件 = 一个 `PluginSession`：后端读 main.js → Blob URL → `Worker`
 *   （评审 v2 P6 加载路径；生产 CSP `script-src 'self' blob:` 已放行，见 D8）。
 * - RPC 桥：宿主 API 调用（worker 侧 `plugin.api.<op>(...)`）→ 本层执行
 *   `{seq, op, args}` 消息；**调用时权限校验**（评审 v2 P7）——每次 RPC 按当前
 *   插件 grantedPermissions 决定放行，撤销即时生效（worker 内旧引用不残留）。
 * - 宿主 → 插件事件：`ui.buttonClick` / `rx.line`（经 pluginObserver）/
 *   `lifecycle` 等，postMessage `{type, payload}`。
 * - 崩溃处置（评审 v2 P5）：worker error/unhandledrejection 计数；**连续
 *   `MAX_CRASHES_BEFORE_DISABLE` 次「启用后 X 秒内崩溃」才写 disabled**（防恶意
 *   插件以崩溃做持久 DoS——单次瞬崩不写持久状态），并通知宿主 UI。
 *
 * 安全边界：插件零 DOM/零 `__TAURI__`（Worker 环境）；出站网络被 CSP
 * `connect-src 'self'` + `plugin_http` 双关（后端权限/白名单校验）。
 * 本层不信任 worker 的任何输入——op 白名单 + 参数形状校验 + 权限过滤。
 */
import { pluginService } from '../services/tauri';
import { useAppStore } from '../stores/useAppStore';
import { useToastStore } from '../stores/useToastStore';
import { wrapPluginCode } from './pluginBridge';
import { executeHostApi } from './pluginHostApi';
import { checkOpAllowed, type HostRequest } from './pluginRpc';

/** 单次 RPC 调用超时（同步桥调用；长任务经后端自带超时，见评审 v2 P13）。 */
export const RPC_TIMEOUT_MS = 5000;
/** 连续崩溃阈值：达到后写 disabled（评审 v2 P5 防持久 DoS）。 */
export const MAX_CRASHES_BEFORE_DISABLE = 3;
/** 崩溃计数窗口：启用后该秒数内的崩溃计入「启动即崩」；之外重置计数。 */
export const CRASH_WINDOW_MS = 10_000;
/** worker 消息队列上限（宿主 → 插件事件风暴防护）。 */
export const MAX_PENDING_MESSAGES = 1000;

/** 插件宿主可执行动作集合——供宿主 UI 调用的回调。 */
export interface PluginHostCallbacks {
  /** 插件崩溃/自动禁用时通知 UI（设置页刷新列表）。 */
  onPluginCrashed?: (pluginId: string, reason: string) => void;
  /** 插件请求面板内容导出（v1 占位：宿主 UI 自行实现）。 */
  onPanelExport?: (pluginId: string, text: string) => void;
}

/** 一个插件的运行时会话。 */
export class PluginSession {
  readonly pluginId: string;
  private worker: Worker | null = null;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private seq = 0;
  private crashCount = 0;
  private crashWindowStart = 0;
  /** 插件事件处理器注册表（worker → 宿主：events.on）。 */
  private readonly eventHandlers = new Map<string, Set<(payload: unknown) => void>>();

  constructor(pluginId: string) {
    this.pluginId = pluginId;
  }

  /** 是否已加载（worker 存活）。 */
  get loaded(): boolean {
    return this.worker !== null;
  }

  /** 启用并加载 worker（幂等）。 */
  async start(callbacks?: PluginHostCallbacks): Promise<void> {
    if (this.worker) return;
    const userCode = await pluginService.readPluginAsset(this.pluginId, 'main.js');
    // 包桥：worker 内 `self.plugin`（api 代理 + on）由桥注入（评审 v2 D1）。
    const blob = new Blob([wrapPluginCode(userCode)], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);
    URL.revokeObjectURL(url); // 加载后立即可 revoke（worker 已持有脚本内容）

    worker.onmessage = (ev: MessageEvent) => {
      const msg = ev.data as { seq?: number; ok?: boolean; op?: string; type?: string; result?: unknown; error?: string; payload?: unknown };
      if (!msg) return;
      if (typeof msg.seq === 'number' && 'ok' in msg) {
        // 宿主 call() 的响应（worker 桥回）：查 pending 兑现。
        const pending = this.pending.get(msg.seq);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(msg.seq);
          if (msg.ok) pending.resolve(msg.result);
          else pending.reject(new Error(msg.error || 'plugin RPC failed'));
        }
      } else if (typeof msg.op === 'string') {
        // worker → 宿主 的 API 请求（plugin.api.<op>）：调用时权限校验 +
        // 执行真实实现 + 回响应（评审 v2 D3/P7）。
        void this.handleWorkerRequest(msg as { seq: number; op: string; args?: unknown });
      } else if (typeof msg.type === 'string') {
        // 插件事件（events.emit / __plugin_ready）
        this.dispatchEvent(msg.type, msg.payload);
      }
    };

    worker.onerror = (e) => {
      void this.handleCrash(e.message || 'worker error', callbacks);
    };

    this.worker = worker;
    this.crashWindowStart = Date.now();
    this.crashCount = 0;

    // 通知插件已启用（lifecycle: enabled）。
    this.post({ type: 'lifecycle', payload: { state: 'enabled' } });
  }

  /** worker → 宿主 API 请求处理：调用时权限校验 → 执行 → 响应。 */
  private async handleWorkerRequest(req: { seq: number; op: string; args?: unknown }): Promise<void> {
    const respond = (payload: { ok: boolean; result?: unknown; error?: string }): void => {
      if (this.worker) {
        this.worker.postMessage({ seq: req.seq, ...payload });
      }
    };
    try {
      // 调用时权限校验（评审 v2 P7：撤销即时生效）。
      const granted = this.currentGrantedPermissions();
      const denied = checkOpAllowed(req.op, granted);
      if (denied) {
        respond({ ok: false, error: denied });
        return;
      }
      const result = await executeHostApi(this.pluginId, req.op, req.args);
      respond({ ok: true, result });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error(`[pluginHost] ${this.pluginId} api ${req.op} failed:`, errMsg);
      respond({ ok: false, error: errMsg });
    }
  }

  /** 停止并销毁 worker（禁用/卸载时）。 */
  stop(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    // 拒绝所有 pending。
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error('plugin stopped'));
    }
    this.pending.clear();
  }

  /** 崩溃处理：计数窗口内连续崩溃达阈值 → 写 disabled + 通知。 */
  private async handleCrash(reason: string, callbacks?: PluginHostCallbacks): Promise<void> {
    const now = Date.now();
    if (now - this.crashWindowStart > CRASH_WINDOW_MS) {
      // 窗口过期：重置（运行稳定一段时间后的崩溃视为偶发）。
      this.crashCount = 0;
      this.crashWindowStart = now;
    }
    this.crashCount++;
    console.error(`[pluginHost] plugin ${this.pluginId} crashed (${this.crashCount}/${MAX_CRASHES_BEFORE_DISABLE}): ${reason}`);

    if (this.crashCount >= MAX_CRASHES_BEFORE_DISABLE) {
      // 连续崩溃达阈值：写 disabled（持久状态，防反复拉起）。
      try {
        await pluginService.setPluginEnabled(this.pluginId, false);
        this.stop();
        useToastStore.getState().push({
          severity: 'warning',
          message: `插件 ${this.pluginId} 连续崩溃已自动禁用（最后一次: ${reason}）`,
        });
        callbacks?.onPluginCrashed?.(this.pluginId, reason);
      } catch (e) {
        console.error('[pluginHost] failed to disable crashed plugin:', e);
      }
    } else {
      // 未达阈值：terminate + 标记（宿主 UI 提示可重试；不写持久状态）。
      this.stop();
      callbacks?.onPluginCrashed?.(this.pluginId, reason);
    }
  }

  /**
   * 宿主 → 插件调用（worker 侧 `plugin.api.<op>`）。**调用时权限校验**：
   * 每次按当前 config 里的 grantedPermissions 决定，撤销即时生效。
   */
  async call<T = unknown>(op: string, args?: unknown): Promise<T> {
    // 权限校验：查 config 当前授予集（实时——不缓存，撤销即拒）。
    const granted = this.currentGrantedPermissions();
    const denied = checkOpAllowed(op, granted);
    if (denied) {
      throw new Error(denied);
    }
    if (!this.worker) {
      throw new Error('plugin not loaded');
    }

    const seq = ++this.seq;
    const msg: HostRequest = { seq, op, args };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`plugin API 调用超时（${RPC_TIMEOUT_MS}ms）: ${op}`));
      }, RPC_TIMEOUT_MS);
      this.pending.set(seq, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      this.worker?.postMessage(msg);
    });
  }

  /** 宿主 → 插件事件（postMessage 免等待）。带队列上限防风暴；
   *  `transfer` 支持 ArrayBuffer 零拷贝（RX 行批转发，评审 v2 P12）。 */
  post(message: { type: string; payload?: unknown }, transfer?: Transferable[]): void {
    if (!this.worker) return;
    if (this.pending.size >= MAX_PENDING_MESSAGES) {
      console.warn(`[pluginHost] ${this.pluginId} pending 超限，丢弃事件: ${message.type}`);
      return;
    }
    this.worker.postMessage(message, transfer ?? []);
  }

  /** 注册插件事件处理器（events.on 的宿主侧实现）。返回注销。 */
  onEvent(type: string, handler: (payload: unknown) => void): () => void {
    let set = this.eventHandlers.get(type);
    if (!set) {
      set = new Set();
      this.eventHandlers.set(type, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
    };
  }

  private dispatchEvent(type: string, payload: unknown): void {
    const handlers = this.eventHandlers.get(type);
    if (!handlers) return;
    for (const h of handlers) {
      try {
        h(payload);
      } catch (e) {
        console.error(`[pluginHost] ${this.pluginId} event handler failed for ${type}:`, e);
      }
    }
  }

  /** 当前 config 里的授予权限（实时读，不缓存——撤销即时生效）。 */
  private currentGrantedPermissions(): string[] {
    const cfg = useAppStore.getState().config;
    const entry = cfg.pluginConfigs?.find((p) => p.id === this.pluginId);
    return entry?.grantedPermissions ?? [];
  }
}

/**
 * PluginHostManager — 全插件会话注册表（主窗单例）。
 * 宿主 UI 扩展点（按钮/菜单）经它把点击转成 `ui.buttonClick` 事件。
 */
export class PluginHostManager {
  private readonly sessions = new Map<string, PluginSession>();
  private callbacks: PluginHostCallbacks = {};

  setCallbacks(cb: PluginHostCallbacks): void {
    this.callbacks = cb;
  }

  /** 获取插件会话（未启用/不存在返回 null）。 */
  get(pluginId: string): PluginSession | null {
    return this.sessions.get(pluginId) ?? null;
  }

  /** 启用插件：建会话 + start（幂等——已启用则忽略）。 */
  async enable(pluginId: string): Promise<void> {
    if (this.sessions.has(pluginId)) return;
    const session = new PluginSession(pluginId);
    this.sessions.set(pluginId, session);
    try {
      await session.start(this.callbacks);
    } catch (e) {
      this.sessions.delete(pluginId);
      console.error(`[pluginHost] enable ${pluginId} failed:`, e);
      throw e;
    }
  }

  /** 禁用插件：停止会话（worker terminate）。 */
  disable(pluginId: string): void {
    const session = this.sessions.get(pluginId);
    if (session) {
      session.stop();
      this.sessions.delete(pluginId);
    }
  }

  /** 按 config 同步会话：启用的有会话，禁用的无。幂等，返回发生的变化数。 */
  syncWithConfig(): number {
    const cfg = useAppStore.getState().config;
    const enabledIds = new Set(
      (cfg.pluginConfigs ?? []).filter((p) => p.enabled).map((p) => p.id),
    );
    let changes = 0;
    // 停掉已禁用的。
    for (const [id, session] of this.sessions) {
      if (!enabledIds.has(id)) {
        session.stop();
        this.sessions.delete(id);
        changes++;
      }
    }
    // 启动新启用的（异步，不阻塞）。
    for (const id of enabledIds) {
      if (!this.sessions.has(id)) {
        void this.enable(id).catch((e) => {
          console.error(`[pluginHost] sync enable ${id} failed:`, e);
        });
        changes++;
      }
    }
    return changes;
  }

  /** 全部停止（应用关闭/测试）。 */
  dispose(): void {
    for (const session of this.sessions.values()) {
      session.stop();
    }
    this.sessions.clear();
  }

  /** 会话数（测试/诊断）。 */
  get size(): number {
    return this.sessions.size;
  }
}

/** 主窗插件宿主单例。 */
export const pluginHost = new PluginHostManager();
