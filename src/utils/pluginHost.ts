/**
 * pluginHost — 插件 Worker 宿主（issue #17，评审 v2 D1/D3/D5/P5/P6）
 *
 * 职责：
 * - 一个启用插件 = 一个 `PluginSession`：后端读 manifest.entry → Blob URL → `Worker`
 *   （评审 v2 P6 加载路径；生产 CSP `script-src 'self' 'wasm-unsafe-eval' blob:` 已放行，见 D8）。
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
import { hasNoRpcDeadline, PLUGIN_BINARY_RPC_TIMEOUT_MS, PLUGIN_RPC_TIMEOUT_MS, wrapPluginCode } from './pluginBridge';
import { cleanHostText, executeHostApi } from './pluginHostApi';
import { cancelPluginHttp } from './pluginHttp';
import { MAX_VIEW_BINARY_TRANSFER_BYTES, VIEW_BINARY_ACK_TIMEOUT_MS } from './pluginViewBinary';
import { checkOpAllowed } from './pluginRpc';
import { removePluginPanel } from './pluginPanelRegistry';
import { PluginLogQuota } from './pluginLogQuota';
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
/** How long a managed session may take to post __plugin_ready after its Worker starts. */
export const PLUGIN_READY_TIMEOUT_MS = 10_000;
/** Post-ready health probe cadence and consecutive unanswered probes that count as a crash. */
export const PLUGIN_HEALTH_INTERVAL_MS = 30_000;
export const PLUGIN_HEALTH_MAX_MISSES = 2;
/**
 * Host→Worker view binary transfers have their own byte budget. They only take a
 * control slot; their payload must never consume the RX/control `eventBytes`
 * budget (a slow Worker handler would otherwise starve button clicks and RX).
 */
