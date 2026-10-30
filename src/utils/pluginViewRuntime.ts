import { useAppStore, getTabPortId } from '../stores/useAppStore';
import { useSystemStore } from '../stores/useSystemStore';
import type { PluginManifestView, PluginView, TabItem } from '../types';
import type { PluginViewBinding, PluginViewDeclaration, PluginViewEnvironment, PluginViewPreference, PluginViewRect, PluginViewportRect, PluginViewState, PluginTabOpenOptions, PluginNativeMessage, PluginViewHostMessage } from '../types/pluginViews';
import { getPluginViews, subscribePluginViews } from './pluginConfigSnapshot';
import { pluginHost, subscribePluginSessions, type PluginSession } from './pluginHost';
import { PluginTimeline } from './pluginTimeline';
import { ViewBinaryReceiver, ViewBinarySender, viewBinaryBudget, type ViewBinaryAbort } from './pluginViewBinary';
import { pluginViewService } from '../services/pluginView';
import { subscribePluginViewInput } from './pluginViewInput';
import { collectLeaves, findLeafById } from './paneTree';
import { sendToPort } from '../hooks/useSerialSend';
import { checkPortScope } from './pluginRpc';
import { boundedPluginViewJson } from './pluginViewJson';
import { releaseUnusedPortState } from '../stores/releaseTerminalState';
import { collectPortMeta, saveCurrentPortMeta } from '../hooks/useConfigPersistence';

const MAX_PER_PLUGIN = 8;
const MAX_ALL = 16;
const MAX_SNAPSHOT_BYTES = 256 * 1024;
const MAX_PLUGIN_PENDING_BYTES = 1024 * 1024;
const MAX_OCCLUSIONS = 64;
const MAX_OCCLUSION_SIZE = 1_000_000;
/** Trusted documents only start this watchdog after a successful navigation:
 *  slow loading itself is never failed by a fixed deadline. */
export const TRUSTED_READY_TIMEOUT_MS = 30_000;
const INTERACTION_DROP_WARN_MS = 5_000;
const EMPTY_STATE: PluginViewState = { status: 'unavailable', error: null, instanceId: null };
const listeners = new Set<() => void>();
let states: Record<string, PluginViewState> = {};
let started = false;
let runtimeGeneration = 0;
let reconcileQueued = false;
let overlayBlocked = false;
let currentOcclusions: PluginViewportRect[] = [];
let nativeUnlisten: (() => void) | null = null;
const records = new Map<string, ViewRecord>();
const failures = new Map<string, string>();
const tabSessions = new Map<string, string>();
const openParams = new Map<string, unknown>();
const dismissed = new Map<string, Set<string>>();
const rates = new Map<string, { tokens: number; time: number }>();
const viewRates = new Map<string, { tokens: number; time: number }>();
const actionTokens = new Map<string, { pluginId: string; generation: string; portId: string | null; paneId: string; expires: number }>();

type ViewBinarySession = PluginSession & {
  postViewBinary?: (payload: {
    instanceId: string; documentId: string; transferId: string; type: string; bytes: Uint8Array;
  }) => Promise<void>;
  cancelViewBinary?: (instanceId: string, documentId: string) => void;
};

interface ViewRecord {
  binding: PluginViewBinding;
  declaration: PluginViewDeclaration;
  /** Independent trusted pages never construct, subscribe, or wait for a Worker. */
  usesWorker: boolean;
  documentId: string | null;
  binarySender: ViewBinarySender | null;
  binaryReceiver: ViewBinaryReceiver | null;
  timeline: PluginTimeline | null;
  alive: boolean;
  nativeCreated: boolean;
  nativeReady: boolean;
  nativeInitializing: boolean;
  workerReady: boolean;
  retirement: Promise<void> | null;
  visible: boolean;
  rect: PluginViewRect | null;
  layoutRevision: number;
  revision: number;
  inFlight: { revision: number; bytes: number } | null;
  latest: { snapshot: unknown; bytes: number } | null;
  retained: { snapshot: unknown; bytes: number } | null;
  readyTimer: ReturnType<typeof setTimeout> | null;
  navigationReadyTimer: ReturnType<typeof setTimeout> | null;
  ackTimer: ReturnType<typeof setTimeout> | null;
  flushTimer: ReturnType<typeof setTimeout> | null;
  workerReadyTimer: number | null;
  lastSentAt: number;
  unsubscribeInput: (() => void) | null;
  interactionTokens: number;
  interactionTime: number;
  lastInteractionDropWarn: number;
  lastEnvironment: string;
}

