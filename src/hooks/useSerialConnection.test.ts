// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eventService, serialService } from '../services/tauri';
import { useAppStore } from '../stores/useAppStore';
import { userClosingPortIds, lostPortIds } from './disconnectTracking';
import { useSerialConnection, type SerialConnectionActions } from './useSerialConnection';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../services/tauri', () => ({
  eventService: { onSerialReconnectHint: vi.fn() },
  serialService: { attemptReconnect: vi.fn(), closeSerialPort: vi.fn() },
  logService: { startLogging: vi.fn(async () => {}), stopLogging: vi.fn(async () => {}) },
  gitBashSimService: {},
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

async function mountConnection() {
  let api!: SerialConnectionActions;
  const root = createRoot(document.createElement('div'));
  function Probe() { api = useSerialConnection(); return null; }
  await act(async () => { root.render(createElement(Probe)); });
  return { api, unmount: async () => { await act(async () => { root.unmount(); }); } };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  userClosingPortIds.clear();
  lostPortIds.clear();
  useAppStore.setState({
    ports: [{ id: 'COM1', name: 'COM1', status: 'disconnected', type: 'real', isHidden: false }],
    config: { ...useAppStore.getState().config, autoReconnect: true, maxRetries: 2, autoSaveLog: false },
  });
  vi.mocked(serialService.closeSerialPort).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  userClosingPortIds.clear();
  lostPortIds.clear();
});

describe('serial reconnect intent and listener ownership', () => {
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
