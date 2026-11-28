/**
 * pluginControlBridge — Control Plane & Remote View Host Proxy for Plugins.
 *
 * Responsibilities:
 * 1. Syncs live, ready plugins' declared `tools` (gated by `control:expose`) to
 *    Rust `PluginControlBridge` (`control_sync_plugin_tools`).
 * 2. Routes `control:plugin-invoke` and `control:plugin-job-cancel` events into
 *    the owning `PluginSession` Worker, and forwards Worker replies / job events
 *    back to Rust (`control_plugin_reply` / `control_plugin_job_event`).
 * 3. Acts as the host-side proxy (`remoteProxyViews`) when a remote workbench
 *    projects an isolated view from this host (`control:remote-view-open` /
 *    `input` / `close`), translating Worker `view.publish`, `view.sendBinary`,
 *    and `view.pickClientArtifact` calls into `control_remote_view_event`.
 */
import {
  controlService,
  eventService,
  type ArtifactInfoDto,
  type PluginToolDescriptorDto,
  type ResolvedArtifactDto,
} from '../services/tauri';
import type {
  ControlPluginInvokeEvent,
  ControlPluginJobCancelEvent,
  ControlRemoteViewCloseEvent,
  ControlRemoteViewInputEvent,
  ControlRemoteViewOpenEvent,
} from '../services/event';
import { useAppStore } from '../stores/useAppStore';
import type { PluginViewBinding } from '../types/pluginViews';
import { getPluginViews, subscribePluginViews } from './pluginConfigSnapshot';
import { pluginHost, setPluginControlMessageHandler, subscribePluginSessions } from './pluginHost';
import { registerRemoteProxyViewHandler } from './pluginHostApi';
import {
  VIEW_BINARY_CHUNK_BYTES,
  ViewBinaryReceiver,
  decodeViewBinaryBase64,
  encodeViewBinaryBase64,
  viewBinaryBudget,
  viewBinaryBytes,
} from './pluginViewBinary';
import { subscribePluginViewInput } from './pluginViewInput';
import { boundedPluginViewJson } from './pluginViewJson';

const ARTIFACT_PICK_TIMEOUT_MS = 10 * 60_000;
const MAX_SNAPSHOT_BYTES = 256 * 1024;