function emit(): void { for (const listener of listeners) listener(); }
function setState(tabId: string, state: PluginViewState): void {
  const previous = states[tabId];
  if (previous?.status === state.status && previous.error === state.error && previous.instanceId === state.instanceId) return;
  states = { ...states, [tabId]: state }; emit();
}
export function subscribePluginViewState(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener); }
export function getPluginViewState(tabId: string): PluginViewState { return states[tabId] ?? EMPTY_STATE; }

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function normalizeOcclusions(occlusions: PluginViewportRect[]): PluginViewportRect[] {
  if (!Array.isArray(occlusions) || occlusions.length > MAX_OCCLUSIONS) throw new Error('invalid plugin view occlusions');
  return occlusions.map((rect) => {
    if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.y) || !Number.isFinite(rect.width) || !Number.isFinite(rect.height)
      || rect.width < 0 || rect.height < 0 || rect.width > MAX_OCCLUSION_SIZE || rect.height > MAX_OCCLUSION_SIZE) {
      throw new Error('invalid plugin view occlusion rectangle');
    }
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
}
function jsonBytes(value: unknown, maximum: number): number {
  return boundedPluginViewJson(value, maximum).bytes;
}
function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
  return value as Record<string, unknown>;
}
function requireString(object: Record<string, unknown>, key: string, max = 128): string {
  const value = object[key];
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`invalid ${key}`);
  return value;
}
function preferenceFor(tab: TabItem): PluginViewPreference | null {
  if (tab.kind === 'plugin') return { pluginId: tab.pluginId, installGeneration: tab.installGeneration, viewId: tab.viewId };
  const state = useAppStore.getState();
  if (tab.kind !== 'serial') return null;
  const port = state.ports.find(item => item.id === tab.portId);
  return port ? port.displayView ?? null : state.config.portMeta.find(item => item.portId === tab.portId)?.displayView ?? null;
}
export function getTabViewPreference(tab: TabItem): PluginViewPreference | null { return preferenceFor(tab); }
export function isRawSerialDisplay(tab: TabItem | undefined): boolean {
  return tab?.kind === 'serial' && (!preferenceFor(tab) || getPluginViewState(tab.id).status === 'unavailable');
}
function eligible(preference: PluginViewPreference, portId: string | null, placement: PluginViewBinding['placement']): { plugin: PluginView; view: PluginViewDeclaration } {
  const config = useAppStore.getState().config.pluginConfigs.find(entry => entry.id === preference.pluginId);
  const plugin = getPluginViews().find(item => item.id === preference.pluginId && item.installGeneration === preference.installGeneration);
  if (!config?.enabled || config.installGeneration !== preference.installGeneration || !plugin?.manifest) throw new Error('plugin unavailable or installation changed');
  if (!config.grantedPermissions.includes('ui:view')) throw new Error('plugin requires ui:view');
  const view = plugin.manifest.ui?.views?.find(item => item.id === preference.viewId);
  if (!view || !view.placements.includes(placement)) throw new Error('plugin view placement unavailable');
  if (view.mode === 'trusted-web' && config.trustedWebGranted !== true) throw new Error('trusted webpage requires explicit approval');
  if (view.portBinding === 'required' && !portId) throw new Error('plugin view requires a port');
  if (view.portBinding === 'none' && portId) throw new Error('plugin view does not accept a port');
  if (view.input !== 'none' && !portId) throw new Error('plugin input requires a port');
  if (portId) {
    const port = useAppStore.getState().ports.find(item => item.id === portId);
    if (!port) throw new Error('bound port unavailable');
    if (!view.modes.includes(port.mode ?? 'trx')) throw new Error('port mode unsupported by plugin view');
  }
  const inputPermission = view.input === 'bytes' ? 'rx:bytes' : view.input === 'lines' ? 'terminal:read' : null;
  if (inputPermission && !config.grantedPermissions.includes(inputPermission)) throw new Error(`plugin requires ${inputPermission}`);
  return { plugin, view };
}
export function getAvailablePluginViews(portId: string | null, placement: PluginViewBinding['placement']): Array<{ preference: PluginViewPreference; declaration: PluginViewDeclaration; pluginName: string }> {
  const result: Array<{ preference: PluginViewPreference; declaration: PluginViewDeclaration; pluginName: string }> = [];
  for (const plugin of getPluginViews()) for (const view of plugin.manifest?.ui?.views ?? []) {
    const preference = { pluginId: plugin.id, installGeneration: plugin.installGeneration, viewId: view.id };
    try { eligible(preference, portId, placement); result.push({ preference, declaration: view, pluginName: plugin.manifest!.name }); } catch { /* unavailable choices must not execute */ }
  }
  return result;
}
function identity(tab: TabItem, preference: PluginViewPreference): string {
  return JSON.stringify([tab.id, preference.pluginId, preference.installGeneration, preference.viewId, getTabPortId(tab)]);
}
function live(record: ViewRecord): boolean { return record.alive && records.get(record.binding.tabId) === record; }
function environment(record: ViewRecord): PluginViewEnvironment {
  const state = useAppStore.getState();
  return {
    theme: state.config.theme === 'light' ? 'light' : 'dark', language: state.config.language,
    fontFamily: state.config.uiFont, fontSize: state.config.uiFontSize, zoomPercent: state.config.uiScalePercent,
    visible: record.visible && !overlayBlocked, focused: state.activeTabId === record.binding.tabId,
    portStatus: record.binding.boundPortId ? state.ports.find(port => port.id === record.binding.boundPortId)?.status ?? 'disconnected' : null,
  };
}
function clearTimer(record: ViewRecord, key: 'readyTimer' | 'navigationReadyTimer' | 'ackTimer' | 'flushTimer' | 'workerReadyTimer'): void {
  clearTimeout(record[key] ?? undefined);
  record[key] = null;
}
/** A top-level navigation starts a fresh native document: retired transfers are
 *  rejected, the current retained model is kept, and init is replayed on ready. */
function beginDocument(record: ViewRecord, documentId: string): boolean {
  if (record.documentId === documentId) return false;
  // A transfer queued by the Worker before the first document existed must
  // survive this initial assignment; only an actual replacement cancels it.
  const previousDocument = record.documentId;
  const replacingDocument = previousDocument !== null;
  if (replacingDocument && record.usesWorker) {
    // A worker handler awaiting a multi-MiB UI transfer would otherwise retain
    // it forever; document authority releases the delivery and its bytes.
    (pluginHost.get(record.binding.pluginId) as ViewBinarySession | null)
      ?.cancelViewBinary?.(record.binding.viewInstanceId, previousDocument);
  }
  record.timeline?.dispose(); record.timeline = null;
  record.documentId = documentId;
  clearTimer(record, 'ackTimer');
  clearTimer(record, 'flushTimer');
  clearTimer(record, 'navigationReadyTimer');
  record.inFlight = null;
  record.latest = null;
  record.nativeReady = false;
  record.nativeInitializing = false;
  record.lastEnvironment = '';
  if (replacingDocument) {
    record.binarySender?.cancel('plugin view document changed');
    record.binarySender = null;
    record.binaryReceiver?.reset();
    record.binaryReceiver = null;
  }
  setState(record.binding.tabId, { status: 'loading', error: null, instanceId: record.binding.viewInstanceId });
  if (record.usesWorker) {
    const session = pluginHost.get(record.binding.pluginId);
    session?.post({ type: 'view.document', payload: { instanceId: record.binding.viewInstanceId, documentId } });
  }
  return true;
}
function binarySenderFor(record: ViewRecord): ViewBinarySender {
  if (!record.usesWorker) throw new Error('plugin view has no Worker binary peer');
  if (!record.binarySender) {
    record.binarySender = new ViewBinarySender({
      documentId: () => (live(record) ? record.documentId : null),
      ready: () => live(record) && record.nativeReady && record.documentId !== null,
      send: message => pluginViewService.send(record.binding.viewInstanceId, message),
    }, { budget: viewBinaryBudget, owner: record.binding.pluginId });
  }
  return record.binarySender;
}

