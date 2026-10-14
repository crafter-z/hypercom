// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eventService, popoutEventService, serialService, storageService } from '../../services/tauri';
import { usePopoutSync, type PopoutSync } from './usePopoutSync';
import type { SendCommandSet } from '../../types';

vi.mock('../../services/tauri', () => ({
  eventService: { onSerialStatus: vi.fn() },
  popoutEventService: {
    onCommandSetsChanged: vi.fn(), onActiveTabChanged: vi.fn(), onPortStatusesSync: vi.fn(),
    emitRequestSync: vi.fn(async () => {}), emitOpenConfig: vi.fn(async () => {}),
  },
  serialService: { listAvailablePorts: vi.fn(async () => []) },
  storageService: { loadCommandSets: vi.fn(async () => []) },
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const live: SendCommandSet[] = [{ id: 'live', name: 'live', commands: [], isLoop: false, loopDelay: 0, repeatCount: 0 }];
let root: Root;
let sync!: PopoutSync;
function Probe() { sync = usePopoutSync(); return null; }
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(popoutEventService.onCommandSetsChanged).mockResolvedValue(() => {});
  vi.mocked(popoutEventService.onActiveTabChanged).mockResolvedValue(() => {});
  vi.mocked(popoutEventService.onPortStatusesSync).mockResolvedValue(() => {});
  vi.mocked(eventService.onSerialStatus).mockResolvedValue(() => {});
  vi.mocked(serialService.listAvailablePorts).mockResolvedValue([]);
  vi.mocked(storageService.loadCommandSets).mockResolvedValue([]);
  root = createRoot(document.createElement('div'));
});
afterEach(async () => { await act(async () => { root.unmount(); }); });

describe('popout listener group ownership', () => {
  it('retires fulfilled and late registrations on a partial failure, rejecting stale callbacks', async () => {
    const late = deferred<() => void>();
    const failed = deferred<() => void>();
    const unSets = vi.fn();
    const unStatus = vi.fn();
    let receive!: (sets: SendCommandSet[]) => void;
    vi.mocked(popoutEventService.onCommandSetsChanged).mockImplementationOnce(callback => { receive = callback; return Promise.resolve(unSets); });
    vi.mocked(popoutEventService.onActiveTabChanged).mockImplementationOnce(() => failed.promise);
    vi.mocked(eventService.onSerialStatus).mockImplementationOnce(() => late.promise);
    await act(async () => { root.render(createElement(Probe)); });
    await act(async () => { failed.reject(new Error('registration failed')); });
    expect(unSets).toHaveBeenCalledTimes(1);
    await act(async () => { receive(live); late.resolve(unStatus); });
    expect(sync.sets).toEqual([]);
    expect(unStatus).toHaveBeenCalledTimes(1);
    expect(popoutEventService.emitRequestSync).not.toHaveBeenCalled();
  });

  it('unlistens a registration that finishes after unmount', async () => {
    const late = deferred<() => void>();
    const unlisten = vi.fn();
    vi.mocked(popoutEventService.onCommandSetsChanged).mockImplementationOnce(() => late.promise);
    await act(async () => { root.render(createElement(Probe)); });
    await act(async () => { root.unmount(); });
    root = createRoot(document.createElement('div'));
    await act(async () => { late.resolve(unlisten); });
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(popoutEventService.emitRequestSync).not.toHaveBeenCalled();
  });

  it('requests status sync only after status and command listeners are ready and retains newer live sets', async () => {
    const statusReady = deferred<() => void>();
    const baseline = deferred<SendCommandSet[]>();
    let receive!: (sets: SendCommandSet[]) => void;
    vi.mocked(storageService.loadCommandSets).mockImplementationOnce(() => baseline.promise);
    vi.mocked(eventService.onSerialStatus).mockImplementationOnce(() => statusReady.promise);
    vi.mocked(popoutEventService.onCommandSetsChanged).mockImplementationOnce(callback => { receive = callback; return Promise.resolve(() => {}); });
    await act(async () => { root.render(createElement(Probe)); });
    expect(popoutEventService.emitRequestSync).not.toHaveBeenCalled();
    await act(async () => { statusReady.resolve(() => {}); receive(live); });
    expect(popoutEventService.emitRequestSync).toHaveBeenCalledTimes(1);
    await act(async () => { baseline.resolve([]); });
    expect(sync.sets).toEqual(live);
  });
});
