/** Shared app-lifetime serial lifecycle. No React effects or component ownership. */
import { useAppStore } from '../stores/useAppStore';
import { useOperationStore } from '../stores/useOperationStore';
import { useTerminalStore } from '../stores/useTerminalStore';
import { serialService, eventService } from '../services/tauri';
import type { OpenPortParams, SerialReconnectHintEvent } from '../services/tauri';
import type { DataBits, Handshake, Parity, SerialPort, StopBits } from '../types';
import { notifySuccess, extractErrorMessage, useToastStore } from '../stores/useToastStore';
import { userClosingPortIds, lostPortIds } from '../hooks/disconnectTracking';
import { ttyService } from './ttyService';

export type SerialConnectionErrorCode = 'port-not-found' | 'tool-running' | 'connection-busy' | 'superseded';

/** A fulfilled operation always describes a completed action; skipped/stale work rejects. */
export class SerialConnectionError extends Error {
  constructor(public readonly code: SerialConnectionErrorCode, public readonly portId: string) {
    super(`Serial connection ${code}: ${portId}`);
    this.name = 'SerialConnectionError';
  }
}

export type SerialConnectionParams = Omit<OpenPortParams, 'portId' | 'dataBits' | 'parity' | 'stopBits' | 'handshake'> & {
  dataBits: DataBits;
  parity: Parity;
  stopBits: StopBits;
  handshake: Handshake;
};
interface SerialNativeOptions<T> {
  /** Plugin/native discovery can lead the frontend's polling snapshot. */
  allowUnknownPort?: boolean;
  /** Adopt a successful native summary only while this operation owns the lane. */
  readPort?: (value: T) => SerialPort;
  assertAuthority?: () => void;
}
export interface SerialOpenOptions<T> extends SerialNativeOptions<T> {
  params?: Partial<SerialConnectionParams>;
  /** Plugin/background sessions must never create or activate a raw terminal tab. */
  background?: boolean;
  /** Plugins still invoke on an existing session to obtain backend identity/ownership. */
  invokeWhenConnected?: boolean;
  perform?: (params: OpenPortParams) => Promise<T>;
  /** Native plugin commands distinguish idempotent open and return session identity. */
  readResult?: (value: T) => { result: 'opened' | 'already-open'; connectionGeneration: number; baudRate?: number };
  /** Recheck permission/session identity when queued work actually owns the lane. */
  assertAuthority?: () => void;
}
export interface SerialCloseOptions<T> extends SerialNativeOptions<T> {
  perform?: () => Promise<T>;
  readResult?: (value: T) => 'closed' | 'already-closed';
}
export interface SerialOpenResult<T = void> {
  port: SerialPort;
  result: 'opened' | 'already-open';
  value: T | undefined;
}
export interface SerialCloseResult<T = void> {
  port: SerialPort;
  result: 'closed' | 'already-closed';
  value: T | undefined;
}

type PortIntent = 'open' | 'close' | 'reconnect' | 'terminal';
interface PortOperation {
  generation: number;
  intent: PortIntent;
  queue: Promise<unknown>;
  active: boolean;
  started: boolean;
  sawConnected: boolean;
}
interface ReconnectLoop {
  id: number;
  cancelled: boolean;
  cancelDelay?: () => void;
}
const state = {
  portOps: new Map<string, PortOperation>(),
  reconnecting: new Map<string, ReconnectLoop>(),
  manualOpening: new Map<string, { hintPending: boolean; background: boolean }>(),
  exhaustedReconnects: new Set<string>(),
  // Session policy survives reader failure and backoff. An explicit UI open resets it.
  focusOnConnected: new Map<string, boolean>(),
  nextReconnectId: 0,
  hintSubscribers: 0,
  hintUnlisten: null as (() => void) | null,
  hintRegistering: null as Promise<() => void> | null,
  hintRetryTimer: null as ReturnType<typeof setTimeout> | null,
};