function acknowledgeUiBinary(record: ViewRecord, message: PluginNativeMessage, ok: boolean, error?: string): void {
  if (!record.documentId || message.documentId !== record.documentId) return;
  const ack: PluginViewHostMessage = {
    type: 'binary-ack', documentId: record.documentId,
    transferId: message.transferId, seq: message.seq, done: message.done === true, ok,
  };
  if (error) ack.error = error.slice(0, 2048);
  void pluginViewService.send(record.binding.viewInstanceId, ack).catch(cause => console.debug('[pluginView] binary ack', cause));
}
/** Receiver-side abort (idle/LRU): the page must learn its abandoned transfer
 *  did not complete, otherwise its sendBinary promise would wait an ACK forever. */
function acknowledgeBinaryAbort(record: ViewRecord, abort: ViewBinaryAbort): void {
  acknowledgeUiBinary(record, {
    instanceId: record.binding.viewInstanceId,
    type: 'binary',
    documentId: record.documentId ?? undefined,
    transferId: abort.transferId,
    seq: abort.seq,
    done: abort.done,
  }, false, abort.reason);
}
function binaryReceiverFor(record: ViewRecord): ViewBinaryReceiver {
  if (!record.binaryReceiver) {
    record.binaryReceiver = new ViewBinaryReceiver({
      budget: viewBinaryBudget, owner: record.binding.pluginId,
      abort: (abort) => acknowledgeBinaryAbort(record, abort),
    });
  }
  return record.binaryReceiver;
}
/** Trusted pages have no fixed ready deadline while loading, but a document that
 *  already finished navigating yet never reports `ready` must not stay loading
 *  forever: arm a generous watchdog only after a successful navigation. */
function armTrustedReadyWatchdog(record: ViewRecord, documentId: string): void {
  if (record.declaration.mode !== 'trusted-web' || record.nativeReady) return;
  clearTimer(record, 'navigationReadyTimer');
  record.navigationReadyTimer = setTimeout(() => {
    if (live(record) && record.documentId === documentId && !record.nativeReady) fail(record, 'plugin UI did not become ready');
  }, TRUSTED_READY_TIMEOUT_MS);
}
/** Capacity backpressure must not kill a healthy view: drop the interaction and
 *  warn at a bounded rate instead of turning it into a protocol/state failure. */
