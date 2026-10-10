/**
 * pluginHost — 插件 Worker 宿主（issue #17，评审 v2 D1/D3/D5/P5/P6）
 *
 * 职责：
 * - 一个启用插件 = 一个 `PluginSession`：后端读 manifest.entry → Blob URL → `Worker`
 *   （评审 v2 P6 加载路径；生产 CSP `script-src 'self' blob:` 已放行，见 D8）。
 * - RPC 桥：宿主 API 调用（worker 侧 `plugin.api.<op>(...)`）→ 本层执行
 *   `{seq, op, args}` 消息；**调用时权限校验**（评审 v2 P7）——每次 RPC 按当前
 *   插件 grantedPermissions 决定放行，撤销即时生效（worker 内旧引用不残留）。
 * - 宿主 → 插件事件：`ui.buttonClick` / `rx.line` / `lifecycle` 等，
 *   按 worker ack 限制并发投递。
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
import i18n from '../i18n';
import { PLUGIN_HTTP_RPC_TIMEOUT_MS, PLUGIN_RPC_TIMEOUT_MS, wrapPluginCode } from './pluginBridge';
import { executeHostApi } from './pluginHostApi';
import { checkOpAllowed } from './pluginRpc';
import { removePluginPanel } from './pluginPanelRegistry';
import { syncStorePluginConfigs } from './pluginConfigSnapshot';
import type { PluginManifestView } from '../types';

/** 连续崩溃阈值：达到后写 disabled（评审 v2 P5 防持久 DoS）。 */
export const MAX_CRASHES_BEFORE_DISABLE = 3;
/** 崩溃计数窗口：启用后该秒数内的崩溃计入「启动即崩」；之外重置计数。 */
export const CRASH_WINDOW_MS = 10_000;
/** Maximum unacknowledged events and their total RX payload bytes per worker. */
export const MAX_PENDING_MESSAGES = 32;
export const MAX_PENDING_EVENT_BYTES = 1024 * 1024;
/** Control traffic has its own acknowledgement slots and bounded overflow queue, independent of RX. */
export const MAX_PENDING_CONTROL_MESSAGES = 32;

const sessionListeners = new Set<() => void>();
export function subscribePluginSessions(listener: () => void): () => void {
  sessionListeners.add(listener);
  return () => sessionListeners.delete(listener);
}
function notifySessionListeners(): void {
  for (const listener of sessionListeners) listener();
}
function controlMessageBytes(message: { type: string; payload?: unknown }): number {
  if (!message.type.startsWith('view.')) return 0;
  return new TextEncoder().encode(JSON.stringify(message.payload ?? null)).byteLength;
}

/** Normalize the raw manifest using Rust's relative-path and optional-scope wire conventions. */
function normalizeManifest(value: unknown, pluginId: string): PluginManifestView {
  const invalid = (): never => { throw new Error('invalid plugin manifest'); };
  const isObject = (item: unknown): item is Record<string, unknown> =>
    item !== null && typeof item === 'object' && !Array.isArray(item);
  const strings = (items: unknown): items is string[] =>
    Array.isArray(items) && items.every((item) => typeof item === 'string');
  if (!isObject(value) || value.id !== pluginId || typeof value.entry !== 'string' ||
    !value.entry.trim() || !strings(value.permissions)) return invalid();
  const path = value.entry.replace(/\\/g, '/');
  if (path.startsWith('/') || /^[a-z]:/i.test(path)) return invalid();
  const parts = path.split('/');
  if (parts.includes('..')) return invalid();
  const entry = parts.filter((part) => part !== '' && part !== '.').join('/');
  if (!entry) return invalid();
  const normalized: Record<string, unknown> = { ...value, entry };
  if (value.requires != null && !strings(value.requires)) return invalid();
  for (const [scope, member] of [
    ['serial', 'portWhitelist'], ['http', 'urlWhitelist'], ['shell', 'executableWhitelist'],
  ]) {
    const raw = value[scope];
    if (raw == null) {
      normalized[scope] = undefined;
    } else {
      if (!isObject(raw)) return invalid();
      const items = raw[member] === undefined ? [] : raw[member];
      if (!strings(items) || items.some((item) => !item.trim())) return invalid();
      normalized[scope] = { ...raw, [member]: items };
    }
  }
  if (value.ui == null) {
    normalized.ui = undefined;
  } else {
    if (!isObject(value.ui)) return invalid();
    const ui: Record<string, unknown> = { ...value.ui };
    for (const key of ['buttons', 'menuItems']) {
      const items = value.ui[key] === undefined ? [] : value.ui[key];
      if (!Array.isArray(items)) return invalid();
      ui[key] = items.map((item: unknown) => {
        if (!isObject(item) || typeof item.id !== 'string' || typeof item.label !== 'string' ||
          (item.target != null && typeof item.target !== 'string') ||
          (key === 'buttons' && item.icon != null && typeof item.icon !== 'string')) return invalid();
        return { ...item, target: item.target ?? undefined, ...(key === 'buttons' ? { icon: item.icon ?? undefined } : {}) };
      });
    }
    const views = value.ui.views ?? [];
    if (!Array.isArray(views)) return invalid();
    ui.views = views.map((item: unknown) => {
      if (!isObject(item) || typeof item.id !== 'string' || typeof item.label !== 'string' ||
        typeof item.entry !== 'string' || !strings(item.styles ?? []) || !strings(item.assets ?? []) ||
        !strings(item.modes) || !strings(item.placements) ||
        !['bytes', 'lines', 'none'].includes(String(item.input)) ||
        !['required', 'optional', 'none'].includes(String(item.portBinding))) return invalid();
      return { ...item, styles: item.styles ?? [], assets: item.assets ?? [], restoreOnStartup: item.restoreOnStartup === true };
    });
    normalized.ui = ui;
  }
  return normalized as unknown as PluginManifestView;
}
/** 插件宿主可执行动作集合——供宿主 UI 调用的回调。 */
export interface PluginHostCallbacks {
  /** 插件崩溃/自动禁用时通知 UI（设置页刷新列表）。 */
  onPluginCrashed?: (pluginId: string, reason: string) => void;
}

