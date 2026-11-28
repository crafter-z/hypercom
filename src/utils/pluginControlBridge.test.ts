import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStoresForTests } from '../stores/resetStores';
import { useAppStore } from '../stores/useAppStore';
import { useSystemStore } from '../stores/useSystemStore';
import { PLUGIN_BRIDGE_CODE } from './pluginBridge';
import { resetPluginSnapshotForTest, syncPluginListSnapshot, syncStorePluginConfigs } from './pluginConfigSnapshot';
import { pluginHost } from './pluginHost';
import {
  resetPluginControlBridgeForTest,
  startPluginControlBridge,
  isRemoteViewInstance,
} from './pluginControlBridge';
import { PLUGIN_HOST_INFO } from './pluginHostInfo';
import { checkOpAllowed, OP_PERMISSIONS } from './pluginRpc';
import {
  getAvailablePluginViews,
  openRemotePluginViewTab,
  startPluginViewRuntime,
} from './pluginViewRuntime';
import { buildSessionSnapshot } from './sessionSnapshot';
import type { PluginView } from '../types';
import type {
  ControlPluginInvokeEvent,
  ControlPluginJobCancelEvent,
  ControlRemoteViewCloseEvent,
  ControlRemoteViewInputEvent,
  ControlRemoteViewOpenEvent,
} from '../services/event';

const readAsset = vi.fn();
const controlSyncPluginTools = vi.fn().mockResolvedValue(undefined);
const controlPluginReply = vi.fn().mockResolvedValue(undefined);
const controlPluginJobEvent = vi.fn().mockResolvedValue(undefined);
const controlRemoteViewEvent = vi.fn().mockResolvedValue(undefined);
const remoteOpenPluginView = vi.fn();
const remotePollPluginViewEvents = vi.fn();
const remoteSendPluginViewInput = vi.fn().mockResolvedValue({ ok: true });
const remoteClosePluginView = vi.fn().mockResolvedValue(undefined);
const remotePickAndUploadArtifact = vi.fn();
const createProjected = vi.fn().mockResolvedValue(undefined);
const pluginViewSend = vi.fn().mockResolvedValue(undefined);
const pluginViewDestroy = vi.fn().mockResolvedValue(undefined);
const pluginViewUpdate = vi.fn().mockResolvedValue(undefined);
const pluginViewCreate = vi.fn().mockResolvedValue(undefined);

let invokeCb: ((ev: ControlPluginInvokeEvent) => void) | null = null;
let jobCancelCb: ((ev: ControlPluginJobCancelEvent) => void) | null = null;
let remoteViewOpenCb: ((ev: ControlRemoteViewOpenEvent) => void) | null = null;
let remoteViewInputCb: ((ev: ControlRemoteViewInputEvent) => void) | null = null;
let remoteViewCloseCb: ((ev: ControlRemoteViewCloseEvent) => void) | null = null;
let nativeViewMessageCb: ((msg: unknown) => void) | null = null;