function warnDroppedInteraction(record: ViewRecord): void {
  const now = Date.now();
  if (now - record.lastInteractionDropWarn < INTERACTION_DROP_WARN_MS) return;
  record.lastInteractionDropWarn = now;
  console.warn('[pluginView] interaction dropped: plugin Worker capacity exceeded');
}
function retire(record: ViewRecord, reason: string | null): void {
  if (!record.alive) return;
  record.timeline?.dispose(); record.timeline = null;
  record.alive = false;
  clearTimer(record, 'readyTimer'); clearTimer(record, 'ackTimer'); clearTimer(record, 'flushTimer');
  clearTimer(record, 'workerReadyTimer'); clearTimer(record, 'navigationReadyTimer');
  record.unsubscribeInput?.(); record.unsubscribeInput = null;
  if (record.usesWorker && record.documentId) {
    (pluginHost.get(record.binding.pluginId) as ViewBinarySession | null)
      ?.cancelViewBinary?.(record.binding.viewInstanceId, record.documentId);
  }
  record.binarySender?.cancel('plugin view closed');
  record.binarySender = null;
  record.binaryReceiver?.reset();
  record.binaryReceiver = null;
  if (record.usesWorker) {
    const worker = pluginHost.get(record.binding.pluginId);
    if (worker?.loaded && !worker.post({ type: 'view.close', payload: { instanceId: record.binding.viewInstanceId, reason } })) {
      pluginHost.disable(record.binding.pluginId);
    }
  }
  records.delete(record.binding.tabId);
  record.retirement = pluginViewService.destroy(record.binding.viewInstanceId);
  void record.retirement.catch(error => console.debug('[pluginView] destroy', error));
  record.latest = null; record.retained = null; record.inFlight = null; record.documentId = null;
  if (reason) {
    const tab = useAppStore.getState().tabs.find(item => item.id === record.binding.tabId);
    const preference = tab && preferenceFor(tab);
    if (tab && preference) failures.set(identity(tab, preference), reason);
    setState(record.binding.tabId, { status: 'unavailable', error: reason, instanceId: null });
  }
}
export function failPluginViewInstance(pluginId: string, instanceId: string, reason: string): void {
  const record = [...records.values()].find(item => item.binding.viewInstanceId === instanceId && item.binding.pluginId === pluginId);
  if (record) fail(record, reason);
}
function updateTimelineVisibility(record: ViewRecord): void {
  record.timeline?.setVisible(live(record) && record.nativeReady && record.workerReady && record.visible && !overlayBlocked);
}
function updateReadyState(record: ViewRecord): void {
  updateTimelineVisibility(record);
  if (live(record) && record.nativeReady && record.workerReady) {
    setState(record.binding.tabId, { status: 'ready', error: null, instanceId: record.binding.viewInstanceId });
  }
}
export function markPluginViewWorkerReady(pluginId: string, instanceId: string): void {
  const record = [...records.values()].find(item => item.binding.viewInstanceId === instanceId && item.binding.pluginId === pluginId);
  if (!record || !live(record) || !record.usesWorker) return;
  record.workerReady = true;
  clearTimer(record, 'workerReadyTimer');
  updateReadyState(record);
  void place(record).catch(error => fail(record, error));
  flush(record);
}
function fail(record: ViewRecord, error: unknown): void { if (live(record)) retire(record, errorText(error)); }
function armAck(record: ViewRecord): void {
  clearTimer(record, 'ackTimer');
  if (record.inFlight && record.visible && !overlayBlocked) record.ackTimer = setTimeout(() => fail(record, 'plugin UI did not acknowledge state'), 5000);
}
async function sendEnvironment(record: ViewRecord): Promise<void> {
  if (!live(record) || !record.nativeReady || !record.documentId) return;
  const documentId = record.documentId;
  const next = environment(record);
  const signature = JSON.stringify(next);
  if (record.lastEnvironment === signature) return;
  record.lastEnvironment = signature;
  try {
    await pluginViewService.send(record.binding.viewInstanceId, { type: 'environment', documentId, environment: next });
  } catch (error) {
    // A navigation can retire this document while the native send is in flight;
    // that is not a failure of the replacement document.
    if (live(record) && record.documentId === documentId) throw error;
  }
}
function pendingBytes(pluginId: string): number {
  let total = 0;
  for (const record of records.values()) if (record.binding.pluginId === pluginId) total += (record.latest?.bytes ?? 0) + (record.inFlight?.bytes ?? 0);
  return total;
}
function flush(record: ViewRecord): void {
  if (!record.usesWorker || !live(record) || !record.nativeReady || !record.workerReady || !record.visible || overlayBlocked || record.inFlight || !record.latest || !record.documentId) return;
  const remaining = 34 - (Date.now() - record.lastSentAt);
  if (remaining > 0) {
    if (record.flushTimer === null) record.flushTimer = setTimeout(() => { record.flushTimer = null; flush(record); }, remaining);
    return;
  }
  const next = record.latest; record.latest = null;
  const revision = ++record.revision;
  record.inFlight = { revision, bytes: next.bytes }; record.lastSentAt = Date.now();
  armAck(record);
  const documentId = record.documentId;
  void pluginViewService.send(record.binding.viewInstanceId, { type: 'state', documentId, revision, snapshot: next.snapshot })
    .catch(error => { if (live(record) && record.documentId === documentId) fail(record, error); });
}
async function createRecord(tab: TabItem, preference: PluginViewPreference, view: PluginViewDeclaration, plugin: PluginView): Promise<void> {
  const usesWorker = view.worker !== false && (plugin.manifest?.entry?.length ?? 0) > 0;
  const worker = usesWorker ? pluginHost.get(preference.pluginId) : null;
  if (usesWorker && !worker?.loaded) {
    // Worker is restarting/disabled: never leave a stale `ready` state with a
    // dead instance id (the stock terminal would stay hidden). Reconcile runs
    // again when the session starts. Independent local pages never wait here.
    setState(tab.id, { status: 'unavailable', error: 'plugin Worker unavailable', instanceId: null });
    return;
  }
  if (records.size >= MAX_ALL || [...records.values()].filter(record => record.binding.pluginId === preference.pluginId).length >= MAX_PER_PLUGIN) {
    const reason = 'plugin view instance capacity exceeded'; failures.set(identity(tab, preference), reason); setState(tab.id, { status: 'unavailable', error: reason, instanceId: null }); return;
  }
  const tabSessionId = tabSessions.get(tab.id) ?? crypto.randomUUID(); tabSessions.set(tab.id, tabSessionId);
  const portId = getTabPortId(tab);
  const binding: PluginViewBinding = { ...preference, tabId: tab.id, placement: tab.kind === 'serial' ? 'serial-content' : 'workspace-tab', boundPortId: portId, portMode: portId ? useAppStore.getState().ports.find(port => port.id === portId)?.mode ?? 'trx' : null, tabSessionId, viewInstanceId: crypto.randomUUID(), workerEpoch: usesWorker ? worker!.epoch : 0, streamEpoch: 0 };
  const record: ViewRecord = { binding, declaration: view, usesWorker, documentId: null, binarySender: null, binaryReceiver: null, timeline: null, alive: true, nativeCreated: false, nativeReady: false, nativeInitializing: false, workerReady: !usesWorker, retirement: null, visible: false, rect: null, layoutRevision: 0, revision: 0, inFlight: null, latest: null, retained: null, readyTimer: null, navigationReadyTimer: null, workerReadyTimer: null, ackTimer: null, flushTimer: null, lastSentAt: 0, unsubscribeInput: null, interactionTokens: 32, interactionTime: Date.now(), lastInteractionDropWarn: 0, lastEnvironment: '' };
  records.set(tab.id, record); setState(tab.id, { status: 'loading', error: null, instanceId: binding.viewInstanceId });
  try {
    await pluginViewService.create(binding);
    if (!live(record)) { await pluginViewService.destroy(binding.viewInstanceId); return; }
    record.nativeCreated = true;
    // Trusted local documents may legitimately take as long as they need; a
    // genuine native load/process failure still arrives as a native error.
    if (!record.nativeReady && !record.nativeInitializing && view.mode !== 'trusted-web') record.readyTimer = setTimeout(() => fail(record, 'plugin UI initialization timed out'), 5000);
    if (usesWorker) {
      if (!worker!.post({ type: 'view.open', payload: { context: binding, params: openParams.get(tab.id) ?? null, documentId: record.documentId } })) throw new Error('plugin Worker control capacity exceeded');
      if (!record.workerReady) record.workerReadyTimer = window.setTimeout(() => fail(record, 'plugin parser initialization timed out'), 10000);
      record.unsubscribeInput = subscribePluginViewInput(binding, view.input, {
        onInput: (batch, streamEpoch, gapBefore) => {
          if (!live(record) || worker!.epoch !== binding.workerEpoch) return false;
          if (binding.streamEpoch !== streamEpoch) record.timeline?.updateSourceGeneration(streamEpoch);
          binding.streamEpoch = streamEpoch;
          return worker!.post({ type: 'view.input', payload: { instanceId: binding.viewInstanceId, streamEpoch, gapBefore, batch } });
        },
        onDiscontinuity: (reason, streamEpoch) => { if (binding.streamEpoch !== streamEpoch) record.timeline?.updateSourceGeneration(streamEpoch); binding.streamEpoch = streamEpoch; worker!.post({ type: 'view.discontinuity', payload: { instanceId: binding.viewInstanceId, reason, streamEpoch } }); },
        onStatus: (status, streamEpoch) => { if (binding.streamEpoch !== streamEpoch) record.timeline?.updateSourceGeneration(streamEpoch); binding.streamEpoch = streamEpoch; worker!.post({ type: 'view.status', payload: { instanceId: binding.viewInstanceId, status, streamEpoch } }); },
      });
    }
    if (record.rect) await place(record);
  } catch (error) { fail(record, error); }
}
function queueReconcile(): void {
  if (!started || reconcileQueued) return;
  reconcileQueued = true;
  queueMicrotask(() => { reconcileQueued = false; reconcile(); });
}
function reconcile(): void {
  if (!started || !nativeUnlisten || !useSystemStore.getState().ui.configReady) return;
  const state = useAppStore.getState();
  const tabIds = new Set(state.tabs.map(tab => tab.id));
  for (const record of [...records.values()]) {
    const tab = state.tabs.find(item => item.id === record.binding.tabId);
    const preference = tab && preferenceFor(tab);
    if (!tab || !preference) { retire(record, null); continue; }
    try {
      const placement = tab.kind === 'serial' ? 'serial-content' : 'workspace-tab';
      eligible(preference, getTabPortId(tab), placement);
      if (identity(tab, preference) !== JSON.stringify([record.binding.tabId, record.binding.pluginId, record.binding.installGeneration, record.binding.viewId, record.binding.boundPortId])) { retire(record, null); continue; }
      if (record.usesWorker) {
        const worker = pluginHost.get(preference.pluginId);
        if (!worker?.loaded || worker.epoch !== record.binding.workerEpoch) { retire(record, 'plugin Worker stopped'); continue; }
      }
      void sendEnvironment(record).catch(error => fail(record, error));
    } catch (error) { fail(record, error); }
  }
  for (const tabId of [...tabSessions.keys()]) if (!tabIds.has(tabId)) { tabSessions.delete(tabId); openParams.delete(tabId); }
  const liveIdentityKeys = new Set(state.tabs.flatMap(tab => { const preference = preferenceFor(tab); return preference ? [identity(tab, preference)] : []; }));
  for (const key of failures.keys()) if (!liveIdentityKeys.has(key)) failures.delete(key);
  let removed = false;
  for (const tabId of Object.keys(states)) if (!tabIds.has(tabId)) { const copy = { ...states }; delete copy[tabId]; states = copy; removed = true; }
  if (removed) emit();
  for (const tab of state.tabs) {
    const preference = preferenceFor(tab);
    if (!preference || records.has(tab.id)) continue;
    const key = identity(tab, preference);
    if (failures.has(key)) continue;
    try {
      const { plugin, view } = eligible(preference, getTabPortId(tab), tab.kind === 'serial' ? 'serial-content' : 'workspace-tab');
      if (tab.kind === 'plugin' && !openParams.has(tab.id) && !view.restoreOnStartup) throw new Error('plugin view cannot restore automatically');
      void createRecord(tab, preference, view, plugin);
    } catch (error) {
      setState(tab.id, { status: 'unavailable', error: errorText(error), instanceId: null });
    }
  }
}
async function place(record: ViewRecord): Promise<void> {
  if (!live(record) || !record.nativeCreated || !record.rect) return;
  await pluginViewService.update(record.binding.viewInstanceId, record.rect, record.visible && !overlayBlocked && record.nativeReady && record.workerReady, ++record.layoutRevision, currentOcclusions);
}
export function placePluginView(tabId: string, rect: PluginViewRect, visible: boolean): void {
  const record = records.get(tabId);
  if (!record) return;
  const wasVisible = record.visible; record.rect = rect; record.visible = visible;
  updateTimelineVisibility(record);
  if (!visible) clearTimer(record, 'ackTimer');
  else if (!wasVisible) {
    if (record.retained) record.latest = record.retained;
    armAck(record); flush(record);
  }
  void place(record).catch(error => fail(record, error));
  void sendEnvironment(record).catch(error => fail(record, error));
}
export async function suppressPluginViews(suppressed: boolean, occlusions: PluginViewportRect[] = []): Promise<void> {
  currentOcclusions = normalizeOcclusions(occlusions);
  overlayBlocked = suppressed;
  await Promise.all([...records.values()].map(async record => {
    updateTimelineVisibility(record);
    if (suppressed) clearTimer(record, 'ackTimer'); else { armAck(record); flush(record); }
    try { await place(record); await sendEnvironment(record); } catch (error) {
      fail(record, error);
      // A failed visibility or exclusion update cannot authorize host overlays until the child is destroyed.
      await record.retirement;
    }
  }));
}
export function retryPluginView(tabId: string): void {
  const tab = useAppStore.getState().tabs.find(item => item.id === tabId); const preference = tab && preferenceFor(tab);
  if (!tab || !preference) return;
  failures.delete(identity(tab, preference)); const record = records.get(tabId); if (record) retire(record, null);
  queueReconcile();
}
/** Reload installed code: retire that plugin's native pages and remount open
 *  tabs against the current snapshot. Independent HTML pages remount too. */