/** 一个插件的运行时会话。 */
export class PluginSession {
  readonly pluginId: string;
  readonly installGeneration: string;
  private worker: Worker | null = null;
  /** 插件 manifest wire 视图（启动时缓存）——serial.send 端口作用域校验用（P10）。 */
  private manifest: PluginManifestView | null = null;
  private generation = 0;
  private starting: Promise<void> | null = null;
  private readonly eventsInFlight = new Map<number, number>();
  private readonly controlsInFlight = new Set<number>();
  private readonly pendingControls: Array<{ message: { type: string; payload?: unknown }; transfer?: Transferable[] }> = [];
  private readonly viewEvents = new Map<number, string>();
  private eventSeq = 0;
  private eventBytes = 0;
  private lastBackpressureNotice = 0;
  private droppedRxEvents = false;
  private crashCount = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private crashWindowStart = 0;
  /** Retirement callbacks for this worker's RPC slots; backend operations may continue after retirement. */
  private readonly retireRequests = new Set<() => void>();

  constructor(pluginId: string) {
    this.pluginId = pluginId;
    this.installGeneration = useAppStore.getState().config.pluginConfigs?.find((entry) => entry.id === pluginId)?.installGeneration ?? '';
  }

  /** 是否已加载（worker 存活）。 */
  get loaded(): boolean {
    return this.worker !== null;
  }

  get epoch(): number { return this.generation; }