export function shouldFocusSerialConnection(portId: string): boolean {
  if (state.manualOpening.get(portId)?.background) return false;
  return state.focusOnConnected.get(portId) ?? true;
}

function nextReconnectDelay(previousMs: number): number {
  return Math.min(previousMs * 2, 5000);
}

/** Port/session settings win over global defaults; explicit callers win over both. */
export function resolveSerialConnectionParams(portId: string): SerialConnectionParams {
  const opStore = useOperationStore.getState();
  const port = useAppStore.getState().ports.find((p) => p.id === portId);
  const ttyState = ttyService.get(portId);
  return {
    baudRate: port?.baudRate ?? opStore.baudRate,
    dataBits: port?.dataBits ?? opStore.dataBits,
    parity: port?.parity ?? opStore.parity,
    stopBits: port?.stopBits ?? opStore.stopBits,
    handshake: port?.handshake ?? opStore.handshake,
    dtr: opStore.dtr,
    rts: opStore.rts,
    ...(ttyState?.lastCols != null && ttyState.lastRows != null
      ? { cols: ttyState.lastCols, rows: ttyState.lastRows }
      : {}),
  };
}

function requirePort(portId: string): SerialPort {
  const port = useAppStore.getState().ports.find((item) => item.id === portId);
  if (!port) throw new SerialConnectionError('port-not-found', portId);
  return port;
}

function availablePort(portId: string, allowUnknownPort = false): SerialPort | undefined {
  const port = useAppStore.getState().ports.find(item => item.id === portId);
  if (!port && !allowUnknownPort) throw new SerialConnectionError('port-not-found', portId);
  if (port?.toolRunning) throw new SerialConnectionError('tool-running', portId);
  return port;
}

function adoptNativePort<T>(portId: string, value: T, options: SerialNativeOptions<T>): SerialPort {
  if (!useAppStore.getState().ports.some(port => port.id === portId) && options.allowUnknownPort && options.readPort) {
    const port = options.readPort(value);
    if (port.id !== portId) throw new Error(`Serial result port mismatch: ${portId}`);
    const app = useAppStore.getState();
    app.setPorts([...app.ports, port]);
  }
  return requirePort(portId);
}

function applyConnectedSideEffects(portId: string, params = resolveSerialConnectionParams(portId)): void {
  const { baudRate, dataBits, parity, stopBits, handshake } = params;
  useAppStore.getState().updatePort(portId, {
    status: 'connected',
    // connected is emitted before invoke resolves; preserve its backend generation.
    baudRate, dataBits, parity, stopBits, handshake,
  });
  useTerminalStore.getState().setTerminalConnectedAt(portId, Date.now());
}

/** Latest intent wins, but every native invocation remains serialized per port.
 * Never dedupe callers by intent: their arguments and authority can differ. */
function enqueuePortOp<T>(portId: string, intent: Exclude<PortIntent, 'terminal'>, op: (generation: number) => Promise<T>): Promise<T> {
  const previous = state.portOps.get(portId);
  const generation = (previous?.generation ?? 0) + 1;
  const prior = previous?.queue ?? Promise.resolve();
  const queued = prior.catch(() => undefined).then(async () => {
    assertCurrentOperation(portId, generation);
    state.portOps.get(portId)!.started = true;
    return op(generation);
  });
  state.portOps.set(portId, { generation, intent, queue: queued, active: true, started: false, sawConnected: false });
  void queued.then(
    () => { const current = state.portOps.get(portId); if (current?.generation === generation && current.queue === queued) current.active = false; },
    () => { const current = state.portOps.get(portId); if (current?.generation === generation && current.queue === queued) current.active = false; },
  );
  return queued;
}

function isCurrentOperation(portId: string, generation: number): boolean {
  return state.portOps.get(portId)?.generation === generation;
}

function assertCurrentOperation(portId: string, generation: number): void {
  if (!isCurrentOperation(portId, generation)) throw new SerialConnectionError('superseded', portId);
}

