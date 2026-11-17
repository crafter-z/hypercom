import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serialService } from '../services/tauri';
import { useAppStore } from '../stores/useAppStore';
import { useOperationStore } from '../stores/useOperationStore';
import { resetStoresForTests } from '../stores/resetStores';
import { userClosingPortIds, lostPortIds } from '../hooks/disconnectTracking';
import {
  acceptSerialStatus,
  closeSerialConnection,
  openSerialConnection,
  shouldFocusSerialConnection,
  toggleSerialConnection,
} from './serialConnectionRuntime';

vi.mock('../services/tauri', () => ({
  serialService: { openSerialPort: vi.fn(), closeSerialPort: vi.fn(), attemptReconnect: vi.fn() },
  eventService: {}, gitBashSimService: {},
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => { resolve = complete; });
  return { promise, resolve };
}

let sequence = 0;
let id: string;
beforeEach(() => {
  vi.resetAllMocks();
  resetStoresForTests();
  userClosingPortIds.clear();
  lostPortIds.clear();
  id = `RUNTIME:${++sequence}`;
  useAppStore.setState({ ports: [{ id, name: id, status: 'disconnected', type: 'real', isHidden: false }] });
  vi.mocked(serialService.openSerialPort).mockResolvedValue(undefined);
  vi.mocked(serialService.closeSerialPort).mockResolvedValue(undefined);
});
afterEach(() => { userClosingPortIds.clear(); lostPortIds.clear(); });

describe('strict shared serial connection runtime', () => {
  it('rejects missing ports, tool conflicts and unowned connecting state without invoking', async () => {
    await expect(openSerialConnection('missing')).rejects.toMatchObject({ code: 'port-not-found' });
    await expect(closeSerialConnection('missing')).rejects.toMatchObject({ code: 'port-not-found' });
    await expect(toggleSerialConnection('missing')).rejects.toMatchObject({ code: 'port-not-found' });
    useAppStore.getState().updatePort(id, { toolRunning: true });
    await expect(openSerialConnection(id)).rejects.toMatchObject({ code: 'tool-running' });
    await expect(closeSerialConnection(id)).rejects.toMatchObject({ code: 'tool-running' });
    useAppStore.getState().updatePort(id, { toolRunning: false, status: 'connecting' });
    await expect(openSerialConnection(id)).rejects.toMatchObject({ code: 'connection-busy' });
    await expect(toggleSerialConnection(id)).rejects.toMatchObject({ code: 'connection-busy' });
    expect(serialService.openSerialPort).not.toHaveBeenCalled();
    expect(serialService.closeSerialPort).not.toHaveBeenCalled();
  });

  it('returns explicit idempotent outcomes and preserves connected generation', async () => {
    useAppStore.getState().updatePort(id, { status: 'connected', connectionGeneration: 32 });
    await expect(openSerialConnection(id)).resolves.toMatchObject({ result: 'already-open', port: { connectionGeneration: 32 } });
    expect(serialService.openSerialPort).not.toHaveBeenCalled();
    await expect(closeSerialConnection(id)).resolves.toMatchObject({ result: 'closed', port: { status: 'disconnected' } });
    await expect(closeSerialConnection(id)).resolves.toMatchObject({ result: 'already-closed' });
    // Even an apparently closed port may have a stale native handle to retire.
    expect(serialService.closeSerialPort).toHaveBeenCalledTimes(2);
  });

  it('propagates the exact native failure, including an already-open error, rather than fabricating success', async () => {
    const failure = new Error(`Port ${id} is already open`);
    vi.mocked(serialService.openSerialPort).mockRejectedValue(failure);
    await expect(openSerialConnection(id)).rejects.toBe(failure);
    expect(useAppStore.getState().ports[0].status).toBe('error');
  });

  it('takes an immutable parameter snapshot and preserves a connected event generation', async () => {
    const invoke = deferred();
    useAppStore.getState().updatePort(id, { baudRate: 38400 });
    useOperationStore.getState().setOpState({ baudRate: 9600, dtr: true });
    vi.mocked(serialService.openSerialPort).mockReturnValue(invoke.promise);
    const opening = openSerialConnection(id);
    await Promise.resolve();
    await Promise.resolve();
    expect(serialService.openSerialPort).toHaveBeenCalledWith(expect.objectContaining({ baudRate: 38400, dtr: true }));
    acceptSerialStatus(id, 'connected');
    useAppStore.getState().updatePort(id, { status: 'connected', connectionGeneration: 71 });
    useOperationStore.getState().setOpState({ baudRate: 230400 });
    invoke.resolve();
    await expect(opening).resolves.toMatchObject({ result: 'opened', port: { baudRate: 38400, connectionGeneration: 71 } });
  });

  it('rejects superseded queued work rather than silently resolving and still executes the latest close', async () => {
    const opening = openSerialConnection(id);
    const rejected = expect(opening).rejects.toMatchObject({ code: 'superseded' });
    const closing = closeSerialConnection(id);
    await rejected;
    await expect(closing).resolves.toMatchObject({ result: 'already-closed' });
    expect(serialService.openSerialPort).not.toHaveBeenCalled();
    expect(serialService.closeSerialPort).toHaveBeenCalledTimes(1);
  });

  it('serializes UI and custom plugin invocations on one port but not across ports', async () => {
    const nativeOpen = deferred();
    vi.mocked(serialService.openSerialPort).mockReturnValue(nativeOpen.promise);
    const uiOpen = openSerialConnection(id);
    const rejected = expect(uiOpen).rejects.toMatchObject({ code: 'superseded' });
    await Promise.resolve();
    await Promise.resolve();
    const pluginClose = vi.fn(async () => 'closed by plugin');
    const closing = closeSerialConnection(id, { perform: pluginClose });
    useAppStore.setState({ ports: [...useAppStore.getState().ports, { id: 'OTHER', name: 'OTHER', status: 'disconnected', type: 'real', isHidden: false }] });
    const otherInvoke = vi.fn(async () => {});
    await expect(openSerialConnection('OTHER', { perform: otherInvoke })).resolves.toMatchObject({ result: 'opened' });
    expect(otherInvoke).toHaveBeenCalledTimes(1);
    expect(pluginClose).not.toHaveBeenCalled();
    nativeOpen.resolve();
    await rejected;
    await expect(closing).resolves.toMatchObject({ value: 'closed by plugin' });
    expect(pluginClose).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().ports[0].status).toBe('disconnected');
  });

  it('does not deduplicate same-intent callers with different params or authority', async () => {
    const first = vi.fn(async () => 1);
    const second = vi.fn(async () => 2);
    const old = openSerialConnection(id, { perform: first, params: { baudRate: 9600 } });
    const rejected = expect(old).rejects.toMatchObject({ code: 'superseded' });
    const latest = openSerialConnection(id, { perform: second, params: { baudRate: 57600 } });
    await rejected;
    await expect(latest).resolves.toMatchObject({ value: 2, port: { baudRate: 57600 } });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(expect.objectContaining({ baudRate: 57600 }));
  });

  it('rechecks tool ownership when queued work enters the lane', async () => {
    const operation = openSerialConnection(id);
    useAppStore.getState().updatePort(id, { toolRunning: true });
    await expect(operation).rejects.toMatchObject({ code: 'tool-running' });
    expect(serialService.openSerialPort).not.toHaveBeenCalled();
  });

  it('keeps reader state and releases the closing gate when native close fails', async () => {
    const failure = new Error('stale generation');
    useAppStore.getState().updatePort(id, { status: 'connected', connectionGeneration: 10 });
    vi.mocked(serialService.closeSerialPort).mockRejectedValue(failure);
    await expect(closeSerialConnection(id)).rejects.toBe(failure);
    expect(useAppStore.getState().ports[0]).toMatchObject({ status: 'connected', connectionGeneration: 10 });
    expect(userClosingPortIds.has(id)).toBe(false);
    expect(acceptSerialStatus(id, 'connected')).toBe(true);
  });

  it('removes a stale closing gate when a newer open supersedes a native close', async () => {
    useAppStore.getState().updatePort(id, { status: 'connected', connectionGeneration: 10 });
    let release!: () => void;
    const nativeClose = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(serialService.closeSerialPort).mockReturnValue(nativeClose);
    const closing = closeSerialConnection(id);
    await Promise.resolve();
    useAppStore.getState().updatePort(id, { status: 'disconnected', connectionGeneration: undefined });
    const opening = openSerialConnection(id);
    release();
    await expect(closing).rejects.toMatchObject({ code: 'superseded' });
    await expect(opening).resolves.toMatchObject({ result: 'opened' });
    expect(userClosingPortIds.has(id)).toBe(false);
  });

  it('releases the closing gate if permission is revoked while queued', async () => {
    let authorized = true;
    const assertAuthority = () => { if (!authorized) throw new Error('revoked'); };
    const closing = closeSerialConnection(id, { assertAuthority });
    authorized = false;
    await expect(closing).rejects.toThrow('revoked');
    expect(serialService.closeSerialPort).not.toHaveBeenCalled();
    expect(userClosingPortIds.has(id)).toBe(false);
  });

  it('retains background focus policy through terminal events until a UI open', async () => {
    await openSerialConnection(id, { background: true });
    expect(shouldFocusSerialConnection(id)).toBe(false);
    acceptSerialStatus(id, 'disconnected');
    useAppStore.getState().updatePort(id, { status: 'disconnected' });
    expect(shouldFocusSerialConnection(id)).toBe(false);
    await openSerialConnection(id);
    expect(shouldFocusSerialConnection(id)).toBe(true);
  });
});