  /** Enable and load the worker; every await checks whether this start was cancelled. */
  async start(callbacks?: PluginHostCallbacks): Promise<void> {
    if (this.worker) return;
    if (this.starting) return this.starting;
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const generation = ++this.generation;
    const start = async (): Promise<void> => {
      const raw = await pluginService.readPluginAsset(this.pluginId, 'manifest.json');
      if (generation !== this.generation || !this.isCurrentInstallation()) return;
      if (raw === null) throw new Error('plugin manifest missing');
      const manifest = normalizeManifest(JSON.parse(raw), this.pluginId);
      const userCode = await pluginService.readPluginAsset(this.pluginId, manifest.entry);
      if (generation !== this.generation || !this.isCurrentInstallation()) return;
      if (userCode === null) throw new Error('plugin entry missing');
      const blob = new Blob([wrapPluginCode(userCode)], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      let worker: Worker;
      try {
        worker = new Worker(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      if (generation !== this.generation || !this.isCurrentInstallation()) {
        worker.terminate();
        return;
      }
      this.manifest = manifest;
      this.worker = worker;
      worker.onmessage = (ev: MessageEvent) => {
        if (this.worker !== worker) return;
        const msg = ev.data as { seq?: number; op?: string; type?: string; payload?: unknown; eventAck?: number; args?: unknown };
        if (!msg) return;
        if (typeof msg.eventAck === 'number') {
          const bytes = this.eventsInFlight.get(msg.eventAck);
          if (bytes !== undefined) {
            this.eventsInFlight.delete(msg.eventAck);
            this.eventBytes -= bytes;
            this.viewEvents.delete(msg.eventAck);
            this.controlsInFlight.delete(msg.eventAck);
            this.flushControls();
            if (this.droppedRxEvents && this.post({ type: 'rx.dropped', payload: { reason: 'worker-backpressure' } })) {
              this.droppedRxEvents = false;
            }
          }
        } else if (typeof msg.op === 'string') {
          void this.handleWorkerRequest(worker, msg as { seq: number; op: string; args?: unknown });
        } else if (msg.type === '__plugin_crash') {
          void this.handleCrash(String(msg.payload ?? 'unhandled rejection'), callbacks);
        } else if (msg.type === '__plugin_view_error') {
          const payload = msg.payload as { instanceId?: unknown; error?: unknown } | null;
          if (payload && typeof payload.instanceId === 'string') {
            void import('./pluginViewRuntime').then(runtime => runtime.failPluginViewInstance(
              this.pluginId, payload.instanceId as string, String(payload.error ?? 'plugin view failed')));
          }
        } else if (msg.type === '__plugin_view_ready') {
          const payload = msg.payload as { instanceId?: unknown } | null;
          if (payload && typeof payload.instanceId === 'string') {
            void import('./pluginViewRuntime').then(runtime => runtime.markPluginViewWorkerReady(this.pluginId, payload.instanceId as string));
          }
        }
      };
      worker.onerror = (e) => {
        if (this.worker === worker) void this.handleCrash(e.message || 'worker error', callbacks);
      };
      this.post({ type: 'lifecycle', payload: { state: 'enabled' } });
      notifySessionListeners();
    };
    const pending = start();
    this.starting = pending;
    try {
      await pending;
    } finally {
      if (this.starting === pending) this.starting = null;
    }
  }

  /** Worker → host RPC: deadlines retire reply slots, not already-started backend I/O. */
  private async handleWorkerRequest(worker: Worker, req: { seq: number; op: string; args?: unknown }): Promise<void> {
    if (!Number.isSafeInteger(req.seq) || this.worker !== worker) return;
    const respond = (payload: { ok: boolean; result?: unknown; error?: string }): void => {
      if (this.worker === worker) worker.postMessage({ seq: req.seq, ...payload });
    };
    if (this.retireRequests.size >= MAX_PENDING_MESSAGES) {
      respond({ ok: false, error: 'plugin RPC capacity exceeded' });
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    const retire = (): boolean => {
      if (!active) return false;
      active = false;
      clearTimeout(timer);
      this.retireRequests.delete(retire);
      return true;
    };
    this.retireRequests.add(retire);
    // Native file selection/export waits for explicit user action. HTTP's backend timeout is 15s.
    if (req.op !== 'fs.openDialog' && req.op !== 'ui.panel.export') {
      timer = setTimeout(() => {
        if (retire()) respond({ ok: false, error: 'plugin RPC timed out' });
      }, req.op === 'http.request' ? PLUGIN_HTTP_RPC_TIMEOUT_MS : PLUGIN_RPC_TIMEOUT_MS);
    }
    try {
      // Permission is checked at call time, including disabled plugins with permissionless ops.
      const config = useAppStore.getState().config.pluginConfigs?.find((p) => p.id === this.pluginId);
      if (!config?.enabled || config.installGeneration !== this.installGeneration) {
        if (retire()) respond({ ok: false, error: 'plugin disabled' });
        return;
      }
      const denied = checkOpAllowed(req.op, config.grantedPermissions, req.args);
      if (denied) {
        if (retire()) respond({ ok: false, error: denied });
        return;
      }
      const result = await executeHostApi(this.pluginId, req.op, req.args, this.manifest);
      if (retire()) respond({ ok: true, result });
    } catch (e) {
      if (!active) return;
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error(`[pluginHost] ${this.pluginId} api ${req.op} failed:`, errMsg);
      if (retire()) respond({ ok: false, error: errMsg });
    }
  }

  /** 停止并销毁 worker（禁用/卸载时）。 */
  stop(): void {
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.starting = null;
    ++this.generation;
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    // Stop retires old worker's slots now; a late backend completion cannot reply to a new worker.
    for (const retire of this.retireRequests) retire();
    this.manifest = null;
    this.eventsInFlight.clear();
    this.viewEvents.clear();
    this.controlsInFlight.clear();
    this.pendingControls.length = 0;
    this.eventBytes = 0;
    this.droppedRxEvents = false;
    notifySessionListeners();
  }

  private isCurrentInstallation(): boolean {
    return useAppStore.getState().config.pluginConfigs?.some((entry) =>
      entry.id === this.pluginId && entry.enabled && entry.installGeneration === this.installGeneration) ?? false;
  }

  /** Loading can fail transiently while another plugin owns the disk gate. */
  async recoverStartupFailure(reason: string, callbacks?: PluginHostCallbacks): Promise<void> {
    if (this.isCurrentInstallation()) await this.handleCrash(reason, callbacks, true);
  }

  /** 崩溃处理：计数窗口内连续崩溃达阈值 → 写 disabled + 通知。 */
  private async handleCrash(reason: string, callbacks?: PluginHostCallbacks, startup = false): Promise<void> {
    const now = Date.now();
    if (now - this.crashWindowStart > CRASH_WINDOW_MS) {
      this.crashCount = 0;
      this.crashWindowStart = now;
    }
    this.crashCount++;
    this.stop();
    const generation = this.generation;
    if (this.crashCount >= MAX_CRASHES_BEFORE_DISABLE) {
      try {
        const snapshot = await pluginService.setPluginEnabled(this.pluginId, false, this.installGeneration);
        if (generation !== this.generation) return;
        syncStorePluginConfigs(snapshot);
        useToastStore.getState().push({
          severity: 'warning',
          message: i18n.t('plugins.crashAutoDisabled', { id: this.pluginId, reason }),
        });
      } catch (e) {
        console.error('[pluginHost] failed to disable crashed plugin:', e);
      }
    } else {
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        if (this.generation !== generation || !this.isCurrentInstallation()) return;
        void this.start(callbacks).catch((e) => {
          console.error(`[pluginHost] restart ${this.pluginId} failed:`, e);
          if (this.generation === generation + 1) void this.handleCrash(String(e), callbacks, true);
        });
      }, startup ? 500 * this.crashCount : 100);
    }
    if (this.crashCount >= MAX_CRASHES_BEFORE_DISABLE) callbacks?.onPluginCrashed?.(this.pluginId, reason);
  }

  /** Bounded delivery: RX may drop; control events reserve independent slots and queue until ACK. */
  post(message: { type: string; payload?: unknown }, transfer?: Transferable[]): boolean {
    if (!this.worker) return false;
    if (message.type === 'view.close') {
      const payload = message.payload as { instanceId?: string } | undefined;
      const instanceId = payload?.instanceId;
      if (!instanceId) return false;
      for (const [eventId, viewId] of this.viewEvents) {
        if (viewId !== instanceId) continue;
        this.eventBytes -= this.eventsInFlight.get(eventId) ?? 0;
        this.eventsInFlight.delete(eventId); this.controlsInFlight.delete(eventId); this.viewEvents.delete(eventId);
      }
      for (let index = this.pendingControls.length - 1; index >= 0; index--) {
        const pending = this.pendingControls[index].message;
        const pendingPayload = pending.payload as { instanceId?: string; context?: { viewInstanceId?: string } } | undefined;
        if (pendingPayload?.instanceId === instanceId || pendingPayload?.context?.viewInstanceId === instanceId) this.pendingControls.splice(index, 1);
      }
      try { this.worker.postMessage(message); this.flushControls(); return true; }
      catch { return false; }
    }
    const isRx = message.type === 'rx.line' || message.type === 'rx.bytes' || message.type === 'view.input';
    if (!isRx) {
      const bytes = controlMessageBytes(message);
      if (bytes > 32 * 1024 || this.eventBytes + bytes > MAX_PENDING_EVENT_BYTES) return false;
      if (this.controlsInFlight.size >= MAX_PENDING_CONTROL_MESSAGES) {
        if (this.pendingControls.length >= MAX_PENDING_CONTROL_MESSAGES) return false;
        this.pendingControls.push({ message, transfer });
        return true;
      }
      return this.sendEvent(message, bytes, true, transfer);
    }
    let bytes = 0;
    if (message.type === 'rx.line' && Array.isArray(message.payload)) {
      bytes = message.payload.reduce((sum: number, line: { rawData?: Uint8Array }) => sum + (line.rawData?.byteLength ?? 0), 0);
    } else if (message.type === 'rx.bytes' && Array.isArray(message.payload)) {
      bytes = message.payload.reduce((sum: number, chunk: { bytes?: Uint8Array }) => sum + (chunk.bytes?.byteLength ?? 0), 0);
    } else if (message.type === 'view.input') {
      if (this.pendingControls.length > 0) return false;
      const payload = message.payload as { batch?: Array<{ bytes?: Uint8Array; rawData?: Uint8Array }> } | undefined;
      bytes = payload?.batch?.reduce((sum, item) => sum + (item.bytes?.byteLength ?? item.rawData?.byteLength ?? 0), 0) ?? 0;
    }
    if (this.eventsInFlight.size - this.controlsInFlight.size >= MAX_PENDING_MESSAGES ||
      this.eventBytes + bytes > MAX_PENDING_EVENT_BYTES) {
      if (message.type === 'rx.line' || message.type === 'rx.bytes') {
        this.droppedRxEvents = true;
        const now = Date.now();
        if (now - this.lastBackpressureNotice >= 5000) {
          this.lastBackpressureNotice = now;
          console.warn(`[pluginHost] ${this.pluginId} worker backlog; RX event dropped`);
        }
      }
      return false;
    }
    return this.sendEvent(message, bytes, false, transfer);
  }

  private flushControls(): void {
    while (this.worker && this.pendingControls.length > 0 &&
      this.controlsInFlight.size < MAX_PENDING_CONTROL_MESSAGES) {
      const next = this.pendingControls.shift()!;
      const bytes = controlMessageBytes(next.message);
      if (this.eventBytes + bytes > MAX_PENDING_EVENT_BYTES) {
        this.pendingControls.unshift(next);
        return;
      }
      this.sendEvent(next.message, bytes, true, next.transfer);
    }
  }

  private sendEvent(message: { type: string; payload?: unknown }, bytes: number, control: boolean,
    transfer?: Transferable[]): boolean {
    const worker = this.worker;
    if (!worker) return false;
    const eventId = ++this.eventSeq;
    this.eventsInFlight.set(eventId, bytes);
    if (message.type.startsWith('view.')) {
      const payload = message.payload as { instanceId?: string; context?: { viewInstanceId?: string } } | undefined;
      const instanceId = payload?.instanceId ?? payload?.context?.viewInstanceId;
      if (instanceId) this.viewEvents.set(eventId, instanceId);
    }
    if (control) this.controlsInFlight.add(eventId);
    this.eventBytes += bytes;
    try {
      worker.postMessage({ ...message, eventId }, transfer ?? []);
      return true;
    } catch (e) {
      this.eventsInFlight.delete(eventId);
      this.viewEvents.delete(eventId);
      this.controlsInFlight.delete(eventId);
      this.eventBytes -= bytes;
      throw e;
    }
  }

}

/**
 * PluginHostManager — 全插件会话注册表（主窗单例）。
 * 宿主 UI 扩展点（按钮/菜单）经它把点击转成 `ui.buttonClick` 事件。
 */
export class PluginHostManager {
  private readonly sessions = new Map<string, PluginSession>();
  private readonly starts = new Map<string, Promise<void>>();
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
    const pending = this.starts.get(pluginId);
    if (pending) return pending;
    let session = this.sessions.get(pluginId);
    if (!session) {
      session = new PluginSession(pluginId);
      this.sessions.set(pluginId, session);
    }
    const current = session;
    const start = current.start(this.callbacks).catch(async (error) => {
      if (this.sessions.get(pluginId) === current) await current.recoverStartupFailure(String(error), this.callbacks);
    });
    this.starts.set(pluginId, start);
    try {
      await start;
    } finally {
      if (this.starts.get(pluginId) === start) this.starts.delete(pluginId);
    }
  }

  /** 禁用插件：停止会话（worker terminate）+ 清理输出面板。 */
  disable(pluginId: string): void {
    const session = this.sessions.get(pluginId);
    if (session) {
      session.stop();
      this.sessions.delete(pluginId);
      this.starts.delete(pluginId);
    }
    removePluginPanel(pluginId);
  }

  /** Keep workers bound to code identity; grants may change without restarting them. */
  syncWithConfig(retryFailed = false): number {
    const entries = useAppStore.getState().config.pluginConfigs ?? [];
    let changes = 0;
    for (const [id, session] of this.sessions) {
      const entry = entries.find((plugin) => plugin.id === id && plugin.enabled);
      if (!entry || entry.installGeneration !== session.installGeneration) {
        this.disable(id);
        changes++;
      }
    }
    for (const entry of entries) {
      if (entry.enabled && (!this.sessions.has(entry.id) || (retryFailed && !this.sessions.get(entry.id)!.loaded))) {
        void this.enable(entry.id).catch((error) => {
          console.error(`[pluginHost] sync enable ${entry.id} failed:`, error);
        });
        changes++;
      }
    }
    return changes;
  }

  /** 全部停止（应用关闭/测试）。 */
  dispose(): void {
    for (const id of [...this.sessions.keys()]) this.disable(id);
  }

  /** 会话数（测试/诊断）。 */
  get size(): number {
    return this.sessions.size;
  }
}

/** 主窗插件宿主单例。 */
export const pluginHost = new PluginHostManager();