export function reloadPluginViews(pluginId: string): void {
  for (const record of [...records.values()]) if (record.binding.pluginId === pluginId) retire(record, null);
  for (const key of [...failures.keys()]) {
    try {
      const parts = JSON.parse(key) as unknown;
      if (Array.isArray(parts) && parts[1] === pluginId) failures.delete(key);
    } catch { failures.delete(key); }
  }
  queueReconcile();
}
export function selectSerialPluginView(tabId: string, preference: PluginViewPreference | null): void {
  const tab = useAppStore.getState().tabs.find(item => item.id === tabId);
  if (tab?.kind !== 'serial') throw new Error('serial tab required');
  if (preference) {
    eligible(preference, tab.portId, 'serial-content');
    const candidates = useAppStore.getState().tabs.filter(item => item.id !== tabId).flatMap(item => {
      const selected = preferenceFor(item); return selected ? [selected] : [];
    });
    if (candidates.length >= MAX_ALL || candidates.filter(item => item.pluginId === preference.pluginId).length >= MAX_PER_PLUGIN) throw new Error('plugin view instance capacity exceeded');
  }
  const record = records.get(tabId); if (record) retire(record, null);
  if (preference) failures.delete(identity(tab, preference));
  const store = useAppStore.getState();
  if (store.ports.some(port => port.id === tab.portId)) {
    store.updatePort(tab.portId, { displayView: preference });
  } else {
    // The tab outlives its port (unplugged / not re-enumerated). `updatePort`
    // is a no-op then, so persist the choice in portMeta; the preference
    // survives until the port reappears and drives the picker immediately.
    const existing = store.config.portMeta.find(entry => entry.portId === tab.portId);
    const entry = {
      portId: tab.portId,
      alias: existing?.alias,
      isHidden: existing?.isHidden ?? false,
      mode: existing?.mode,
      displayView: preference,
    };
    store.setConfig({ portMeta: [...store.config.portMeta.filter(item => item.portId !== tab.portId), entry] });
    const live = useAppStore.getState().ports;
    void saveCurrentPortMeta({
      entries: [...collectPortMeta(live), entry],
      presentIds: [...live.map(port => port.id), tab.portId],
    }).catch((error) => console.debug('[pluginViewRuntime] persist display view failed:', error));
  }
  queueReconcile();
  if (!preference) setState(tabId, EMPTY_STATE);
}
function openKey(pluginId: string, generation: string, viewId: string, portId: string | null, instanceKey: string): string { return JSON.stringify([pluginId, generation, viewId, portId, instanceKey]); }
function rateLimitView(pluginId: string): void {
  const now = Date.now();
  const rate = viewRates.get(pluginId) ?? { tokens: 60, time: now };
  rate.tokens = Math.min(60, rate.tokens + (now - rate.time) / 8); // ~120/s
  rate.time = now;
  if (rate.tokens < 1) throw new Error('plugin view publish rate exceeded');
  rate.tokens--;
  viewRates.set(pluginId, rate);
}
function rateLimit(pluginId: string): void {
  const now = Date.now(); const rate = rates.get(pluginId) ?? { tokens: 4, time: now };
  rate.tokens = Math.min(4, rate.tokens + (now - rate.time) / 500); rate.time = now;
  if (rate.tokens < 1) throw new Error('plugin tab action rate exceeded');
  rate.tokens--; rates.set(pluginId, rate);
}
function currentPlugin(pluginId: string, requireTabs = true): PluginView {
  const plugin = getPluginViews().find(item => item.id === pluginId);
  const config = useAppStore.getState().config.pluginConfigs.find(item => item.id === pluginId);
  if (!plugin?.manifest || !config?.enabled || config.installGeneration !== plugin.installGeneration) throw new Error('plugin unavailable');
  if (!config.grantedPermissions.includes('ui:view') || (requireTabs && !config.grantedPermissions.includes('ui:tabs'))) throw new Error('plugin tab permission denied');
  return plugin;
}
export function issuePluginActionToken(pluginId: string, portId: string | null, paneId: string): string | undefined {
  const config = useAppStore.getState().config.pluginConfigs.find(item => item.id === pluginId);
  if (!config?.enabled) return undefined;
  const now = Date.now(); for (const [token, action] of actionTokens) if (action.expires <= now) actionTokens.delete(token);
  if (actionTokens.size >= 128) return undefined;
  const token = crypto.randomUUID(); actionTokens.set(token, { pluginId, generation: config.installGeneration, portId, paneId, expires: now + 5000 }); return token;
}
function consumeToken(plugin: PluginView, token: unknown, portId: string | null): string {
  if (typeof token !== 'string') throw new Error('foreground activation requires a user action');
  const action = actionTokens.get(token); actionTokens.delete(token);
  if (!action || action.pluginId !== plugin.id || action.generation !== plugin.installGeneration || action.expires < Date.now() || (action.portId && action.portId !== portId)) throw new Error('user action expired or scope mismatch');
  return action.paneId;
}
function openTabFor(pluginId: string, options: PluginTabOpenOptions, user: boolean): { tabId: string; created: boolean; state: PluginViewState['status'] } {
  const plugin = currentPlugin(pluginId, !user); rateLimit(pluginId);
  const viewId = typeof options.viewId === 'string' && options.viewId.trim() && options.viewId.length <= 128 ? options.viewId : (() => { throw new Error('invalid viewId'); })();
  const portId = options.portId ?? null;
  if (portId !== null && (typeof portId !== 'string' || !portId.trim())) throw new Error('invalid portId');
  const instanceKey = options.instanceKey ?? 'default';
  if (typeof instanceKey !== 'string' || !instanceKey.trim() || instanceKey.length > 128) throw new Error('invalid instanceKey');
  if (options.activation !== undefined && options.activation !== 'background' && options.activation !== 'foreground') throw new Error('invalid activation');
  const initialParams = options.params === undefined ? null : boundedPluginViewJson(options.params, 16 * 1024).value;
  const preference = { pluginId, installGeneration: plugin.installGeneration, viewId };
  const { view } = eligible(preference, portId, 'workspace-tab');
  const activate = user || options.activation === 'foreground';
  const sourcePane = user ? useAppStore.getState().focusedPaneId : activate ? consumeToken(plugin, options.actionToken, portId) : collectLeaves(useAppStore.getState().paneTree)[0]?.id;
  const key = openKey(pluginId, plugin.installGeneration, viewId, portId, instanceKey);
  const closed = dismissed.get(pluginId);
  if (!user && !activate && (closed?.has(key) || (closed?.size ?? 0) >= 128)) throw new Error('plugin tab dismissed by user');
  if (user || activate) closed?.delete(key);
  const state = useAppStore.getState();
  const existing = state.tabs.find(tab => tab.kind === 'plugin' && openKey(tab.pluginId, tab.installGeneration, tab.viewId, tab.boundPortId, tab.instanceKey) === key);
  if (existing) { if (activate) state.setActiveTab(existing.id); return { tabId: existing.id, created: false, state: getPluginViewState(existing.id).status }; }
  const ownCount = state.tabs.filter(tab => tab.kind === 'plugin' && tab.pluginId === pluginId).length;
  const allCount = state.tabs.filter(tab => tab.kind === 'plugin').length;
  const serialPreferences = state.tabs.filter(tab => tab.kind === 'serial' && preferenceFor(tab));
  const declaredCount = allCount + serialPreferences.length;
  const ownDeclaredCount = ownCount + serialPreferences.filter(tab => preferenceFor(tab)?.pluginId === pluginId).length;
  if (ownDeclaredCount >= MAX_PER_PLUGIN || declaredCount >= MAX_ALL) throw new Error('plugin tab capacity exceeded');
  const paneId = sourcePane && findLeafById(state.paneTree, sourcePane) ? sourcePane : collectLeaves(state.paneTree)[0]?.id;
  const tabId = state.addPluginTab({ kind: 'plugin', pluginId, installGeneration: plugin.installGeneration, viewId, boundPortId: portId, instanceKey, restoreOnStartup: view.restoreOnStartup, title: view.label }, { paneId, activate });
  openParams.set(tabId, initialParams); queueReconcile();
  return { tabId, created: true, state: 'loading' };
}
export function openPluginTabForUser(preference: PluginViewPreference, portId: string | null, instanceKey?: string): string {
  const plugin = currentPlugin(preference.pluginId, false);
  if (plugin.installGeneration !== preference.installGeneration) throw new Error('plugin installation changed');
  let selectedInstanceKey = instanceKey;
  if (selectedInstanceKey === undefined) {
    const state = useAppStore.getState();
    const matching = state.tabs.filter(tab => tab.kind === 'plugin'
      && tab.pluginId === preference.pluginId
      && tab.installGeneration === preference.installGeneration
      && tab.viewId === preference.viewId
      && tab.boundPortId === portId);
    const existing = matching.find(tab => tab.id === state.activeTabId) ?? matching[0];
    selectedInstanceKey = existing?.kind === 'plugin' ? existing.instanceKey : 'default';
  }
  return openTabFor(preference.pluginId, { viewId: preference.viewId, portId, instanceKey: selectedInstanceKey }, true).tabId;
}
export function dismissPluginTab(tabId: string): void {
  const tab = useAppStore.getState().tabs.find(item => item.id === tabId);
  if (tab?.kind === 'plugin') {
    const set = dismissed.get(tab.pluginId) ?? new Set<string>();
    if (set.size < 128) set.add(openKey(tab.pluginId, tab.installGeneration, tab.viewId, tab.boundPortId, tab.instanceKey));
    dismissed.set(tab.pluginId, set);
  }
  const record = records.get(tabId); if (record) retire(record, null);
  openParams.delete(tabId);
}
function ownedTab(pluginId: string, args: unknown): TabItem {
  const object = requireObject(args); const tabId = requireString(object, 'tabId');
  const tab = useAppStore.getState().tabs.find(item => item.id === tabId);
  const plugin = currentPlugin(pluginId);
  if (tab?.kind !== 'plugin' || tab.pluginId !== pluginId || tab.installGeneration !== plugin.installGeneration) throw new Error('plugin tab ownership denied');
  return tab;
}
function ownedRecord(pluginId: string, args: unknown): { record: ViewRecord; object: Record<string, unknown> } {
  const object = requireObject(args); const instanceId = requireString(object, 'instanceId');
  const record = [...records.values()].find(item => item.binding.viewInstanceId === instanceId);
  if (!record || !live(record) || record.binding.pluginId !== pluginId) throw new Error('plugin view session expired');
  const tab = useAppStore.getState().tabs.find(item => item.id === record.binding.tabId);
  if (!tab) throw new Error('plugin view tab closed');
  eligible(record.binding, record.binding.boundPortId, record.binding.placement);
  if (record.usesWorker && pluginHost.get(pluginId)?.epoch !== record.binding.workerEpoch) throw new Error('plugin Worker changed');
  return { record, object };
}
export async function executePluginViewApi(pluginId: string, op: string, args: unknown, manifest: PluginManifestView | null, beforeSend?: () => void): Promise<unknown> {
  if (op === 'tabs.open') return openTabFor(pluginId, requireObject(args) as unknown as PluginTabOpenOptions, false);
  if (op === 'tabs.list') { currentPlugin(pluginId); return useAppStore.getState().tabs.filter(tab => tab.kind === 'plugin' && tab.pluginId === pluginId).map(tab => ({ tabId: tab.id, title: tab.title, portId: getTabPortId(tab), state: getPluginViewState(tab.id).status })); }
  if (op.startsWith('tabs.')) {
    const tab = ownedTab(pluginId, args); const object = requireObject(args); rateLimit(pluginId);
    if (op === 'tabs.activate') { consumeToken(currentPlugin(pluginId), object.actionToken, getTabPortId(tab)); useAppStore.getState().setActiveTab(tab.id); return null; }
    if (op === 'tabs.close') {
      if (tab.isPinned) throw new Error('pinned tab requires user close');
      const portId = getTabPortId(tab);
      dismissPluginTab(tab.id); useAppStore.getState().closeTab(tab.id);
      if (portId) releaseUnusedPortState(portId);
      return null;
    }
    if (op === 'tabs.setTitle') { useAppStore.getState().setTabTitle(tab.id, requireString(object, 'title')); return null; }
    throw new Error('unknown plugin tab operation');
  }
  const { record, object } = ownedRecord(pluginId, args);
  if (op === 'view.sendBinary') {
    if (!record.usesWorker) throw new Error('plugin view has no Worker binary peer');
    const type = requireString(object, 'type', 128);
    if (object.documentId != null && object.documentId !== record.documentId) throw new Error('plugin view document changed');
    if (!(object.bytes instanceof Uint8Array) && !(object.bytes instanceof ArrayBuffer)) throw new Error('invalid binary view bytes');
    // RPC bytes already belong to this window: avoid retaining both the cloned
    // request and a second full sender copy while waiting for page ACKs.
    const sending = binarySenderFor(record).send(type, object.bytes, true);
    object.bytes = null;
    return sending;
  }
  if (op === 'view.publish') {
    if (!record.usesWorker) throw new Error('plugin view has no Worker binary peer');
    // Validate/parse before the frame throttle: bound the CPU spent on snapshots
    // that the 34ms flush would coalesce away anyway.
    rateLimitView(pluginId);
    const normalized = boundedPluginViewJson(object.snapshot, MAX_SNAPSHOT_BYTES);
    if (pendingBytes(pluginId) - (record.latest?.bytes ?? 0) + normalized.bytes > MAX_PLUGIN_PENDING_BYTES) throw new Error('plugin UI pending capacity exceeded');
    record.retained = { snapshot: normalized.value, bytes: normalized.bytes };
    record.latest = record.retained; flush(record); return null;
  }
  if (op === 'view.sendSerial') {
    const portId = record.binding.boundPortId; if (!portId) throw new Error('view has no bound port');
    const authorizeSend = (): void => {
      beforeSend?.();
      ownedRecord(pluginId, args);
      const config = useAppStore.getState().config.pluginConfigs.find(entry => entry.id === pluginId);
      if (!config?.grantedPermissions.includes('serial:send')) throw new Error('plugin requires serial:send');
      const denied = checkPortScope(manifest, portId); if (denied) throw new Error(denied);
    };
    authorizeSend();
    const data = requireString(object, 'data', 65536);
    const bytesWritten = await sendToPort(portId, data, object.isHex === true, typeof object.lineEnding === 'string' ? object.lineEnding : 'None', true, authorizeSend);
    return { bytesWritten };
  }
  throw new Error('unknown plugin view operation');
}
async function handleNative(message: PluginNativeMessage): Promise<void> {
  const record = [...records.values()].find(item => item.binding.viewInstanceId === message.instanceId);
  if (!record || !live(record)) return;
  try {
    ownedRecord(record.binding.pluginId, { instanceId: message.instanceId });
    const documentId = typeof message.documentId === 'string' && message.documentId ? message.documentId : null;
    if (message.type === 'document') {
      if (documentId) beginDocument(record, documentId);
      return;
    }
    if (message.type === 'ready') {
      if (!documentId) throw new Error('plugin UI ready without a document identity');
      // The native `document` announcement is the authority once a document is
      // known; a delayed ready from a replaced document must not take over.
      if (record.documentId === null) beginDocument(record, documentId);
      else if (record.documentId !== documentId) return;
      if (record.nativeReady || record.nativeInitializing) return;
      record.nativeInitializing = true;
      clearTimer(record, 'readyTimer');
      clearTimer(record, 'navigationReadyTimer');
      const initialEnvironment = environment(record);
      record.lastEnvironment = JSON.stringify(initialEnvironment);
      try {
        await pluginViewService.send(message.instanceId, { type: 'init', documentId, context: record.binding, environment: initialEnvironment });
      } catch (error) {
        if (live(record) && record.documentId === documentId) throw error;
        return;
      }
      if (!live(record) || record.documentId !== documentId) return;
      record.nativeReady = true;
      record.nativeInitializing = false;
      if (record.retained) record.latest = record.retained;
      updateReadyState(record);
      await place(record);
      flush(record);
      record.binarySender?.pump();
      return;
    }
    // Process failures can surface before the first document exists; they are
    // not a stale document event and must still retire the broken instance.
    if (message.type === 'error' && !documentId) { fail(record, message.error ?? 'plugin UI failed'); return; }
    // Every later event is scoped to the document that was initialized above;
    // ACKs, page messages and binary chunks from a replaced document are stale.
    if (!documentId || documentId !== record.documentId) return;
    if (message.type === 'navigation-complete') { armTrustedReadyWatchdog(record, documentId); return; }
    if (message.type === 'timeline') {
      // Native has already supplied/checked document+instance identity. This
      // path is deliberately independent of usesWorker, state ACK and binary.
      if (!record.timeline) record.timeline = new PluginTimeline({
        binding: record.binding, declaration: record.declaration, documentId,
        send: control => pluginViewService.send(record.binding.viewInstanceId, control),
      });
      updateTimelineVisibility(record);
      record.timeline.receive(message.payload);
      return;
    }
    if (message.type === 'ack') {
      if (!record.nativeReady || record.inFlight?.revision !== message.revision) return;
      clearTimer(record, 'ackTimer'); record.inFlight = null; flush(record);
    } else if (message.type === 'error') fail(record, message.error ?? 'plugin UI failed');
    else if (message.type === 'focus') { if (record.visible && !overlayBlocked) useAppStore.getState().setActiveTab(record.binding.tabId); }
    else if (message.type === 'message') {
      if (!record.nativeReady || !record.usesWorker) return;
      if (typeof message.messageType !== 'string' || !message.messageType || message.messageType.length > 128) throw new Error('invalid UI message');
      const now = Date.now();
      record.interactionTokens = Math.min(32, record.interactionTokens + (now - record.interactionTime) * 0.03);
      record.interactionTime = now;
      if (record.interactionTokens < 1) throw new Error('plugin UI interaction rate exceeded');
      record.interactionTokens--;
      jsonBytes(message.payload ?? null, 16 * 1024);
      // Capacity backpressure is transient (e.g. a large binary transfer in
      // flight): drop this interaction and keep the view alive; only protocol
      // violations above retire it.
      if (!pluginHost.get(record.binding.pluginId)?.post({ type: 'view.message', payload: { instanceId: message.instanceId, type: message.messageType, payload: message.payload } })) {
        warnDroppedInteraction(record);
        return;
      }
    } else if (message.type === 'binary') {
      if (!record.nativeReady) return;
      if (typeof message.transferId !== 'string' || typeof message.seq !== 'number' || typeof message.done !== 'boolean'
        || typeof message.transferType !== 'string' || typeof message.data !== 'string') return;
      if (!record.usesWorker) { acknowledgeUiBinary(record, message, false, 'plugin view has no Worker binary peer'); return; }
      const receiver = binaryReceiverFor(record);
      const received = receiver.push({
        documentId, transferId: message.transferId, transferType: message.transferType,
        seq: message.seq, done: message.done, data: message.data,
      });
      if (received.kind === 'error') { acknowledgeUiBinary(record, message, false, received.error); return; }
      if (received.kind === 'buffered') { acknowledgeUiBinary(record, message, true); return; }
      const worker = pluginHost.get(record.binding.pluginId) as ViewBinarySession | null;
      if (!worker?.postViewBinary || worker.epoch !== record.binding.workerEpoch) {
        received.release();
        acknowledgeUiBinary(record, message, false, 'plugin Worker changed');
        return;
      }
      try {
        await worker.postViewBinary({ instanceId: record.binding.viewInstanceId, documentId, transferId: message.transferId, type: received.transferType, bytes: received.bytes });
        if (live(record) && record.documentId === documentId) acknowledgeUiBinary(record, message, true);
      } catch (error) {
        if (live(record) && record.documentId === documentId) acknowledgeUiBinary(record, message, false, errorText(error));
      } finally { received.release(); }
    } else if (message.type === 'binary-ack') {
      if (typeof message.transferId !== 'string' || typeof message.seq !== 'number') return;
      record.binarySender?.acknowledge({
        documentId, transferId: message.transferId, seq: message.seq, done: message.done === true,
        ok: message.ok === true, error: typeof message.error === 'string' ? message.error : undefined,
      });
    }
  } catch (error) { fail(record, error); }
}
export function startPluginViewRuntime(): () => void {
  if (started) throw new Error('plugin view runtime already started');
  started = true;
  const generation = ++runtimeGeneration;
  const unsubscribers = [subscribePluginViews(queueReconcile), subscribePluginSessions(queueReconcile), useAppStore.subscribe((state, previous) => {
    if (state.tabs !== previous.tabs || state.ports !== previous.ports || state.config !== previous.config || state.activeTabId !== previous.activeTabId) queueReconcile();
  }), useSystemStore.subscribe((state, previous) => { if (state.ui.configReady !== previous.ui.configReady) queueReconcile(); })];
  void pluginViewService.onMessage(message => {
    if (started && runtimeGeneration === generation) void handleNative(message);
  }).then(unlisten => {
    if (started && runtimeGeneration === generation) { nativeUnlisten = unlisten; queueReconcile(); } else unlisten();
  }).catch(error => { console.error('[pluginView] event listener', error); });
  return () => {
    if (!started || runtimeGeneration !== generation) return;
    started = false; for (const unsubscribe of unsubscribers) unsubscribe(); nativeUnlisten?.(); nativeUnlisten = null;
    for (const record of [...records.values()]) retire(record, null);
    overlayBlocked = false; currentOcclusions = [];
    states = {}; failures.clear(); tabSessions.clear(); openParams.clear(); dismissed.clear(); rates.clear(); actionTokens.clear(); emit();
  };
}