/** Terminal events invalidate completed/connected opens, not a queued manual close. */
export function acceptSerialStatus(portId: string, status: string): boolean {
  const current = state.portOps.get(portId);
  const port = useAppStore.getState().ports.find((item) => item.id === portId);
  if (status === 'connected' && (current?.intent === 'close' || (current?.intent === 'terminal' && !port?.toolRunning))) return false;
  if (status === 'connected' && current?.intent === 'terminal' && port?.toolRunning) {
    state.portOps.set(portId, { ...current, intent: 'open' });
  }
  if (status === 'connected') state.exhaustedReconnects.delete(portId);
  if (status === 'connected' && current?.intent === 'open' && current.active && current.started) current.sawConnected = true;
  if (status === 'disconnected' || status === 'error') {
    if (current?.intent === 'close' && current.active) return true;
    if (current?.intent === 'open' && current.active && (!current.started || !current.sawConnected)) return true;
    state.portOps.set(portId, {
      generation: (current?.generation ?? 0) + 1,
      intent: 'terminal', queue: current?.queue ?? Promise.resolve(),
      active: false, started: false, sawConnected: false,
    });
  }
  return true;
}

function cancelReconnectLoop(portId: string): void {
  state.exhaustedReconnects.delete(portId);
  const loop = state.reconnecting.get(portId);
  if (!loop) return;
  loop.cancelled = true;
  loop.cancelDelay?.();
}

function ownsReconnectLoop(portId: string, loop: ReconnectLoop): boolean {
  const port = useAppStore.getState().ports.find((item) => item.id === portId);
  return state.reconnecting.get(portId) === loop && !loop.cancelled &&
    !userClosingPortIds.has(portId) && useAppStore.getState().config.autoReconnect && !!port && !port.toolRunning;
}

function waitReconnectDelay(loop: ReconnectLoop, delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => { loop.cancelDelay = undefined; resolve(); };
    const timer = setTimeout(finish, delayMs);
    loop.cancelDelay = () => { clearTimeout(timer); finish(); };
  });
}

/** One finite retry budget per loss episode, including hints before invoke settles. */
async function runReconnectLoop(portId: string): Promise<void> {
  const manualOpen = state.manualOpening.get(portId);
  if (manualOpen) { manualOpen.hintPending = true; return; }
  const existing = state.reconnecting.get(portId);
  if (existing && !existing.cancelled) return;
  const { autoReconnect, maxRetries } = useAppStore.getState().config;
  if (!autoReconnect || userClosingPortIds.has(portId) || state.exhaustedReconnects.has(portId)) return;
  const loop: ReconnectLoop = { id: ++state.nextReconnectId, cancelled: false };
  state.reconnecting.set(portId, loop);
  let delayMs = 500;
  let waitBeforeNext = false;
  let attempts = 0;
  let reason = 'exhausted';
  console.info('[serial-reconnect] started', { portId, loopId: loop.id, maxRetries });
  try {
    while (attempts < maxRetries) {
      if (waitBeforeNext) await waitReconnectDelay(loop, delayMs);
      if (!ownsReconnectLoop(portId, loop)) { reason = 'cancelled'; break; }
      let succeeded = false;
      let opGeneration = -1;
      try {
        await enqueuePortOp(portId, 'reconnect', async (generation) => {
          if (!ownsReconnectLoop(portId, loop)) return;
          opGeneration = generation;
          attempts += 1;
          console.info('[serial-reconnect] attempting', { portId, loopId: loop.id, attempt: attempts, maxRetries });
          await serialService.attemptReconnect(portId);
          if (!ownsReconnectLoop(portId, loop) || !isCurrentOperation(portId, generation)) return;
          applyConnectedSideEffects(portId);
          lostPortIds.delete(portId);
          succeeded = true;
        });
      } catch (err) {
        if (!ownsReconnectLoop(portId, loop)) { reason = 'cancelled'; break; }
        // A terminal event can skip queued work without spending an invoke attempt.
        if (!(err instanceof SerialConnectionError && err.code === 'superseded')) {
          console.warn('[serial-reconnect] attempt failed', {
            portId, loopId: loop.id, attempt: attempts, maxRetries, error: extractErrorMessage(err),
          });
          useToastStore.getState().push({ severity: 'error', messageKey: 'toast.reconnect.failed', message: extractErrorMessage(err), portId });
        }
      }
      if (!ownsReconnectLoop(portId, loop)) { reason = 'cancelled'; break; }
      if (succeeded && isCurrentOperation(portId, opGeneration)) {
        reason = 'succeeded';
        notifySuccess('toast.reconnect.succeeded');
        break;
      }
      if (attempts < maxRetries) {
        waitBeforeNext = true;
        delayMs = nextReconnectDelay(delayMs);
        console.info('[serial-reconnect] retry scheduled', { portId, loopId: loop.id, delayMs });
      }
    }
  } finally {
    if (state.reconnecting.get(portId) === loop) {
      state.reconnecting.delete(portId);
      if (reason === 'exhausted') state.exhaustedReconnects.add(portId);
    }
    console.info('[serial-reconnect] finished', { portId, loopId: loop.id, attempts, maxRetries, reason });
  }
}

