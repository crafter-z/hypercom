// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eventService, serialService } from '../services/tauri';
import { useAppStore } from '../stores/useAppStore';
import { resetStoresForTests } from '../stores/resetStores';
import { userClosingPortIds, lostPortIds } from './disconnectTracking';
import { useSerialConnection, type SerialConnectionActions } from './useSerialConnection';
import { useSerialReceive } from './useSerialReceive';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../services/tauri', () => ({
  eventService: { onSerialReconnectHint: vi.fn(), onSerialData: vi.fn(), onSerialStatus: vi.fn() },
  serialService: { attemptReconnect: vi.fn(), closeSerialPort: vi.fn(), openSerialPort: vi.fn() },
  logService: { startLogging: vi.fn(async () => {}), stopLogging: vi.fn(async () => {}) },
  gitBashSimService: {},
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

async function mountConnection(receiveEvents = false) {
  let api!: SerialConnectionActions;
  const root = createRoot(document.createElement('div'));
  function Probe() { api = useSerialConnection(); return null; }
  function ReceiveProbe() { useSerialReceive(); return createElement(Probe); }
  await act(async () => { root.render(createElement(receiveEvents ? ReceiveProbe : Probe)); });
  return { api, unmount: async () => { await act(async () => { root.unmount(); }); } };
}

beforeEach(async () => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  resetStoresForTests();
  vi.mocked(serialService.closeSerialPort).mockResolvedValue(undefined);
  vi.mocked(eventService.onSerialReconnectHint).mockResolvedValue(vi.fn());
  // Begin each test with a new manual intent, including clearing exhausted
  // episode ownership, without adding a production-only runtime reset API.
  const reset = await mountConnection();
  await act(async () => { await reset.api.closePort('COM1'); });
  await reset.unmount();
  vi.clearAllMocks();
  userClosingPortIds.clear();
  lostPortIds.clear();
  useAppStore.setState({
    ports: [{ id: 'COM1', name: 'COM1', status: 'disconnected', type: 'real', isHidden: false }],
    config: { ...useAppStore.getState().config, autoReconnect: true, maxRetries: 2, autoSaveLog: false },
  });
  vi.mocked(serialService.closeSerialPort).mockResolvedValue(undefined);
  vi.mocked(eventService.onSerialData).mockResolvedValue(vi.fn());
  vi.mocked(eventService.onSerialStatus).mockResolvedValue(vi.fn());
});

afterEach(() => {
  vi.useRealTimers();
  userClosingPortIds.clear();
  lostPortIds.clear();
});