vi.mock('../services/tauri', () => ({
  pluginService: {
    readPluginAsset: (...args: unknown[]) => readAsset(...args),
    setPluginEnabled: vi.fn(),
  },
  controlService: {
    controlSyncPluginTools: (...args: unknown[]) => controlSyncPluginTools(...args),
    controlPluginReply: (...args: unknown[]) => controlPluginReply(...args),
    controlPluginJobEvent: (...args: unknown[]) => controlPluginJobEvent(...args),
    controlRemoteViewEvent: (...args: unknown[]) => controlRemoteViewEvent(...args),
    remoteOpenPluginView: (...args: unknown[]) => remoteOpenPluginView(...args),
    remotePollPluginViewEvents: (...args: unknown[]) => remotePollPluginViewEvents(...args),
    remoteSendPluginViewInput: (...args: unknown[]) => remoteSendPluginViewInput(...args),
    remoteClosePluginView: (...args: unknown[]) => remoteClosePluginView(...args),
    remotePickAndUploadArtifact: (...args: unknown[]) => remotePickAndUploadArtifact(...args),
  },
  eventService: {
    onControlPluginInvoke: vi.fn(async (cb: (ev: ControlPluginInvokeEvent) => void) => { invokeCb = cb; return () => { invokeCb = null; }; }),
    onControlPluginJobCancel: vi.fn(async (cb: (ev: ControlPluginJobCancelEvent) => void) => { jobCancelCb = cb; return () => { jobCancelCb = null; }; }),
    onControlRemoteViewOpen: vi.fn(async (cb: (ev: ControlRemoteViewOpenEvent) => void) => { remoteViewOpenCb = cb; return () => { remoteViewOpenCb = null; }; }),
    onControlRemoteViewInput: vi.fn(async (cb: (ev: ControlRemoteViewInputEvent) => void) => { remoteViewInputCb = cb; return () => { remoteViewInputCb = null; }; }),
    onControlRemoteViewClose: vi.fn(async (cb: (ev: ControlRemoteViewCloseEvent) => void) => { remoteViewCloseCb = cb; return () => { remoteViewCloseCb = null; }; }),
  },
  fileService: {
    pickPluginFiles: vi.fn(),
  },
  serialService: {
    pluginSerialList: vi.fn().mockResolvedValue([]),
    pluginSerialStatus: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('../services/pluginView', () => ({
  pluginViewService: {
    create: (...args: unknown[]) => pluginViewCreate(...args),
    createProjected: (...args: unknown[]) => createProjected(...args),
    update: (...args: unknown[]) => pluginViewUpdate(...args),
    send: (...args: unknown[]) => pluginViewSend(...args),
    destroy: (...args: unknown[]) => pluginViewDestroy(...args),
    onMessage: vi.fn(async (cb: (msg: unknown) => void) => { nativeViewMessageCb = cb; return () => { nativeViewMessageCb = null; }; }),
  },
}));

class MockWorker {
  static instances: MockWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor(_url: string) {
    MockWorker.instances.push(this);
  }
  emit(data: unknown): void {
    this.onmessage?.({ data });
  }
}

const pluginId = 'com.example.hosttool';
const installGeneration = '11111111-1111-4111-8111-111111111111';
const manifest = {
  id: pluginId,
  name: 'Host Tool Plugin',
  version: '1.0.0',
  description: 'Test plugin',
  apiVersion: '1.0',
  entry: 'main.js',
  hostKind: 'both' as const,
  permissions: ['control:expose', 'ui:view', 'rx:bytes'],
  tools: [
    {
      name: 'ping',
      description: 'Ping device',
      access: 'observe' as const,
      mode: 'sync' as const,
      portScoped: false,
      acceptsArtifacts: false,
      inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
    },
    {
      name: 'flash',
      description: 'Flash firmware',
      access: 'control' as const,
      mode: 'job' as const,
      portScoped: true,
      acceptsArtifacts: true,
      inputSchema: { type: 'object', properties: { portId: { type: 'string' } } },
    },
  ],
  ui: {
    buttons: [],
    menuItems: [],
    views: [
      {
        id: 'dashboard',
        label: 'Dashboard',
        entry: 'ui.js',
        mode: 'isolated' as const,
        styles: [],
        assets: [],
        modes: ['trx' as const],
        input: 'bytes' as const,
        placements: ['serial-content' as const, 'workspace-tab' as const],
        portBinding: 'optional' as const,
        restoreOnStartup: false,
      },
    ],
  },
};

beforeEach(() => {
  MockWorker.instances = [];
  resetStoresForTests();
  resetPluginSnapshotForTest();
  resetPluginControlBridgeForTest();
  pluginHost.dispose();

  vi.clearAllMocks();
  invokeCb = null;
  jobCancelCb = null;
  remoteViewOpenCb = null;
  remoteViewInputCb = null;
  remoteViewCloseCb = null;
  nativeViewMessageCb = null;

  vi.stubGlobal('Worker', MockWorker);
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => 'blob:plugin'),
    revokeObjectURL: vi.fn(),
  });
  readAsset.mockImplementation((_id: string, path: string) => {
    if (path === 'manifest.json') return Promise.resolve(JSON.stringify(manifest));
    if (path === 'main.js') return Promise.resolve('// plugin code');
    return Promise.resolve(null);
  });
});

afterEach(() => {
  resetPluginControlBridgeForTest();
  pluginHost.dispose();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Track 4: Host Info, RPC & Manifest Normalization', () => {
  it('advertises pluginTools, remotePorts, and artifacts in PLUGIN_HOST_INFO and RPC permissions', () => {
    expect(PLUGIN_HOST_INFO.features.pluginTools).toBe(true);
    expect(PLUGIN_HOST_INFO.features.remotePorts).toBe(true);
    expect(PLUGIN_HOST_INFO.features.artifacts).toBe(true);
    expect(OP_PERMISSIONS['view.pickClientArtifact']).toBe('ui:view');
    expect(OP_PERMISSIONS['control.jobEvent']).toBeNull();
    expect(checkOpAllowed('view.pickClientArtifact', [])).toContain('ui:view');
    expect(checkOpAllowed('view.pickClientArtifact', ['ui:view'])).toBeNull();
    expect(checkOpAllowed('control.jobEvent', [])).toBeNull();
  });

  it('normalizes manifest.hostKind and manifest.tools and rejects malformed declarations', async () => {
    useAppStore.getState().setConfig({
      revision: 1,
      pluginConfigs: [{ id: pluginId, installGeneration, enabled: true, grantedPermissions: ['control:expose'] }],
    });

    await pluginHost.enable(pluginId);
    const session = pluginHost.get(pluginId)!;
    expect(session.getManifest()?.hostKind).toBe('both');
    expect(session.getManifest()?.tools).toHaveLength(2);
    expect(session.getManifest()?.tools?.[1]).toMatchObject({
      name: 'flash',
      access: 'control',
      mode: 'job',
      portScoped: true,
      acceptsArtifacts: true,
    });
    expect(session.isReady()).toBe(false);
    MockWorker.instances[0].emit({ type: '__plugin_ready' });
    expect(session.isReady()).toBe(true);

    // Reject invalid hostKind
    pluginHost.dispose();
    readAsset.mockResolvedValueOnce(JSON.stringify({ ...manifest, hostKind: 'desktop' }));
    await pluginHost.enable(pluginId);
    expect(pluginHost.get(pluginId)?.loaded).toBe(false);

    // Reject duplicate tool names
    pluginHost.dispose();
    readAsset.mockResolvedValueOnce(JSON.stringify({
      ...manifest,
      tools: [manifest.tools[0], manifest.tools[0]],
    }));
    await pluginHost.enable(pluginId);
    expect(pluginHost.get(pluginId)?.loaded).toBe(false);
  });
});

describe('Track 4: Worker SDK self.plugin.tools & view.pickClientArtifact', () => {
  function bootBridgeWorker() {
    const posted: Array<{ type?: string; seq?: number; op?: string; args?: unknown; payload?: unknown }> = [];
    const worker = {
      postMessage: (msg: { type?: string; seq?: number; op?: string; args?: unknown; payload?: unknown }) => posted.push(msg),
      addEventListener: () => {},
      onmessage: undefined as ((ev: { data: unknown }) => void) | undefined,
      plugin: undefined as unknown as {
        tools: {
          register: (name: string, handler: (args: unknown, ctx: {
            mode: string;
            jobId?: string;
            signal?: AbortSignal;
            artifacts: unknown[];
            emitProgress?: (progress: number, message?: string, data?: unknown) => void;
            emitLog?: (message: string, stream?: string) => void;
          }) => unknown) => () => void;
        };
        views: {
          onOpen: (cb: (view: { pickClientArtifact: (opts?: unknown) => Promise<unknown> }) => void) => () => void;
        };
      },
    };
    new Function('self', PLUGIN_BRIDGE_CODE)(worker);
    return { worker, posted };
  }

  it('handles sync tool invoke, unregistered tool error, and unregister cleanup', async () => {
    const { worker, posted } = bootBridgeWorker();

    const unregister = worker.plugin.tools.register('echo', (args, ctx) => ({
      echoed: args,
      mode: ctx.mode,
      artifacts: ctx.artifacts,
    }));

    worker.onmessage!({
      data: {
        type: '__control_tool_invoke',
        payload: { requestId: 'req-1', tool: 'echo', args: { x: 42 }, artifacts: [{ artifactId: 'a1' }], mode: 'sync', jobId: null },
      },
    });

    await vi.waitFor(() => {
      expect(posted).toContainEqual({
        type: '__control_tool_reply',
        payload: {
          requestId: 'req-1',
          mode: 'sync',
          ok: true,
          result: { echoed: { x: 42 }, mode: 'sync', artifacts: [{ artifactId: 'a1' }] },
        },
      });
    });

    unregister();
    worker.onmessage!({
      data: {
        type: '__control_tool_invoke',
        payload: { requestId: 'req-2', tool: 'echo', args: {}, artifacts: [], mode: 'sync', jobId: null },
      },
    });
    expect(posted).toContainEqual({
      type: '__control_tool_reply',
      payload: {
        requestId: 'req-2',
        jobId: null,
        mode: 'sync',
        ok: false,
        error: 'tool handler not registered: echo',
      },
    });
  });

  it('handles async job emitProgress/emitLog/done and cancellation via signal', async () => {
    const { worker, posted } = bootBridgeWorker();

    let releaseJob!: (val: unknown) => void;
    worker.plugin.tools.register('flash', (_args, ctx) => {
      ctx.emitLog?.('starting', 'stdout');
      ctx.emitProgress?.(0.5, 'halfway', { step: 1 });
      return new Promise((resolve, reject) => {
        if (ctx.signal?.aborted) { reject(new Error('aborted')); return; }
        releaseJob = resolve;
        ctx.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });

    worker.onmessage!({
      data: {
        type: '__control_tool_invoke',
        payload: { requestId: 'req-job-1', tool: 'flash', args: {}, artifacts: [], mode: 'job', jobId: 'job-1' },
      },
    });

    await vi.waitFor(() => {
      expect(posted).toContainEqual({
        type: '__control_job_event',
        payload: { jobId: 'job-1', kind: 'log', message: 'starting', stream: 'stdout' },
      });
      expect(posted).toContainEqual({
        type: '__control_job_event',
        payload: { jobId: 'job-1', kind: 'progress', progress: 0.5, message: 'halfway', data: { step: 1 } },
      });
    });

    releaseJob({ flashed: true });
    await vi.waitFor(() => {
      expect(posted).toContainEqual({
        type: '__control_job_event',
        payload: { jobId: 'job-1', kind: 'done', result: { flashed: true } },
      });
    });

    // Cancellation flow (mid-flight abort)
    worker.onmessage!({
      data: {
        type: '__control_tool_invoke',
        payload: { requestId: 'req-job-2', tool: 'flash', args: {}, artifacts: [], mode: 'job', jobId: 'job-2' },
      },
    });
    await vi.waitFor(() => {
      expect(posted).toContainEqual({
        type: '__control_job_event',
        payload: { jobId: 'job-2', kind: 'log', message: 'starting', stream: 'stdout' },
      });
    });
    worker.onmessage!({ data: { type: '__control_job_cancel', payload: { jobId: 'job-2' } } });

    await vi.waitFor(() => {
      expect(posted).toContainEqual({
        type: '__control_job_event',
        payload: { jobId: 'job-2', kind: 'cancelled', message: 'cancelled' },
      });
    });
  });

  it('forwards view.pickClientArtifact RPC from view session to host', async () => {
    const { worker, posted } = bootBridgeWorker();
    let openedView!: { pickClientArtifact: (opts?: unknown) => Promise<unknown> };
    worker.plugin.views.onOpen((view) => { openedView = view; });

    worker.onmessage!({
      data: {
        type: 'view.open',
        payload: {
          context: { viewInstanceId: 'inst-1', streamEpoch: 0 },
          params: null,
          documentId: 'doc-1',
        },
      },
    });

    await vi.waitFor(() => expect(openedView).toBeDefined());
    const pending = openedView.pickClientArtifact({ title: 'Pick FW' });
    const rpc = posted.find(item => item.op === 'view.pickClientArtifact')!;
    expect(rpc.args).toEqual({ instanceId: 'inst-1', options: { title: 'Pick FW' } });
    worker.onmessage!({ data: { seq: rpc.seq, ok: true, result: { artifactId: 'art-1', name: 'fw.bin' } } });
    await expect(pending).resolves.toEqual({ artifactId: 'art-1', name: 'fw.bin' });
  });
});

describe('Track 4: pluginControlBridge', () => {
  it('syncs tools only when ready & control:expose granted, clears on revocation, and routes invoke/reply & remote view proxy', async () => {
    const pluginView: PluginView = {
      id: pluginId,
      dir: '',
      enabled: true,
      grantedPermissions: ['control:expose', 'ui:view', 'rx:bytes'],
      declaredPermissions: ['control:expose', 'ui:view', 'rx:bytes'],
      knownPermissions: ['control:expose', 'ui:view', 'rx:bytes'],
      manifest,
      manifestError: null,
      installedAt: null,
      installGeneration,
    };

    const stopBridge = startPluginControlBridge();
    await vi.waitFor(() => expect(invokeCb).not.toBeNull());

    syncPluginListSnapshot({
      revision: 1,
      plugins: [pluginView],
      pluginConfigs: [{ id: pluginId, installGeneration, enabled: true, grantedPermissions: ['control:expose', 'ui:view', 'rx:bytes'] }],
    });

    await pluginHost.enable(pluginId);
    const worker = MockWorker.instances[0];

    // Before ready: empty tool list
    expect(controlSyncPluginTools).toHaveBeenLastCalledWith([]);

    // Become ready -> tools synced
    worker.emit({ type: '__plugin_ready' });
    expect(controlSyncPluginTools).toHaveBeenLastCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ pluginId, tool: 'ping', mode: 'sync', access: 'observe' }),
        expect.objectContaining({ pluginId, tool: 'flash', mode: 'job', access: 'control', acceptsArtifacts: true }),
      ]),
    );

    // Dispatch sync tool invoke -> forwarded to Worker -> reply forwarded to Rust
    invokeCb!({
      requestId: 'sync-req-1',
      pluginId,
      installGeneration,
      tool: 'ping',
      args: { hello: 'world' },
      artifacts: [],
      mode: 'sync',
      jobId: null,
    });
    expect(worker.postMessage).toHaveBeenCalledWith({
      type: '__control_tool_invoke',
      payload: {
        requestId: 'sync-req-1',
        tool: 'ping',
        args: { hello: 'world' },
        artifacts: [],
        mode: 'sync',
        jobId: null,
      },
    });
    worker.emit({
      type: '__control_tool_reply',
      payload: { requestId: 'sync-req-1', ok: true, result: { pong: true } },
    });
    expect(controlPluginReply).toHaveBeenCalledWith({
      requestId: 'sync-req-1',
      ok: true,
      result: { pong: true },
      error: undefined,
    });

    // Dispatch job invoke & cancel
    invokeCb!({
      requestId: 'job-req-1',
      pluginId,
      installGeneration,
      tool: 'flash',
      args: { portId: 'COM3' },
      artifacts: [],
      mode: 'job',
      jobId: 'job-99',
    });
    worker.emit({
      type: '__control_job_event',
      payload: { jobId: 'job-99', kind: 'progress', progress: 0.25, message: 'erasing' },
    });
    expect(controlPluginJobEvent).toHaveBeenCalledWith(expect.objectContaining({
      jobId: 'job-99',
      kind: 'progress',
      progress: 0.25,
      message: 'erasing',
    }));
    jobCancelCb!({ jobId: 'job-99' });
    expect(worker.postMessage).toHaveBeenCalledWith({
      type: '__control_job_cancel',
      payload: { jobId: 'job-99' },
    });

    // Host-side remote view proxy open -> worker publish -> input -> pickClientArtifact -> close
    remoteViewOpenCb!({
      remoteInstanceId: 'r-inst-1',
      documentId: 'r-doc-1',
      pluginId,
      installGeneration,
      viewId: 'dashboard',
      boundPortId: null,
      params: { tab: 'main' },
    });
    expect(isRemoteViewInstance('r-inst-1')).toBe(true);
    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'view.open' }),
      [],
    );
    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'view.document', payload: { instanceId: 'r-inst-1', documentId: 'r-doc-1' } }),
      [],
    );

    // Worker calls view.publish on remote instance -> controlRemoteViewEvent
    worker.emit({ seq: 101, op: 'view.publish', args: { instanceId: 'r-inst-1', snapshot: { count: 7 } } });
    await vi.waitFor(() => {
      expect(controlRemoteViewEvent).toHaveBeenCalledWith({
        remoteInstanceId: 'r-inst-1',
        kind: 'state',
        payload: { documentId: 'r-doc-1', snapshot: { count: 7 } },
      });
    });

    // Remote input action -> forwarded as view.message
    remoteViewInputCb!({
      remoteInstanceId: 'r-inst-1',
      kind: 'action',
      payload: { type: 'reset', payload: { force: true } },
    });
    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'view.message',
        payload: { instanceId: 'r-inst-1', documentId: 'r-doc-1', type: 'reset', payload: { force: true } },
      }),
      [],
    );

    // Worker calls view.pickClientArtifact -> emits pick-artifact -> resolved via artifact-picked
    worker.emit({ seq: 102, op: 'view.pickClientArtifact', args: { instanceId: 'r-inst-1', options: { title: 'Upload Hex' } } });
    await vi.waitFor(() => {
      expect(controlRemoteViewEvent).toHaveBeenCalledWith(expect.objectContaining({
        remoteInstanceId: 'r-inst-1',
        kind: 'pick-artifact',
      }));
    });
    const pickCall = controlRemoteViewEvent.mock.calls.find(call => call[0].kind === 'pick-artifact')![0] as {
      payload: { requestId: string };
    };
    remoteViewInputCb!({
      remoteInstanceId: 'r-inst-1',
      kind: 'artifact-picked',
      payload: {
        requestId: pickCall.payload.requestId,
        artifact: { artifactId: 'art-42', name: 'app.hex', sizeBytes: 128, sha256: 'abc', expiresAtMs: 99999 },
      },
    });
    await vi.waitFor(() => {
      expect(worker.postMessage).toHaveBeenCalledWith({
        seq: 102,
        ok: true,
        result: { artifactId: 'art-42', name: 'app.hex', sizeBytes: 128, sha256: 'abc', expiresAtMs: 99999 },
      });
    });

    // Close remote view
    remoteViewCloseCb!({ remoteInstanceId: 'r-inst-1' });
    expect(isRemoteViewInstance('r-inst-1')).toBe(false);

    // Revoking control:expose removes tools and rejects subsequent invokes
    syncStorePluginConfigs({
      revision: 2,
      pluginConfigs: [{ id: pluginId, installGeneration, enabled: true, grantedPermissions: ['ui:view', 'rx:bytes'] }],
    });
    expect(controlSyncPluginTools).toHaveBeenLastCalledWith([]);
    invokeCb!({
      requestId: 'sync-req-denied',
      pluginId,
      installGeneration,
      tool: 'ping',
      args: {},
      artifacts: [],
      mode: 'sync',
      jobId: null,
    });
    expect(controlPluginReply).toHaveBeenCalledWith({
      requestId: 'sync-req-denied',
      ok: false,
      error: expect.stringContaining('control:expose'),
    });

    stopBridge();
  });
});