function ensureReconnectHintListener(): void {
  if (state.hintSubscribers === 0 || state.hintUnlisten || state.hintRegistering) return;
  const registration = eventService.onSerialReconnectHint((event: SerialReconnectHintEvent) => {
    if (state.hintRegistering !== registration || state.hintSubscribers === 0) return;
    void runReconnectLoop(event.port_name);
  });
  state.hintRegistering = registration;
  registration.then((unlisten) => {
    if (state.hintRegistering !== registration || state.hintSubscribers === 0) { unlisten(); return; }
    state.hintUnlisten = unlisten;
  }).catch((e) => {
    if (state.hintRegistering !== registration) return;
    state.hintRegistering = null;
    console.debug('[serialConnectionRuntime] Failed to register reconnect hint listener:', e);
    state.hintRetryTimer = setTimeout(() => { state.hintRetryTimer = null; ensureReconnectHintListener(); }, 250);
  });
}

/** Root/UI lifecycle leases all share one reconnect listener. */
export function acquireSerialConnectionRuntime(): () => void {
  state.hintSubscribers += 1;
  ensureReconnectHintListener();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.hintSubscribers = Math.max(0, state.hintSubscribers - 1);
    if (state.hintSubscribers > 0) return;
    if (state.hintRetryTimer !== null) { clearTimeout(state.hintRetryTimer); state.hintRetryTimer = null; }
    state.hintUnlisten?.();
    state.hintUnlisten = null;
    state.hintRegistering = null;
  };
}