interface PendingArtifactPick {
  resolve: (artifact: ResolvedArtifactDto | ArtifactInfoDto | null) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface RemoteProxyViewEntry {
  remoteInstanceId: string;
  documentId: string;
  pluginId: string;
  installGeneration: string;
  viewId: string;
  boundPortId: string | null;
  binaryReceiver: ViewBinaryReceiver;
  pendingArtifactPicks: Map<string, PendingArtifactPick>;
  unsubscribeInput: (() => void) | null;
  rate: { tokens: number; time: number };
}

interface ActiveControlJob {
  pluginId: string;
  installGeneration: string;
}

const remoteProxyViews = new Map<string, RemoteProxyViewEntry>();
const activeJobs = new Map<string, ActiveControlJob>();

let activeUsers = 0;
let lastToolsSignature = '';
let teardownFns: Array<() => void> = [];

export function isRemoteViewInstance(instanceId: string): boolean {
  return remoteProxyViews.has(instanceId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function buildExposedTools(): PluginToolDescriptorDto[] {
  const configs = useAppStore.getState().config.pluginConfigs ?? [];
  const views = getPluginViews();
  const out: PluginToolDescriptorDto[] = [];

  for (const entry of configs) {
    if (!entry.enabled || !entry.grantedPermissions.includes('control:expose')) continue;
    const session = pluginHost.get(entry.id);
    if (!session || !session.isReady() || session.installGeneration !== entry.installGeneration) continue;
    const manifest = session.getManifest()
      ?? views.find(item => item.id === entry.id && item.installGeneration === entry.installGeneration)?.manifest
      ?? null;
    if (!manifest?.tools?.length) continue;

    for (const tool of manifest.tools) {
      out.push({
        host: 'local',
        pluginId: entry.id,
        pluginName: manifest.name,
        installGeneration: entry.installGeneration,
        tool: tool.name,
        description: tool.description,
        access: tool.access ?? 'observe',
        mode: tool.mode ?? 'sync',
        portScoped: tool.portScoped === true,
        acceptsArtifacts: tool.acceptsArtifacts === true,
        inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
      });
    }
  }
  return out;
}

function retireStaleProxyAndJobs(): void {
  const configs = useAppStore.getState().config.pluginConfigs ?? [];

  for (const [instanceId, proxy] of [...remoteProxyViews]) {
    const entry = configs.find(item => item.id === proxy.pluginId);
    const session = pluginHost.get(proxy.pluginId);
    const valid = !!entry?.enabled
      && entry.installGeneration === proxy.installGeneration
      && entry.grantedPermissions.includes('ui:view')
      && !!session?.isReady();
    if (!valid) {
      closeRemoteProxyView(instanceId, 'plugin-retired', true);
    }
  }

  for (const [jobId, job] of [...activeJobs]) {
    const entry = configs.find(item => item.id === job.pluginId);
    const session = pluginHost.get(job.pluginId);
    const valid = !!entry?.enabled
      && entry.installGeneration === job.installGeneration
      && entry.grantedPermissions.includes('control:expose')
      && !!session?.isReady();
    if (!valid) {
      activeJobs.delete(jobId);
      void controlService.controlPluginJobEvent({
        jobId,
        kind: 'error',
        error: 'plugin retired or permission revoked',
      }).catch(() => {});
    }
  }
}

function syncToolsCatalog(): void {
  if (activeUsers === 0) return;
  retireStaleProxyAndJobs();
  const tools = buildExposedTools();
  const signature = JSON.stringify(tools);
  if (signature === lastToolsSignature) return;
  lastToolsSignature = signature;
  void controlService.controlSyncPluginTools(tools).catch((err) => {
    console.debug('[pluginControlBridge] control_sync_plugin_tools failed:', err);
  });
}

function closeRemoteProxyView(remoteInstanceId: string, reason: string, notifyRemote = false): void {
  const proxy = remoteProxyViews.get(remoteInstanceId);
  if (!proxy) return;
  remoteProxyViews.delete(remoteInstanceId);

  proxy.unsubscribeInput?.();
  proxy.unsubscribeInput = null;
  proxy.binaryReceiver.reset();

  for (const pending of proxy.pendingArtifactPicks.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error(`remote view closed (${reason})`));
  }
  proxy.pendingArtifactPicks.clear();

  const session = pluginHost.get(proxy.pluginId);
  if (session?.loaded) {
    session.post({ type: 'view.close', payload: { instanceId: remoteInstanceId, reason } });
  }
  if (notifyRemote) {
    void controlService.controlRemoteViewEvent({
      remoteInstanceId,
      kind: 'closed',
      payload: { reason },
    }).catch(() => {});
  }
}

function handleControlPluginInvoke(event: ControlPluginInvokeEvent): void {
  const configs = useAppStore.getState().config.pluginConfigs ?? [];
  const entry = configs.find(item => item.id === event.pluginId);
  const session = pluginHost.get(event.pluginId);

  let rejectReason: string | null = null;
  if (!entry || !entry.enabled) {
    rejectReason = `plugin '${event.pluginId}' is not enabled`;
  } else if (entry.installGeneration !== event.installGeneration) {
    rejectReason = `plugin '${event.pluginId}' installation generation mismatch`;
  } else if (!entry.grantedPermissions.includes('control:expose')) {
    rejectReason = `plugin '${event.pluginId}' lacks control:expose permission`;
  } else if (!session || !session.isReady()) {
    rejectReason = `plugin '${event.pluginId}' worker is not ready`;
  }

  if (rejectReason) {
    if (event.mode === 'job' && event.jobId) {
      void controlService.controlPluginJobEvent({
        jobId: event.jobId,
        kind: 'error',
        error: rejectReason,
      }).catch(() => {});
    } else {
      void controlService.controlPluginReply({
        requestId: event.requestId,
        ok: false,
        error: rejectReason,
      }).catch(() => {});
    }
    return;
  }

  if (event.mode === 'job' && event.jobId) {
    activeJobs.set(event.jobId, {
      pluginId: event.pluginId,
      installGeneration: event.installGeneration,
    });
  }

  const dispatched = session!.invokeControlTool({
    requestId: event.requestId,
    tool: event.tool,
    args: event.args,
    artifacts: event.artifacts ?? [],
    mode: event.mode,
    jobId: event.jobId ?? null,
  });

  if (!dispatched) {
    if (event.mode === 'job' && event.jobId) {
      activeJobs.delete(event.jobId);
      void controlService.controlPluginJobEvent({
        jobId: event.jobId,
        kind: 'error',
        error: `failed to dispatch job to plugin '${event.pluginId}'`,
      }).catch(() => {});
    } else {
      void controlService.controlPluginReply({
        requestId: event.requestId,
        ok: false,
        error: `failed to dispatch call to plugin '${event.pluginId}'`,
      }).catch(() => {});
    }
  }
}

function handleControlPluginJobCancel(event: ControlPluginJobCancelEvent): void {
  const job = activeJobs.get(event.jobId);
  if (!job) return;
  pluginHost.get(job.pluginId)?.cancelControlJob(event.jobId);
}

export function handleWorkerControlToolReply(_pluginId: string, payload: unknown): void {
  if (!isRecord(payload)) return;
  if (typeof payload.requestId !== 'string' || typeof payload.ok !== 'boolean') return;
  void controlService.controlPluginReply({
    requestId: payload.requestId,
    ok: payload.ok,
    result: payload.result,
    error: typeof payload.error === 'string' ? payload.error : undefined,
  }).catch((err) => {
    console.debug('[pluginControlBridge] control_plugin_reply failed:', err);
  });
}

export function handleWorkerControlJobEvent(pluginId: string, payload: unknown): void {
  if (!isRecord(payload)) return;
  if (typeof payload.jobId !== 'string' || typeof payload.kind !== 'string') return;
  const active = activeJobs.get(payload.jobId);
  if (!active || active.pluginId !== pluginId) return;

  if (payload.kind === 'done' || payload.kind === 'error' || payload.kind === 'cancelled') {
    activeJobs.delete(payload.jobId);
  }

  void controlService.controlPluginJobEvent({
    jobId: payload.jobId,
    kind: payload.kind,
    message: typeof payload.message === 'string' ? payload.message : undefined,
    stream: typeof payload.stream === 'string' ? payload.stream : undefined,
    progress: typeof payload.progress === 'number' && Number.isFinite(payload.progress) ? payload.progress : undefined,
    data: payload.data,
    result: payload.result,
    error: typeof payload.error === 'string' ? payload.error : undefined,
  }).catch((err) => {
    console.debug('[pluginControlBridge] control_plugin_job_event failed:', err);
  });
}

function handleRemoteViewOpen(event: ControlRemoteViewOpenEvent): void {
  const configs = useAppStore.getState().config.pluginConfigs ?? [];
  const entry = configs.find(item => item.id === event.pluginId);
  const session = pluginHost.get(event.pluginId);
  const manifest = session?.getManifest()
    ?? getPluginViews().find(item => item.id === event.pluginId && item.installGeneration === event.installGeneration)?.manifest
    ?? null;
  const viewDecl = manifest?.ui?.views?.find(v => v.id === event.viewId);

  const emitOpenError = (message: string): void => {
    void controlService.controlRemoteViewEvent({
      remoteInstanceId: event.remoteInstanceId,
      kind: 'error',
      payload: { error: message },
    }).catch(() => {});
  };

  if (!entry?.enabled || entry.installGeneration !== event.installGeneration) {
    emitOpenError(`plugin '${event.pluginId}' is not enabled`);
    return;
  }
  if (!entry.grantedPermissions.includes('ui:view')) {
    emitOpenError(`plugin '${event.pluginId}' lacks ui:view permission`);
    return;
  }
  if (!session || !session.isReady()) {
    emitOpenError(`plugin '${event.pluginId}' worker is not ready`);
    return;
  }
  if (!viewDecl || viewDecl.mode === 'trusted-web') {
    emitOpenError(`remote view '${event.viewId}' is not available`);
    return;
  }
  const inputPerm = viewDecl.input === 'bytes' ? 'rx:bytes' : viewDecl.input === 'lines' ? 'terminal:read' : null;
  if (inputPerm && !entry.grantedPermissions.includes(inputPerm)) {
    emitOpenError(`plugin '${event.pluginId}' lacks ${inputPerm} permission`);
    return;
  }

  if (remoteProxyViews.has(event.remoteInstanceId)) {
    closeRemoteProxyView(event.remoteInstanceId, 'reopened', false);
  }

  const boundPortId = event.boundPortId ?? null;
  const binding: PluginViewBinding = {
    pluginId: event.pluginId,
    installGeneration: event.installGeneration,
    viewId: event.viewId,
    tabId: event.remoteInstanceId,
    placement: 'workspace-tab',
    boundPortId,
    portMode: boundPortId ? (useAppStore.getState().ports.find(p => p.id === boundPortId)?.mode ?? 'trx') : null,
    tabSessionId: event.remoteInstanceId,
    viewInstanceId: event.remoteInstanceId,
    workerEpoch: session.epoch,
    streamEpoch: 0,
  };

  const proxy: RemoteProxyViewEntry = {
    remoteInstanceId: event.remoteInstanceId,
    documentId: event.documentId,
    pluginId: event.pluginId,
    installGeneration: event.installGeneration,
    viewId: event.viewId,
    boundPortId,
    binaryReceiver: new ViewBinaryReceiver({ budget: viewBinaryBudget, owner: event.pluginId }),
    pendingArtifactPicks: new Map(),
    unsubscribeInput: null,
    rate: { tokens: 60, time: Date.now() },
  };
  remoteProxyViews.set(event.remoteInstanceId, proxy);

  const opened = session.post({
    type: 'view.open',
    payload: { context: binding, params: event.params ?? null, documentId: event.documentId },
  });
  if (!opened) {
    closeRemoteProxyView(event.remoteInstanceId, 'worker-capacity', false);
    emitOpenError('plugin worker control capacity exceeded');
    return;
  }
  session.post({
    type: 'view.document',
    payload: { instanceId: event.remoteInstanceId, documentId: event.documentId },
  });

  if (boundPortId && viewDecl.input !== 'none') {
    proxy.unsubscribeInput = subscribePluginViewInput(binding, viewDecl.input, {
      onInput: (batch, streamEpoch, gapBefore) => {
        if (!remoteProxyViews.has(event.remoteInstanceId) || session.epoch !== binding.workerEpoch) return false;
        binding.streamEpoch = streamEpoch;
        return session.post({
          type: 'view.input',
          payload: { instanceId: event.remoteInstanceId, streamEpoch, gapBefore, batch },
        });
      },
      onDiscontinuity: (reason, streamEpoch) => {
        binding.streamEpoch = streamEpoch;
        session.post({
          type: 'view.discontinuity',
          payload: { instanceId: event.remoteInstanceId, reason, streamEpoch },
        });
      },
      onStatus: (status, streamEpoch) => {
        binding.streamEpoch = streamEpoch;
        session.post({
          type: 'view.status',
          payload: { instanceId: event.remoteInstanceId, status, streamEpoch },
        });
      },
    });
  }
}

function handleRemoteViewInput(event: ControlRemoteViewInputEvent): void {
  const proxy = remoteProxyViews.get(event.remoteInstanceId);
  if (!proxy) return;
  const session = pluginHost.get(proxy.pluginId);
  if (!session || !session.loaded) return;

  if (event.kind === 'artifact-picked') {
    if (!isRecord(event.payload) || typeof event.payload.requestId !== 'string') return;
    const pending = proxy.pendingArtifactPicks.get(event.payload.requestId);
    if (!pending) return;
    proxy.pendingArtifactPicks.delete(event.payload.requestId);
    clearTimeout(pending.timer);
    if (typeof event.payload.error === 'string' && event.payload.error) {
      pending.reject(new Error(event.payload.error));
    } else {
      pending.resolve((event.payload.artifact as ResolvedArtifactDto | ArtifactInfoDto | null | undefined) ?? null);
    }
    return;
  }

  if (event.kind === 'action' || event.kind === 'preview' || event.kind === 'message') {
    const p = isRecord(event.payload) ? event.payload : {};
    const msgType = typeof p.type === 'string' && p.type
      ? p.type
      : typeof p.messageType === 'string' && p.messageType
        ? p.messageType
        : 'message';
    session.postViewInteraction({
      instanceId: event.remoteInstanceId,
      documentId: proxy.documentId,
      type: msgType,
      payload: p.payload ?? null,
    });
    return;
  }

  if (event.kind === 'binary') {
    if (!isRecord(event.payload)) return;
    const { transferId, transferType, seq, done, data, dataBase64 } = event.payload;
    if (typeof transferId !== 'string' || typeof transferType !== 'string') return;

    if (typeof seq === 'number' && typeof done === 'boolean' && typeof data === 'string') {
      const received = proxy.binaryReceiver.push({
        documentId: proxy.documentId,
        transferId,
        transferType,
        seq,
        done,
        data,
      });
      if (received.kind === 'complete') {
        void session.postViewBinary({
          instanceId: event.remoteInstanceId,
          documentId: proxy.documentId,
          transferId,
          type: received.transferType,
          bytes: received.bytes,
        }).finally(() => {
          received.release();
        }).catch((err) => {
          console.debug('[pluginControlBridge] remote binary forward failed:', err);
        });
      }
      return;
    }

    if (typeof dataBase64 === 'string') {
      try {
        const bytes = decodeViewBinaryBase64(dataBase64);
        void session.postViewBinary({
          instanceId: event.remoteInstanceId,
          documentId: proxy.documentId,
          transferId,
          type: transferType,
          bytes,
        }).catch((err) => {
          console.debug('[pluginControlBridge] remote single-shot binary forward failed:', err);
        });
      } catch (err) {
        console.debug('[pluginControlBridge] invalid remote binary base64:', err);
      }
    }
  }
}

function handleRemoteViewClose(event: ControlRemoteViewCloseEvent): void {
  closeRemoteProxyView(event.remoteInstanceId, 'remote-closed', false);
}

async function executeRemoteProxyViewApi(
  pluginId: string,
  op: 'view.publish' | 'view.sendBinary' | 'view.pickClientArtifact',
  args: unknown,
  beforeSend?: () => void,
): Promise<unknown> {
  if (!isRecord(args) || typeof args.instanceId !== 'string' || !args.instanceId) {
    throw new Error('invalid instanceId');
  }
  const instanceId = args.instanceId;
  const proxy = remoteProxyViews.get(instanceId);
  if (!proxy || proxy.pluginId !== pluginId) {
    throw new Error('remote plugin view session expired');
  }
  beforeSend?.();

  if (op === 'view.publish') {
    const now = Date.now();
    proxy.rate.tokens = Math.min(60, proxy.rate.tokens + (now - proxy.rate.time) / 8);
    proxy.rate.time = now;
    if (proxy.rate.tokens < 1) throw new Error('plugin view publish rate exceeded');
    proxy.rate.tokens--;

    const normalized = boundedPluginViewJson(args.snapshot, MAX_SNAPSHOT_BYTES);
    await controlService.controlRemoteViewEvent({
      remoteInstanceId: instanceId,
      kind: 'state',
      payload: { documentId: proxy.documentId, snapshot: normalized.value },
    });
    return null;
  }

  if (op === 'view.sendBinary') {
    const type = args.type;
    if (typeof type !== 'string' || !type || type.length > 128) {
      throw new Error('invalid binary view type');
    }
    if (args.documentId != null && args.documentId !== proxy.documentId) {
      throw new Error('plugin view document changed');
    }
    if (!(args.bytes instanceof Uint8Array) && !(args.bytes instanceof ArrayBuffer)) {
      throw new Error('invalid binary view bytes');
    }
    const bytes = viewBinaryBytes(args.bytes);
    const transferId = crypto.randomUUID();
    const total = Math.max(1, Math.ceil(bytes.length / VIEW_BINARY_CHUNK_BYTES));
    for (let seq = 0; seq < total; seq++) {
      if (!remoteProxyViews.has(instanceId)) throw new Error('remote view closed');
      beforeSend?.();
      const start = seq * VIEW_BINARY_CHUNK_BYTES;
      const end = Math.min(bytes.length, start + VIEW_BINARY_CHUNK_BYTES);
      await controlService.controlRemoteViewEvent({
        remoteInstanceId: instanceId,
        kind: 'binary',
        payload: {
          documentId: proxy.documentId,
          transferId,
          transferType: type,
          seq,
          done: seq === total - 1,
          data: encodeViewBinaryBase64(bytes.subarray(start, end)),
        },
      });
    }
    return undefined;
  }

  // view.pickClientArtifact
  const rawOptions = isRecord(args.options) ? args.options : {};
  const title = typeof rawOptions.title === 'string' ? rawOptions.title.slice(0, 256) : undefined;
  const filters = Array.isArray(rawOptions.filters)
    ? rawOptions.filters
      .filter((f): f is { name: string; extensions: string[] } =>
        isRecord(f) && typeof f.name === 'string' && Array.isArray(f.extensions) && f.extensions.every(e => typeof e === 'string'))
      .slice(0, 32)
    : undefined;

  const requestId = crypto.randomUUID();
  const picked = new Promise<ResolvedArtifactDto | ArtifactInfoDto | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      proxy.pendingArtifactPicks.delete(requestId);
      reject(new Error('client artifact picker timed out'));
    }, ARTIFACT_PICK_TIMEOUT_MS);
    proxy.pendingArtifactPicks.set(requestId, { resolve, reject, timer });
  });

  try {
    await controlService.controlRemoteViewEvent({
      remoteInstanceId: instanceId,
      kind: 'pick-artifact',
      payload: { requestId, options: { ...(title !== undefined ? { title } : {}), ...(filters !== undefined ? { filters } : {}) } },
    });
  } catch (err) {
    const pending = proxy.pendingArtifactPicks.get(requestId);
    if (pending) {
      proxy.pendingArtifactPicks.delete(requestId);
      clearTimeout(pending.timer);
      pending.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  return picked;
}

function teardownBridge(): void {
  setPluginControlMessageHandler(null);
  registerRemoteProxyViewHandler(null);
  for (const unsub of teardownFns) {
    try { unsub(); } catch { /* ignore cleanup error */ }
  }
  teardownFns = [];
  for (const instanceId of [...remoteProxyViews.keys()]) {
    closeRemoteProxyView(instanceId, 'bridge-stopped', false);
  }
  activeJobs.clear();
  lastToolsSignature = '';
}

export function startPluginControlBridge(): () => void {
  activeUsers++;
  if (activeUsers === 1) {
    let disposed = false;
    setPluginControlMessageHandler((pluginId, type, payload) => {
      if (type === '__control_tool_reply') handleWorkerControlToolReply(pluginId, payload);
      else handleWorkerControlJobEvent(pluginId, payload);
    });
    registerRemoteProxyViewHandler({
      isRemoteViewInstance,
      execute: executeRemoteProxyViewApi,
    });

    const unsubViews = subscribePluginViews(syncToolsCatalog);
    const unsubSessions = subscribePluginSessions(syncToolsCatalog);
    const unsubStore = useAppStore.subscribe((state, previous) => {
      if (state.config.pluginConfigs !== previous.config.pluginConfigs) syncToolsCatalog();
    });
    teardownFns.push(unsubViews, unsubSessions, unsubStore);

    const registerListener = (promise: Promise<() => void>): void => {
      void promise.then((unlisten) => {
        if (disposed || activeUsers === 0) unlisten();
        else teardownFns.push(unlisten);
      }).catch((err) => {
        console.debug('[pluginControlBridge] event listener failed:', err);
      });
    };

    registerListener(eventService.onControlPluginInvoke(handleControlPluginInvoke));
    registerListener(eventService.onControlPluginJobCancel(handleControlPluginJobCancel));
    registerListener(eventService.onControlRemoteViewOpen(handleRemoteViewOpen));
    registerListener(eventService.onControlRemoteViewInput(handleRemoteViewInput));
    registerListener(eventService.onControlRemoteViewClose(handleRemoteViewClose));

    teardownFns.push(() => { disposed = true; });
    syncToolsCatalog();
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeUsers = Math.max(0, activeUsers - 1);
    if (activeUsers === 0) teardownBridge();
  };
}

/** Test-only reset for singleton state. */
export function resetPluginControlBridgeForTest(): void {
  activeUsers = 0;
  teardownBridge();
}
