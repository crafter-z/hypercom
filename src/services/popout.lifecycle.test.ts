import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Event } from '@tauri-apps/api/event';
import { popoutEventService, popoutService } from './popout';
import { useAppStore } from '../stores/useAppStore';
import { resetStoresForTests } from '../stores/resetStores';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(), listen: vi.fn() }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const windows = new Set<string>();
beforeEach(() => {
  vi.clearAllMocks();
  windows.clear();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const { targetId } = args as { targetId: string };
    if (command === 'open_popout') windows.add(targetId);
    if (command === 'close_popout') windows.delete(targetId);
    return undefined;
  });
});
afterEach(async () => {
  await popoutService.closePopout('terminal', 'COM1');
  await popoutService.closePopout('terminal', 'COM2');
  await popoutService.closePopout('help');
});

describe('native popout desired-state lane', () => {
  it('compensates an open overtaken by reattach without closing before creation finishes', async () => {
    const creating = deferred<void>();
    vi.mocked(invoke).mockImplementationOnce(async () => { await creating.promise; windows.add('COM1'); });
    const opened = popoutService.openPopout('terminal', 'COM1');
    const closed = popoutService.closePopout('terminal', 'COM1');
    expect(invoke).toHaveBeenCalledTimes(1);
    creating.resolve();
    await Promise.all([opened, closed]);
    expect(windows.has('COM1')).toBe(false);
    expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual(['open_popout', 'close_popout']);
  });

  it('compensates deletion of the tab that owned a pending creation', async () => {
    const creating = deferred<void>();
    resetStoresForTests();
    const tabId = useAppStore.getState().openTab('COM1');
    useAppStore.getState().setTabPoppedOut(tabId, true);
    vi.mocked(invoke).mockImplementationOnce(async () => { await creating.promise; windows.add('COM1'); });
    const opened = popoutService.openPopout('terminal', 'COM1', () => {
      const tab = useAppStore.getState().tabs.find(item => item.id === tabId);
      return tab?.kind === 'serial' && tab.poppedOut === true;
    });
    useAppStore.getState().closeTab(tabId);
    creating.resolve();
    await opened;
    expect(windows.has('COM1')).toBe(false);
  });

  it('keeps the latest same-port open after a slow close and ignores its programmatic close signal', async () => {
    await popoutService.openPopout('terminal', 'COM1');
    const closing = deferred<void>();
    vi.mocked(invoke).mockImplementationOnce(async () => { await closing.promise; windows.delete('COM1'); });
    const closed = popoutService.closePopout('terminal', 'COM1');
    const opened = popoutService.openPopout('terminal', 'COM1');
    expect(popoutService.terminalClosed('COM1')).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(2);
    closing.resolve();
    await Promise.all([closed, opened]);
    expect(windows.has('COM1')).toBe(true);
    expect(popoutService.terminalClosed('COM1')).toBe(true);
  });

  it('does not reject a newer open because an obsolete open failed', async () => {
    const creating = deferred<void>();
    vi.mocked(invoke).mockImplementationOnce(() => creating.promise);
    const old = popoutService.openPopout('terminal', 'COM1');
    void popoutService.closePopout('terminal', 'COM1');
    const replacement = popoutService.openPopout('terminal', 'COM1');
    creating.reject(new Error('old creation failed'));
    await Promise.all([old, replacement]);
    expect(windows.has('COM1')).toBe(true);
  });

  it('does not stall another port while one native open is pending', async () => {
    const creating = deferred<void>();
    vi.mocked(invoke).mockImplementationOnce(async () => { await creating.promise; windows.add('COM1'); });
    const old = popoutService.openPopout('terminal', 'COM1');
    await popoutService.openPopout('terminal', 'COM2');
    expect(windows.has('COM2')).toBe(true);
    creating.resolve();
    await old;
  });

  it('keeps help targets on one singleton lane', async () => {
    const creating = deferred<void>();
    vi.mocked(invoke).mockImplementationOnce(async () => { await creating.promise; windows.add('help'); });
    const first = popoutService.openHelp('quick-start', 'connect');
    const second = popoutService.openHelp('serial', 'groups');
    expect(invoke).toHaveBeenCalledTimes(1);
    creating.resolve();
    await Promise.all([first, second]);
    expect(vi.mocked(invoke).mock.calls.map(([command, args]) => [command, (args as { targetId?: string }).targetId])).toEqual([
      ['open_popout', 'quick-start#connect'],
      ['open_popout', 'serial#groups'],
    ]);
  });

  it('rejects an anchor without an article before invoking native code', () => {
    expect(() => popoutService.openHelp(null, 'connect')).toThrow('Help anchor requires an article id');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('exposes the help:open event payload for an existing singleton', async () => {
    const receive = vi.fn();
    const stop = vi.fn();
    let callback!: (event: Event<{ articleId: string | null; anchor: string | null }>) => void;
    vi.mocked(listen).mockImplementationOnce((_name, handler) => {
      callback = handler;
      return Promise.resolve(stop);
    });
    await popoutEventService.onHelpOpen(receive);
    callback({ event: 'help:open', id: 1, payload: { articleId: 'serial', anchor: 'groups' } });
    expect(receive).toHaveBeenCalledWith({ articleId: 'serial', anchor: 'groups' });
  });
});