export async function openSerialConnection<T = void>(portId: string, options: SerialOpenOptions<T> = {}): Promise<SerialOpenResult<T>> {
  options.assertAuthority?.();
  const requestedPort = availablePort(portId, options.allowUnknownPort);
  cancelReconnectLoop(portId);
  const opening = { hintPending: state.manualOpening.get(portId)?.hintPending ?? false, background: options.background ?? false };
  state.manualOpening.set(portId, opening);
  if (!options.background || requestedPort?.status !== 'connected') state.focusOnConnected.set(portId, !options.background);
  userClosingPortIds.delete(portId);
  lostPortIds.delete(portId);
  try {
    return await enqueuePortOp(portId, 'open', async (generation) => {
      options.assertAuthority?.();
      const live = availablePort(portId, options.allowUnknownPort);
      const alreadyOpen = live?.status === 'connected';
      if (alreadyOpen && !options.invokeWhenConnected) return { port: { ...live! }, result: 'already-open', value: undefined };
      if (live?.status === 'connecting') throw new SerialConnectionError('connection-busy', portId);
      const params = { ...resolveSerialConnectionParams(portId), ...options.params };
      if (!alreadyOpen) useAppStore.getState().updatePort(portId, { status: 'connecting', connectionGeneration: undefined });
      let value: T;
      try {
        value = options.perform
          ? await options.perform({ portId, ...params })
          : await serialService.openSerialPort({ portId, ...params }) as T;
      } catch (err) {
        if (isCurrentOperation(portId, generation) && !alreadyOpen) useAppStore.getState().updatePort(portId, { status: 'error' });
        // Never infer success from native error text, or swallow an older caller's error.
        throw err;
      }
      assertCurrentOperation(portId, generation);
      availablePort(portId, options.allowUnknownPort);
      adoptNativePort(portId, value, options);
      const nativeResult = options.readResult?.(value);
      const knownGeneration = requirePort(portId).connectionGeneration;
      if (nativeResult && knownGeneration !== undefined && knownGeneration > nativeResult.connectionGeneration) throw new SerialConnectionError('superseded', portId);
      const result = nativeResult?.result ?? (alreadyOpen ? 'already-open' : 'opened');
      if (!alreadyOpen) applyConnectedSideEffects(portId, result === 'opened' ? params : resolveSerialConnectionParams(portId));
      if (nativeResult) useAppStore.getState().updatePort(portId, {
        connectionGeneration: nativeResult.connectionGeneration,
        ...(nativeResult.baudRate !== undefined ? { baudRate: nativeResult.baudRate } : {}),
      });
      options.assertAuthority?.();
      return { port: { ...requirePort(portId) }, result, value };
    });
  } finally {
    if (state.manualOpening.get(portId) === opening) {
      state.manualOpening.delete(portId);
      if (opening.hintPending && useAppStore.getState().ports.find((port) => port.id === portId)?.status !== 'connected') void runReconnectLoop(portId);
    }
  }
}

export async function closeSerialConnection<T = void>(portId: string, options: SerialCloseOptions<T> = {}): Promise<SerialCloseResult<T>> {
  options.assertAuthority?.();
  availablePort(portId, options.allowUnknownPort);
  cancelReconnectLoop(portId);
  userClosingPortIds.add(portId);
  lostPortIds.delete(portId);
  return enqueuePortOp(portId, 'close', async (generation) => {
    let nativeClosed = false;
    try {
      options.assertAuthority?.();
      const live = availablePort(portId, options.allowUnknownPort);
      const alreadyClosed = live?.status === 'disconnected';
      const value = options.perform ? await options.perform() : await serialService.closeSerialPort(portId) as T;
      nativeClosed = true;
      assertCurrentOperation(portId, generation);
      availablePort(portId, options.allowUnknownPort);
      adoptNativePort(portId, value, options);
      useAppStore.getState().updatePort(portId, { status: 'disconnected', connectionGeneration: undefined });
      options.assertAuthority?.();
      return { port: { ...requirePort(portId) }, result: options.readResult?.(value) ?? (alreadyClosed ? 'already-closed' : 'closed'), value };
    } catch (err) {
      // Failed/stale/unauthorized work never owns the live reader. Resume RX,
      // but keep an actually completed native close's manual-disconnect marker.
      const current = state.portOps.get(portId);
      // A close that was superseded by a newer open must not leave a stale
      // user-closing gate behind, even when native close already completed.
      if (!current || current.intent !== 'close' || current.generation !== generation || !nativeClosed) {
        userClosingPortIds.delete(portId);
        if (current?.generation === generation && useAppStore.getState().ports.find(port => port.id === portId)?.status === 'connected') current.intent = 'open';
      }
      throw err;
    }
  });
}

export async function toggleSerialConnection(portId: string): Promise<SerialOpenResult | SerialCloseResult> {
  const port = availablePort(portId)!;
  if (port.status === 'connecting') throw new SerialConnectionError('connection-busy', portId);
  return port.status === 'connected' ? closeSerialConnection(portId) : openSerialConnection(portId);
}