export const MAX_PENDING_BINARY_BYTES = MAX_VIEW_BINARY_TRANSFER_BYTES;
/** Concurrent host→Worker binary transfers allowed per view instance. */
export const MAX_PENDING_BINARY_TRANSFERS_PER_VIEW = 4;
/** `http.cancel` may bypass the ordinary RPC slot cap by at most this many entries. */
export const MAX_CANCEL_RPC_BYPASS = 64;
/** Process-wide epoch source so a reloaded session never reuses view epochs. */
let workerEpochSeq = 0;

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
  if (!isObject(value) || value.id !== pluginId || !strings(value.permissions)) return invalid();
  if (value.entry !== undefined && typeof value.entry !== 'string') return invalid();
  let entry = '';
  if (typeof value.entry === 'string' && value.entry.trim()) {
    const path = value.entry.replace(/\\/g, '/');
    if (path.startsWith('/') || /^[a-z]:/i.test(path)) return invalid();
    const parts = path.split('/');
    if (parts.includes('..')) return invalid();
    entry = parts.filter((part) => part !== '' && part !== '.').join('/');
    if (!entry) return invalid();
  }
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
    // No Worker requires an explicit nonempty trusted-web view set.
    if (!entry) return invalid();
    normalized.ui = undefined;
  } else {
    if (!isObject(value.ui)) return invalid();
    const ui: Record<string, unknown> = { ...value.ui };
    let workerOnlyUiCount = 0;
    for (const key of ['buttons', 'menuItems']) {
      const items = value.ui[key] === undefined ? [] : value.ui[key];
      if (!Array.isArray(items)) return invalid();
      const mapped = items.map((item: unknown) => {
        if (!isObject(item) || typeof item.id !== 'string' || typeof item.label !== 'string' ||
          (item.target != null && typeof item.target !== 'string') ||
          (key === 'buttons' && item.icon != null && typeof item.icon !== 'string')) return invalid();
        return { ...item, target: item.target ?? undefined, ...(key === 'buttons' ? { icon: item.icon ?? undefined } : {}) };
      });
      workerOnlyUiCount += mapped.length;
      ui[key] = mapped;
    }
    const views = value.ui.views ?? [];
    if (!Array.isArray(views)) return invalid();
    const normalizedViews = views.map((item: unknown) => {
      if (!isObject(item) || typeof item.id !== 'string' || typeof item.label !== 'string' ||
        typeof item.entry !== 'string' || !strings(item.styles ?? []) || !strings(item.assets ?? []) ||
        !strings(item.modes) || !strings(item.placements) ||
        !['bytes', 'lines', 'none'].includes(String(item.input)) ||
        !['required', 'optional', 'none'].includes(String(item.portBinding)) ||
        (item.worker !== undefined && typeof item.worker !== 'boolean')) return invalid();
      const mode = item.mode ?? 'isolated';
      if (mode !== 'isolated' && mode !== 'trusted-web') return invalid();
      // worker:false is only meaningful for an independent trusted-web page.
      if (item.worker === false && (mode !== 'trusted-web' || item.input !== 'none')) return invalid();
      return {
        ...item, mode, input: item.input, portBinding: item.portBinding,
        styles: item.styles ?? [], assets: item.assets ?? [],
        restoreOnStartup: item.restoreOnStartup === true,
        worker: item.worker === undefined ? undefined : item.worker === true,
      };
    });
    ui.views = normalizedViews;
    normalized.ui = ui;
    if (!entry) {
      // No Worker: only independent trusted-web pages may remain.
      if (workerOnlyUiCount > 0) return invalid();
      if (normalizedViews.length === 0 ||
        normalizedViews.some((view) => view.mode !== 'trusted-web' || view.input !== 'none')) return invalid();
    }
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
  /** Bridge posted __plugin_ready after synchronous user initialization. */
  private ready = false;
  /** Settles when the current start attempt reaches __plugin_ready (or fails). */
  private readiness: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  /** Manifest declares no Worker entry (pure trusted-web plugin). */
  private noWorker = false;
  /** Host→Worker binary view transfers awaiting the bridge ack. */
  private readonly pendingBinary = new Map<number, {
    instanceId: string;
    documentId: string;
    bytes: number;
    resolve: () => void;
    reject: (error: Error) => void;
  }>();
  /** Independent byte budget for pending view binary transfers (not part of eventBytes). */
  private binaryBytesInFlight = 0;
  private readonly pendingBinaryPerInstance = new Map<string, number>();
  /** Monotonic per-session epoch; a restart never reuses an old view's epoch. */
  private readonly epochBase = ++workerEpochSeq;
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
  /** Host-side RPC error logging is plugin-triggerable; apply the same token
   *  bucket as explicit log calls so a denied-op loop cannot flood diaglog. */
  private readonly errorLogQuota = new PluginLogQuota();
  /** Managed sessions (host-owned) arm the ready deadline and post-ready health probe. */
  private readonly managed: boolean;
  private callbacks: PluginHostCallbacks = {};
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private healthTimer: ReturnType<typeof setTimeout> | null = null;
  private healthPendingEventId: number | null = null;
  private healthMisses = 0;

  constructor(pluginId: string, managed = false) {
    this.pluginId = pluginId;
    this.managed = managed;
    this.installGeneration = useAppStore.getState().config.pluginConfigs?.find((entry) => entry.id === pluginId)?.installGeneration ?? '';
  }

  /** 是否已加载（worker 存活）。 */
  get loaded(): boolean {
    return this.worker !== null;
  }

  get epoch(): number { return this.epochBase + this.generation; }

  private settleReady(error?: Error, generation = this.generation): void {
    if (generation !== this.generation) return;
    const resolve = this.readyResolve;
    const reject = this.readyReject;
    this.readyResolve = null;
    this.readyReject = null;
    if (error) reject?.(error);
    else resolve?.();
  }

  private clearReadyTimer(): void {
    if (this.readyTimer !== null) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
  }

  /**
   * Managed sessions must post __plugin_ready within PLUGIN_READY_TIMEOUT_MS.
   * A Worker that never yields during synchronous initialization otherwise looks
   * "loaded" forever and makes explicit reloads await readiness indefinitely.
   */
  private armReadyTimeout(worker: Worker, generation: number): void {
    this.clearReadyTimer();
    if (!this.managed) return;
    this.readyTimer = setTimeout(() => {
      this.readyTimer = null;
      if (this.worker !== worker || this.generation !== generation || this.ready) return;
      const error = new Error('plugin worker ready timed out');
      this.settleReady(error);
      void this.handleCrash(error.message);
    }, PLUGIN_READY_TIMEOUT_MS);
  }

  private clearHealthTimer(): void {
    if (this.healthTimer !== null) {
      clearTimeout(this.healthTimer);
      this.healthTimer = null;
    }
    this.healthPendingEventId = null;
    this.healthMisses = 0;
  }

  private armHealthCheck(): void {
    this.clearHealthTimer();
    if (!this.managed) return;
    this.healthTimer = setTimeout(() => this.healthTick(), PLUGIN_HEALTH_INTERVAL_MS);
  }

  /**
   * A live Worker answers the bridge-generated event ack for `__plugin_health`.
   * Consecutive unanswered probes mean the Worker scope died silently
   * (`self.close()`, OOM kill, ...), which never fires `worker.onerror`.
   */
  private healthTick(): void {
    this.healthTimer = null;
    if (!this.worker || !this.ready) return;
    if (this.healthPendingEventId === null) {
      const eventId = this.sendEvent({ type: '__plugin_health' }, 0, true);
      if (eventId === null) this.healthMisses += 1;
      else this.healthPendingEventId = eventId;
    } else {
      this.healthMisses += 1;
    }
    if (this.healthMisses >= PLUGIN_HEALTH_MAX_MISSES) {
      const reason = 'plugin worker stopped responding to health checks';
      this.reportRuntimeError(reason);
      void this.handleCrash(reason);
      return;
    }
    this.healthTimer = setTimeout(() => this.healthTick(), PLUGIN_HEALTH_INTERVAL_MS);
  }

  /**
   * Start and wait for the current worker to finish synchronous initialization.
   * Rejects on load/parse/startup failure instead of resolving into a scheduled
   * retry; used by explicit reload.
   */
  async startReady(callbacks?: PluginHostCallbacks): Promise<void> {
    const starting = this.start(callbacks);
    // Capture before awaiting disk I/O: stop/restart may replace this.readiness.
    const readiness = this.readiness;
    await starting;
    if (!readiness) throw new Error('plugin worker not started');
    await readiness;
  }

  /** Enable and load the worker; every await checks whether this start was cancelled. */
  async start(callbacks?: PluginHostCallbacks): Promise<void> {
    if (callbacks) this.callbacks = callbacks;
    if (this.worker || this.noWorker) return;
    if (this.starting) return this.starting;
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const generation = ++this.generation;
    this.readiness = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    // Normal enable does not await readiness; keep fatal settlement from surfacing
    // as an unhandled rejection.
    void this.readiness.catch(() => undefined);
    const start = async (): Promise<void> => {
      try {
      const raw = await pluginService.readPluginAsset(this.pluginId, 'manifest.json');
      if (generation !== this.generation || !this.isCurrentInstallation()) {
        this.settleReady(new Error('plugin start cancelled'), generation);
        return;
      }
      if (raw === null) throw new Error('plugin manifest missing');
      const manifest = normalizeManifest(JSON.parse(raw), this.pluginId);
      if (!manifest.entry) {
        // Pure trusted-web plugin: no fake/empty Worker is ever constructed.
        this.manifest = manifest;
        this.noWorker = true;
        this.settleReady();
        notifySessionListeners();
        return;
      }
      const userCode = await pluginService.readPluginAsset(this.pluginId, manifest.entry);
      if (generation !== this.generation || !this.isCurrentInstallation()) {
        this.settleReady(new Error('plugin start cancelled'), generation);
        return;
      }
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
        this.settleReady(new Error('plugin start cancelled'), generation);
        return;
      }
      this.manifest = manifest;
      this.ready = false;
      this.worker = worker;
      worker.onmessage = (ev: MessageEvent) => {
        if (this.worker !== worker) return;
        const msg = ev.data as {
          seq?: number; op?: string; type?: string; payload?: unknown;
          eventAck?: number; args?: unknown; ok?: boolean; error?: string;
        };
        if (!msg) return;
        if (typeof msg.eventAck === 'number') {
          if (msg.eventAck === this.healthPendingEventId) {
            this.healthPendingEventId = null;
            this.healthMisses = 0;
          }
          const binary = this.pendingBinary.get(msg.eventAck);
          if (binary) {
            this.pendingBinary.delete(msg.eventAck);
            this.releaseBinaryBudget(binary.instanceId, binary.bytes);
          }
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
          if (binary) {
            if (msg.ok === false) binary.reject(new Error(msg.error || 'view binary transfer failed'));
            else binary.resolve();
          }
        } else if (typeof msg.op === 'string') {
          void this.handleWorkerRequest(worker, msg as { seq: number; op: string; args?: unknown });
        } else if (msg.type === '__plugin_ready') {
          this.clearReadyTimer();
          this.ready = true;
          this.settleReady();
          this.armHealthCheck();
        } else if (msg.type === '__plugin_error') {
          // Ordinary post-ready async failures are diagnostics; the session lives.
          const reason = msg.payload;
          this.reportRuntimeError(
            reason !== null && typeof reason === 'object' && 'message' in reason
              ? String(reason.message ?? 'unhandled rejection')
              : String(reason ?? 'unhandled rejection'),
          );
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
        if (this.worker !== worker) return;
        // Before __plugin_ready this is a fatal load/parse/startup failure; after
        // it, an uncaught runtime error is reported without destroying the session.
        if (this.ready) {
          this.reportRuntimeError(e.message || 'worker error');
        } else {
          this.clearReadyTimer();
          this.settleReady(new Error(e.message || 'worker error'));
          void this.handleCrash(e.message || 'worker error');
        }
      };
      this.armReadyTimeout(worker, generation);
      this.post({ type: 'lifecycle', payload: { state: 'enabled' } });
      notifySessionListeners();
      } catch (error) {
        if (generation === this.generation) this.clearReadyTimer();
        this.settleReady(error instanceof Error ? error : new Error(String(error)), generation);
        throw error;
      }
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
    const respond = (payload: { ok: boolean; result?: unknown; error?: string }, transfer?: Transferable[]): void => {
      if (this.worker === worker) {
        if (transfer) worker.postMessage({ seq: req.seq, ...payload }, transfer);
        else worker.postMessage({ seq: req.seq, ...payload });
      }
    };
    const atCapacity = this.retireRequests.size >= MAX_PENDING_MESSAGES;
    if (atCapacity &&
      (req.op !== 'http.cancel' || this.retireRequests.size >= MAX_PENDING_MESSAGES + MAX_CANCEL_RPC_BYPASS)) {
      // Cancellation is the escape hatch for a saturated session, but the bypass
      // itself is bounded so a cancel flood cannot grow the slot set without limit.
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
    // File reads have no size cap; native selection/export wait for the user, and
    // HTTP waits on the network under the caller-supplied native timeout only.
    if (!hasNoRpcDeadline(req.op)) {
      timer = setTimeout(() => {
        if (retire()) respond({ ok: false, error: 'plugin RPC timed out' });
      }, req.op === 'view.sendBinary' ? PLUGIN_BINARY_RPC_TIMEOUT_MS : PLUGIN_RPC_TIMEOUT_MS);
    }
    try {
      // Admission and queued TTY effects share the same live worker/grant authority.
      const beforeSend = (): void => {
        if (!active || this.worker !== worker) throw new Error('plugin request retired');
        const config = useAppStore.getState().config.pluginConfigs?.find((p) => p.id === this.pluginId);
        if (!config?.enabled || config.installGeneration !== this.installGeneration) throw new Error('plugin disabled');
        const denied = checkOpAllowed(req.op, config.grantedPermissions, req.args);
        if (denied) throw new Error(denied);
      };
      beforeSend();
      const result = await executeHostApi(this.pluginId, req.op, req.args, this.manifest, beforeSend);
      if (retire()) {
        let transfer: Transferable[] | undefined;
        if (req.op === 'fs.read' && result instanceof Uint8Array) {
          transfer = [result.buffer];
        } else if (req.op === 'http.read' && result !== null && typeof result === 'object' && 'bytes' in result) {
          const { bytes } = result;
          if (bytes instanceof Uint8Array) transfer = [bytes.buffer];
        } else if (req.op === 'http.request' && result !== null && typeof result === 'object' && 'body' in result) {
          const { body } = result;
          if (body instanceof Uint8Array) transfer = [body.buffer];
        } else if (req.op === 'fs.openDialog' && result !== null && typeof result === 'object' && 'files' in result &&
          Array.isArray(result.files)) {
          const files = result.files.filter(
            (file): file is { bytes: Uint8Array } =>
              file !== null && typeof file === 'object' && 'bytes' in file && file.bytes instanceof Uint8Array,
          );
          if (files.length > 0) transfer = files.map((file) => file.bytes.buffer);
        }
        respond({ ok: true, result }, transfer);
      }
    } catch (e) {
      if (!active) return;
      const errMsg = e instanceof Error ? e.message : String(e);
      const verdict = this.errorLogQuota.tryConsume(Date.now());
      if (verdict.allowed) {
        console.error(`[pluginHost] ${this.pluginId} api ${cleanHostText(req.op)} failed:`, cleanHostText(errMsg));
      } else if (verdict.warn) {
        console.warn(`[pluginHost] ${this.pluginId} RPC 错误日志超限，已累计抑制 ${verdict.droppedTotal} 条`);
      }
      if (retire()) respond({ ok: false, error: errMsg });
    }
  }

  /** 停止并销毁 worker（禁用/卸载/重载时）。 */
  stop(): void {
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.starting = null;
    ++this.generation;
    // Wake every native open/read owned by this session; fresh request IDs on the
    // replacement generation are untouched.
    cancelPluginHttp(this.pluginId);
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    // Stop retires old worker's slots now; a late backend completion cannot reply to a new worker.
    for (const retire of this.retireRequests) retire();
    this.clearReadyTimer();
    this.clearHealthTimer();
    this.manifest = null;
    this.ready = false;
    this.noWorker = false;
    this.settleReady(new Error('plugin worker stopped'));
    this.readiness = null;
    for (const binary of this.pendingBinary.values()) binary.reject(new Error('plugin worker stopped'));
    this.pendingBinary.clear();
    this.binaryBytesInFlight = 0;
    this.pendingBinaryPerInstance.clear();
    this.eventsInFlight.clear();
    this.viewEvents.clear();
    this.controlsInFlight.clear();
    this.pendingControls.length = 0;
    this.eventBytes = 0;
    this.droppedRxEvents = false;
    notifySessionListeners();
  }

  /** Post-ready runtime diagnostics are rate-limited and never terminate the worker. */
  private reportRuntimeError(reason: string): void {
    const verdict = this.errorLogQuota.tryConsume(Date.now());
    const clean = cleanHostText(reason);
    if (verdict.allowed) {
      console.error(`[pluginHost] ${this.pluginId} runtime error:`, clean);
    } else if (verdict.warn) {
      console.warn(`[pluginHost] ${this.pluginId} 运行时错误日志超限，已累计抑制 ${verdict.droppedTotal} 条`);
    }
  }

  private isCurrentInstallation(): boolean {
    return useAppStore.getState().config.pluginConfigs?.some((entry) =>
      entry.id === this.pluginId && entry.enabled && entry.installGeneration === this.installGeneration) ?? false;
  }

  /** Loading can fail transiently while another plugin owns the disk gate. */
  async recoverStartupFailure(reason: string): Promise<void> {
    if (this.isCurrentInstallation()) await this.handleCrash(reason);
  }

  /** 崩溃处理：计数窗口内连续崩溃达阈值 → 写 disabled + 通知。 */
  private async handleCrash(reason: string): Promise<void> {
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
        void this.start(this.callbacks).catch((e) => {
          console.error(`[pluginHost] restart ${this.pluginId} failed:`, e);
          if (this.generation === generation + 1) void this.handleCrash(String(e));
        });
      }, 500 * this.crashCount);
    }
    if (this.crashCount >= MAX_CRASHES_BEFORE_DISABLE) this.callbacks.onPluginCrashed?.(this.pluginId, reason);
  }

  /** Bounded delivery: RX may drop; control events reserve independent slots and queue until ACK. */
  post(message: { type: string; payload?: unknown }, transfer?: Transferable[]): boolean {
    if (!this.worker) return false;
    if (message.type === 'view.document') {
      // Tiny trusted control event: must never be dropped by control byte/count caps.
      const payload = message.payload;
      if (payload === null || typeof payload !== 'object' || !('instanceId' in payload) ||
        !('documentId' in payload) || typeof payload.instanceId !== 'string' ||
        typeof payload.documentId !== 'string' || !payload.instanceId) return false;
      try {
        return this.sendEvent(message, controlMessageBytes(message), true) !== null;
      } catch {
        return false;
      }
    }
    if (message.type === 'view.close') {
      const payload = message.payload as { instanceId?: string } | undefined;
      const instanceId = payload?.instanceId;
      if (!instanceId) return false;
      for (const [eventId, binary] of [...this.pendingBinary]) {
        if (binary.instanceId !== instanceId) continue;
        this.pendingBinary.delete(eventId);
        this.releaseBinaryBudget(binary.instanceId, binary.bytes);
        this.eventsInFlight.delete(eventId);
        this.controlsInFlight.delete(eventId);
        this.viewEvents.delete(eventId);
        binary.reject(new Error('plugin view closed'));
      }
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
      if (bytes > 32 * 1024 || this.eventBytes + bytes > MAX_PENDING_EVENT_BYTES) {
        // A lossy view.message must never be surfaced as "capacity exceeded" to
        // pluginViewRuntime (it would retire an otherwise healthy view).
        if (message.type === 'view.message') {
          console.warn(`[pluginHost] ${this.pluginId} view message dropped: control byte budget full`);
          return true;
        }
        return false;
      }
      // Preserve control ordering: older queued control events drain first.
      this.flushControls();
      if (this.controlsInFlight.size >= MAX_PENDING_CONTROL_MESSAGES) {
        if (message.type === 'view.message') {
          console.warn(`[pluginHost] ${this.pluginId} view message dropped: control slots full`);
          return true;
        }
        if (this.pendingControls.length >= MAX_PENDING_CONTROL_MESSAGES) return false;
        this.pendingControls.push({ message, transfer });
        return true;
      }
      return this.sendEvent(message, bytes, true, transfer) !== null;
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
    return this.sendEvent(message, bytes, false, transfer) !== null;
  }

  /**
   * Host→Worker binary view transfer (Views-owned reassembly). Bytes use the
   * dedicated binary budget, not `eventBytes`: a slow Worker binary handler must
   * not starve ordinary control events or RX delivery. Only control slots are
   * shared. Resolves after async Worker binary handlers settle; rejects on
   * handler error, view close, budget/slot exhaustion, or worker stop.
   */
  postViewBinary(payload: {
    instanceId: string;
    transferId: string;
    type: string;
    bytes: Uint8Array;
    documentId: string;
  }): Promise<void> {
    if (!this.worker) return Promise.reject(new Error('plugin worker not running'));
    if (!(payload.bytes instanceof Uint8Array)) return Promise.reject(new TypeError('binary bytes required'));
    // Binary payloads use a separate byte ledger, but their acknowledgements
    // still occupy ordinary control slots. Even empty transfers must be bounded.
    this.flushControls();
    if (this.controlsInFlight.size >= MAX_PENDING_CONTROL_MESSAGES) {
      return Promise.reject(new Error('plugin view binary control capacity exceeded'));
    }
    if ((this.pendingBinaryPerInstance.get(payload.instanceId) ?? 0) >= MAX_PENDING_BINARY_TRANSFERS_PER_VIEW) {
      return Promise.reject(new Error('plugin view binary transfer capacity exceeded'));
    }
    if (this.binaryBytesInFlight + payload.bytes.byteLength > MAX_PENDING_BINARY_BYTES) {
      return Promise.reject(new Error('plugin view binary byte capacity exceeded'));
    }
    const message = {
      type: 'view.binary',
      payload: {
        instanceId: payload.instanceId,
        transferId: payload.transferId,
        type: payload.type,
        bytes: payload.bytes,
        documentId: payload.documentId,
      },
    };
    const eventId = ++this.eventSeq;
    let complete!: () => void;
    let fail!: (error: Error) => void;
    const timer = setTimeout(() => {
      const binary = this.pendingBinary.get(eventId);
      if (!binary) return;
      this.pendingBinary.delete(eventId);
      this.releaseBinaryBudget(binary.instanceId, binary.bytes);
      this.eventsInFlight.delete(eventId); this.controlsInFlight.delete(eventId); this.viewEvents.delete(eventId);
      binary.reject(new Error('plugin Worker binary ACK timed out'));
      this.flushControls();
    }, VIEW_BINARY_ACK_TIMEOUT_MS);
    const promise = new Promise<void>((resolve, reject) => {
      complete = () => { clearTimeout(timer); resolve(); };
      fail = error => { clearTimeout(timer); reject(error); };
    });
    this.pendingBinary.set(eventId, {
      instanceId: payload.instanceId,
      documentId: payload.documentId,
      bytes: payload.bytes.byteLength,
      resolve: complete,
      reject: fail,
    });
    this.reserveBinaryBudget(payload.instanceId, payload.bytes.byteLength);
    try {
      // The runtime owns the reassembled buffer; transfer avoids a full-data copy.
      const buffer = payload.bytes.buffer;
      const transfer = buffer instanceof ArrayBuffer ? [buffer] : undefined;
      if (this.sendEvent(message, 0, true, transfer, eventId) === null) {
        throw new Error('plugin worker not running');
      }
    } catch (error) {
      this.pendingBinary.delete(eventId);
      this.releaseBinaryBudget(payload.instanceId, payload.bytes.byteLength);
      fail(error instanceof Error ? error : new Error(String(error)));
    }
    return promise;
  }

  private reserveBinaryBudget(instanceId: string, bytes: number): void {
    this.binaryBytesInFlight += bytes;
    this.pendingBinaryPerInstance.set(instanceId, (this.pendingBinaryPerInstance.get(instanceId) ?? 0) + 1);
  }

  private releaseBinaryBudget(instanceId: string, bytes: number): void {
    this.binaryBytesInFlight = Math.max(0, this.binaryBytesInFlight - bytes);
    const current = this.pendingBinaryPerInstance.get(instanceId) ?? 0;
    if (current <= 1) this.pendingBinaryPerInstance.delete(instanceId);
    else this.pendingBinaryPerInstance.set(instanceId, current - 1);
  }

  /**
   * Cancel host→Worker binary transfers for one view document (navigation /
   * document replacement). Rejects their promises and releases control slots,
   * byte budget, and any queued control events that can now be delivered.
   */
  cancelViewBinary(instanceId: string, documentId: string): void {
    for (const [eventId, binary] of [...this.pendingBinary]) {
      if (binary.instanceId !== instanceId || binary.documentId !== documentId) continue;
      this.pendingBinary.delete(eventId);
      this.releaseBinaryBudget(binary.instanceId, binary.bytes);
      this.eventsInFlight.delete(eventId);
      this.controlsInFlight.delete(eventId);
      this.viewEvents.delete(eventId);
      binary.reject(new Error('view document changed'));
    }
    // Freeing control slots must not strand or reorder the overflow queue.
    this.flushControls();
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
    transfer?: Transferable[], eventId = ++this.eventSeq): number | null {
    const worker = this.worker;
    if (!worker) return null;
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
      return eventId;
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
    await this.startSession(pluginId, false);
  }

  /**
   * `strict` (explicit reload) waits for Worker readiness and rejects on
   * load/parse/startup failure instead of resolving into a scheduled retry.
   */
  private async startSession(pluginId: string, strict: boolean): Promise<void> {
    const pending = this.starts.get(pluginId);
    if (pending) return pending;
    let session = this.sessions.get(pluginId);
    if (!session) {
      session = new PluginSession(pluginId, true);
      this.sessions.set(pluginId, session);
    }
    const current = session;
    const start = strict
      ? current.startReady(this.callbacks)
      : current.start(this.callbacks).catch(async (error) => {
        if (this.sessions.get(pluginId) === current) await current.recoverStartupFailure(String(error));
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

  /**
   * Restart the current enabled configuration with a fresh Worker session.
   * Backend reload has already retired native views/HTTP; the new session gets a
   * new epoch. No-op (resolved) for disabled plugins; pure-HTML plugins start no
   * Worker. Does not write config/grants.
   */
  async reload(pluginId: string): Promise<void> {
    this.disable(pluginId);
    const entry = useAppStore.getState().config.pluginConfigs?.find((plugin) => plugin.id === pluginId);
    if (!entry?.enabled) return;
    await this.startSession(pluginId, true);
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