describe('serial reconnect intent and listener ownership', () => {
  it('uses all 10 attempts for a missing Windows device, then stops retrying', async () => {
    useAppStore.setState({
      config: { ...useAppStore.getState().config, maxRetries: 10 },
    });
    vi.mocked(eventService.onSerialReconnectHint).mockResolvedValue(vi.fn());
    vi.mocked(serialService.attemptReconnect).mockRejectedValue('系统找不到指定的文件。');
    const mounted = await mountConnection();
    const onHint = vi.mocked(eventService.onSerialReconnectHint).mock.calls[0][0];
    await act(async () => { onHint({ port_name: 'COM1' }); });
    expect(serialService.attemptReconnect).toHaveBeenCalledTimes(1);

    // Attempts happen at 0, 1, 3, 7, 12, 17, 22, 27, 32 and 37 seconds.
    const delays = [1000, 2000, 4000, 5000, 5000, 5000, 5000, 5000, 5000];
    for (const [index, delay] of delays.entries()) {
      await act(async () => { await vi.advanceTimersByTimeAsync(delay - 1); });
      expect(serialService.attemptReconnect).toHaveBeenCalledTimes(index + 1);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(serialService.attemptReconnect).toHaveBeenCalledTimes(index + 2);
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(serialService.attemptReconnect).toHaveBeenCalledTimes(10);
    expect(useAppStore.getState().ports[0].status).toBe('disconnected');
    await mounted.unmount();
  });

  it('recovers when the device becomes available before the retry budget is exhausted', async () => {
    useAppStore.setState({
      config: { ...useAppStore.getState().config, maxRetries: 10 },
    });
    lostPortIds.add('COM1');
    vi.mocked(eventService.onSerialReconnectHint).mockResolvedValue(vi.fn());
    vi.mocked(serialService.attemptReconnect)
      .mockRejectedValueOnce('系统找不到指定的文件。')
      .mockRejectedValueOnce('Port COM1 is not available')
      .mockResolvedValueOnce(undefined);
    const mounted = await mountConnection();
    const onHint = vi.mocked(eventService.onSerialReconnectHint).mock.calls[0][0];
    await act(async () => { onHint({ port_name: 'COM1' }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(serialService.attemptReconnect).toHaveBeenCalledTimes(3);
    expect(useAppStore.getState().ports[0].status).toBe('connected');
    expect(lostPortIds.has('COM1')).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(serialService.attemptReconnect).toHaveBeenCalledTimes(3);
    await mounted.unmount();
  });

  it('does not lose a disconnect hint delivered before the reconnect invoke completes', async () => {
    const opening = deferred<void>();
    vi.mocked(eventService.onSerialReconnectHint).mockResolvedValue(vi.fn());
    vi.mocked(serialService.attemptReconnect)
      .mockReturnValueOnce(opening.promise)
      .mockResolvedValueOnce(undefined);
    const mounted = await mountConnection(true);
    const onHint = vi.mocked(eventService.onSerialReconnectHint).mock.calls[0][0];
    const onStatus = vi.mocked(eventService.onSerialStatus).mock.calls[0][0];
    await act(async () => { onHint({ port_name: 'COM1' }); });
    await act(async () => {
      // The real opener emits connected and releases the reader before invoke
      // returns. An unstable device can fail again in that exact window.
      onStatus({ port_id: 'COM1', status: 'connected', generation: 1 });
      onStatus({ port_id: 'COM1', status: 'error', generation: 1 });
      onStatus({ port_id: 'COM1', status: 'disconnected', generation: 1 });
      onHint({ port_name: 'COM1' });
      opening.resolve(undefined);
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(serialService.attemptReconnect).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().ports[0].status).toBe('connected');
    await mounted.unmount();
  });

  it('ignores the last failed session hint after exhaustion and allows a new manual session', async () => {
    useAppStore.setState({ config: { ...useAppStore.getState().config, maxRetries: 1 } });
    const opening = deferred<void>();
    vi.mocked(eventService.onSerialReconnectHint).mockResolvedValue(vi.fn());
    vi.mocked(serialService.attemptReconnect)
      .mockReturnValueOnce(opening.promise)
      .mockResolvedValueOnce(undefined);
    vi.mocked(serialService.openSerialPort).mockResolvedValue(undefined);
    const mounted = await mountConnection(true);
    const onHint = vi.mocked(eventService.onSerialReconnectHint).mock.calls[0][0];
    const onStatus = vi.mocked(eventService.onSerialStatus).mock.calls[0][0];
    await act(async () => { onHint({ port_name: 'COM1' }); });
    await act(async () => {
      onStatus({ port_id: 'COM1', status: 'connected', generation: 1 });
      onStatus({ port_id: 'COM1', status: 'error', generation: 1 });
      onStatus({ port_id: 'COM1', status: 'disconnected', generation: 1 });
      opening.resolve(undefined);
    });
    // The reader's hint is delivered only after the exhausted loop's finally.
    await act(async () => { onHint({ port_name: 'COM1' }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(serialService.attemptReconnect).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().ports[0].status).toBe('disconnected');

    await act(async () => { await mounted.api.openPort('COM1'); });
    await act(async () => {
      onStatus({ port_id: 'COM1', status: 'connected', generation: 2 });
      onStatus({ port_id: 'COM1', status: 'disconnected', generation: 2 });
      onHint({ port_name: 'COM1' });
    });
    expect(serialService.attemptReconnect).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().ports[0].status).toBe('connected');
    await mounted.unmount();
  });

  it('does not charge a skipped queued operation against the invoke retry budget', async () => {
    useAppStore.setState({ config: { ...useAppStore.getState().config, maxRetries: 10 } });
    vi.mocked(eventService.onSerialReconnectHint).mockResolvedValue(vi.fn());
    vi.mocked(serialService.attemptReconnect).mockRejectedValue('offline');
    const mounted = await mountConnection(true);
    const onHint = vi.mocked(eventService.onSerialReconnectHint).mock.calls[0][0];
    const onStatus = vi.mocked(eventService.onSerialStatus).mock.calls[0][0];
    await act(async () => {
      onHint({ port_name: 'COM1' });
      // A delayed old terminal status invalidates the queued attempt before it
      // can invoke the backend. No actual retry has been spent yet.
      onStatus({ port_id: 'COM1', status: 'disconnected', generation: 1 });
    });
    expect(serialService.attemptReconnect).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(serialService.attemptReconnect).toHaveBeenCalledTimes(10);
    await mounted.unmount();
  });

  it('does not reset the retry budget when every reopened session immediately disconnects', async () => {
    useAppStore.setState({ config: { ...useAppStore.getState().config, maxRetries: 10 } });
    vi.mocked(eventService.onSerialReconnectHint).mockResolvedValue(vi.fn());
    const mounted = await mountConnection(true);
    const onHint = vi.mocked(eventService.onSerialReconnectHint).mock.calls[0][0];
    const onStatus = vi.mocked(eventService.onSerialStatus).mock.calls[0][0];
    vi.mocked(serialService.attemptReconnect).mockImplementation(async () => {
      const generation = vi.mocked(serialService.attemptReconnect).mock.calls.length;
      onStatus({ port_id: 'COM1', status: 'connected', generation });
      onStatus({ port_id: 'COM1', status: 'error', generation });
      onStatus({ port_id: 'COM1', status: 'disconnected', generation });
      onHint({ port_name: 'COM1' });
      onHint({ port_name: 'COM1' });
    });
    await act(async () => { onHint({ port_name: 'COM1' }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(serialService.attemptReconnect).toHaveBeenCalledTimes(10);
    expect(useAppStore.getState().ports[0].status).toBe('disconnected');
    await mounted.unmount();
  });

  it('does not let an old hint preempt a manual open queued behind an in-flight reconnect', async () => {
    const reconnect = deferred<void>();
    vi.mocked(eventService.onSerialReconnectHint).mockResolvedValue(vi.fn());
    vi.mocked(serialService.attemptReconnect).mockReturnValue(reconnect.promise);
    vi.mocked(serialService.openSerialPort).mockResolvedValue(undefined);
    const mounted = await mountConnection(true);
    const onHint = vi.mocked(eventService.onSerialReconnectHint).mock.calls[0][0];
    const onStatus = vi.mocked(eventService.onSerialStatus).mock.calls[0][0];
    await act(async () => { onHint({ port_name: 'COM1' }); });
    let manualOpen!: Promise<void>;
    await act(async () => { manualOpen = mounted.api.openPort('COM1'); });
    await act(async () => {
      onStatus({ port_id: 'COM1', status: 'connected', generation: 1 });
      onStatus({ port_id: 'COM1', status: 'error', generation: 1 });
      onStatus({ port_id: 'COM1', status: 'disconnected', generation: 1 });
      onHint({ port_name: 'COM1' });
      reconnect.resolve(undefined);
      await manualOpen;
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(serialService.openSerialPort).toHaveBeenCalledTimes(1);
    expect(serialService.attemptReconnect).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().ports[0].status).toBe('connected');
    await mounted.unmount();
  });

  it('defers recovery of an immediately lost manual connection until its invoke settles', async () => {
    const opening = deferred<void>();
    vi.mocked(eventService.onSerialReconnectHint).mockResolvedValue(vi.fn());
    vi.mocked(serialService.openSerialPort).mockReturnValue(opening.promise);
    vi.mocked(serialService.attemptReconnect).mockResolvedValue(undefined);
    const mounted = await mountConnection(true);
    const onHint = vi.mocked(eventService.onSerialReconnectHint).mock.calls[0][0];
    const onStatus = vi.mocked(eventService.onSerialStatus).mock.calls[0][0];
    let manualOpen!: Promise<void>;
    await act(async () => { manualOpen = mounted.api.openPort('COM1'); });
    await act(async () => {
      onStatus({ port_id: 'COM1', status: 'connected', generation: 2 });
      onStatus({ port_id: 'COM1', status: 'error', generation: 2 });
      onStatus({ port_id: 'COM1', status: 'disconnected', generation: 2 });
      onHint({ port_name: 'COM1' });
    });
    expect(serialService.attemptReconnect).not.toHaveBeenCalled();
    await act(async () => { opening.resolve(undefined); await manualOpen; });
    expect(serialService.attemptReconnect).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().ports[0].status).toBe('connected');
    await mounted.unmount();
  });

  it('does not replace a pending manual open when the old retry timer expires', async () => {
    const opening = deferred<void>();
    vi.mocked(eventService.onSerialReconnectHint).mockResolvedValue(vi.fn());
    vi.mocked(serialService.attemptReconnect).mockRejectedValue('offline');
    vi.mocked(serialService.openSerialPort).mockReturnValue(opening.promise);
    const mounted = await mountConnection();
    const onHint = vi.mocked(eventService.onSerialReconnectHint).mock.calls[0][0];
    await act(async () => { onHint({ port_name: 'COM1' }); });
    let manualOpen!: Promise<void>;
    await act(async () => { manualOpen = mounted.api.openPort('COM1'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(serialService.attemptReconnect).toHaveBeenCalledTimes(1);
    await act(async () => { opening.resolve(undefined); await manualOpen; });
    expect(useAppStore.getState().ports[0].status).toBe('connected');
    await mounted.unmount();
  });

  it('does not replace a successful manual open during retry backoff', async () => {
    vi.mocked(eventService.onSerialReconnectHint).mockResolvedValue(vi.fn());
    vi.mocked(serialService.attemptReconnect).mockRejectedValue('offline');
    vi.mocked(serialService.openSerialPort).mockResolvedValue(undefined);
    const mounted = await mountConnection();
    const onHint = vi.mocked(eventService.onSerialReconnectHint).mock.calls[0][0];
    await act(async () => { onHint({ port_name: 'COM1' }); });
    await act(async () => { await mounted.api.openPort('COM1'); });
    expect(useAppStore.getState().ports[0].status).toBe('connected');
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(serialService.attemptReconnect).toHaveBeenCalledTimes(1);
    await mounted.unmount();
  });

  it('executes a manual close even when old terminal events arrive before reconnect settles', async () => {
    const reconnect = deferred<void>();
    vi.mocked(eventService.onSerialReconnectHint).mockResolvedValue(vi.fn());
    vi.mocked(serialService.attemptReconnect).mockReturnValue(reconnect.promise);
    const mounted = await mountConnection(true);
    const onHint = vi.mocked(eventService.onSerialReconnectHint).mock.calls[0][0];
    const onStatus = vi.mocked(eventService.onSerialStatus).mock.calls[0][0];
    await act(async () => { onHint({ port_name: 'COM1' }); });
    let closing!: Promise<void>;
    await act(async () => { closing = mounted.api.closePort('COM1'); });
    await act(async () => {
      onStatus({ port_id: 'COM1', status: 'error', generation: 3 });
      onStatus({ port_id: 'COM1', status: 'disconnected', generation: 3 });
      onHint({ port_name: 'COM1' });
      reconnect.resolve(undefined);
      await closing;
    });
    expect(serialService.closeSerialPort).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().ports[0].status).toBe('disconnected');
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(serialService.attemptReconnect).toHaveBeenCalledTimes(1);
    await mounted.unmount();
  });

  it('does not reconnect after the user closes the port during retry backoff', async () => {
    const unlisten = vi.fn();
    vi.mocked(eventService.onSerialReconnectHint).mockResolvedValue(unlisten);
    vi.mocked(serialService.attemptReconnect).mockRejectedValue(new Error('offline'));
    const mounted = await mountConnection();
    const onHint = vi.mocked(eventService.onSerialReconnectHint).mock.calls[0][0];
    await act(async () => { onHint({ port_name: 'COM1' }); });
    expect(serialService.attemptReconnect).toHaveBeenCalledTimes(1);
    await act(async () => { await mounted.api.closePort('COM1'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(serialService.attemptReconnect).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().ports[0].status).toBe('disconnected');
    await mounted.unmount();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('releases an old late registration without overwriting the remounted listener', async () => {
    const first = deferred<() => void>();
    const unlistenFirst = vi.fn();
    const unlistenSecond = vi.fn();
    vi.mocked(eventService.onSerialReconnectHint)
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(unlistenSecond);
    const old = await mountConnection();
    await old.unmount();
    const current = await mountConnection();
    await act(async () => { first.resolve(unlistenFirst); });
    expect(unlistenFirst).toHaveBeenCalledTimes(1);
    expect(unlistenSecond).not.toHaveBeenCalled();
    await current.unmount();
    expect(unlistenFirst).toHaveBeenCalledTimes(1);
    expect(unlistenSecond).toHaveBeenCalledTimes(1);
  });
});