describe('Track 4: Remote Ports & Client-Side Projected Plugin Views', () => {
  it('accepts remote:: ports in getAvailablePluginViews and projects remote tabs without persisting them', async () => {
    const stopRuntime = startPluginViewRuntime();
    try {
      useSystemStore.getState().setUIState({ configReady: true });
      useAppStore.getState().setPorts([
        {
          id: 'remote::lab-a::COM5',
          name: 'COM5',
          status: 'connected',
          type: 'remote',
          isHidden: false,
          mode: 'trx',
          hostId: 'lab-a',
          hostLabel: 'Lab A',
          remotePortId: 'COM5',
          remoteRole: 'control',
        },
      ]);

      const pluginView: PluginView = {
        id: pluginId,
        dir: '',
        enabled: true,
        grantedPermissions: ['ui:view', 'rx:bytes'],
        declaredPermissions: ['ui:view', 'rx:bytes'],
        knownPermissions: ['ui:view', 'rx:bytes'],
        manifest,
        manifestError: null,
        installedAt: null,
        installGeneration,
      };
      syncPluginListSnapshot({
        revision: 1,
        plugins: [pluginView],
        pluginConfigs: [{ id: pluginId, installGeneration, enabled: true, grantedPermissions: ['ui:view', 'rx:bytes'] }],
      });

      const available = getAvailablePluginViews('remote::lab-a::COM5', 'serial-content');
      expect(available).toHaveLength(1);
      expect(available[0].preference.viewId).toBe('dashboard');

      // Open a projected remote plugin tab (plugin NOT installed locally)
      remoteOpenPluginView.mockResolvedValue({
        remoteInstanceId: '22222222-2222-4222-8222-222222222222',
        documentId: '33333333-3333-4333-8333-333333333333',
        pluginId: 'com.remote.only',
        pluginName: 'Remote Scope',
        installGeneration: '44444444-4444-4444-8444-444444444444',
        viewId: 'scope',
        label: 'Scope View',
        entry: 'ui.js',
        styles: [],
        assets: [{ relPath: 'ui.js', mime: 'application/javascript', dataBase64: 'Y29uc29sZS5sb2coMSk=' }],
      });
      let pollCount = 0;
      remotePollPluginViewEvents.mockImplementation(async () => {
        pollCount++;
        if (pollCount === 1) {
          return {
            remoteInstanceId: '22222222-2222-4222-8222-222222222222',
            latestSeq: 1,
            nextSeq: 1,
            closed: false,
            events: [{ seq: 1, kind: 'state', payload: { snapshot: { voltage: 3.3 } } }],
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          remoteInstanceId: '22222222-2222-4222-8222-222222222222',
          latestSeq: 1,
          nextSeq: 1,
          closed: false,
          events: [],
        };
      });

      const tabId = openRemotePluginViewTab({
        profileId: 'lab-a',
        hostLabel: 'Lab A',
        pluginId: 'com.remote.only',
        pluginName: 'Remote Scope',
        installGeneration: '44444444-4444-4444-8444-444444444444',
        viewId: 'scope',
        label: 'Scope View',
        boundPortId: 'remote::lab-a::COM5',
      });

      // Remote projected tabs must never be persisted to startup session snapshots
      const snapshotJson = buildSessionSnapshot(useAppStore.getState());
      expect(snapshotJson).not.toBeNull();
      const parsed = JSON.parse(snapshotJson!) as { tabs: Array<{ id: string }> };
      expect(parsed.tabs.some(t => t.id === tabId)).toBe(false);

      await vi.waitFor(() => {
        expect(remoteOpenPluginView).toHaveBeenCalledWith({
          profileId: 'lab-a',
          pluginId: 'com.remote.only',
          viewId: 'scope',
          boundPortId: 'remote::lab-a::COM5',
          params: null,
        });
        expect(createProjected).toHaveBeenCalledTimes(1);
      });

      // Simulate native WebView2 ready & user action forwarding to remote host
      const projectedBinding = createProjected.mock.calls[0][0] as { viewInstanceId: string };
      nativeViewMessageCb?.({ instanceId: projectedBinding.viewInstanceId, type: 'ready', documentId: 'local-doc-1' });
      await vi.waitFor(() => {
        expect(pluginViewSend).toHaveBeenCalledWith(projectedBinding.viewInstanceId, expect.objectContaining({ type: 'init', documentId: 'local-doc-1' }));
      });
      nativeViewMessageCb?.({
        instanceId: projectedBinding.viewInstanceId,
        type: 'message',
        documentId: 'local-doc-1',
        requestId: '55555555-5555-4555-8555-555555555555',
        interaction: 'action',
        messageType: 'ping',
        payload: { seq: 1 },
      });
      await vi.waitFor(() => {
        expect(remoteSendPluginViewInput).toHaveBeenCalledWith({
          profileId: 'lab-a',
          remoteInstanceId: '22222222-2222-4222-8222-222222222222',
          kind: 'action',
          payload: { type: 'ping', payload: { seq: 1 } },
        });
      });
    } finally {
      stopRuntime();
    }
  });
});
