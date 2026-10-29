// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eventService, popoutEventService, serialService } from '../../services/tauri';
import type { CommandEditorResult, CommandEditorSnapshot } from '../../services/tauri';
import { registerEditorParticipant } from '../../utils/editorLeave';
import { usePopoutSync } from './usePopoutSync';
import type { PopoutSync } from './usePopoutSync';
import type { SendCommandSet } from '../../types';

vi.mock('../../services/tauri', () => ({
  eventService: { onSerialStatus: vi.fn() },
  popoutEventService: {
    onCommandEditorSnapshot: vi.fn(), onCommandEditorClientLeave: vi.fn(),
    onActiveTabChanged: vi.fn(), onPortStatusesSync: vi.fn(), requestCommandEditor: vi.fn(),
    emitRequestSync: vi.fn(async () => {}), emitOpenConfig: vi.fn(async () => {}),
    emitCommandEditorClientState: vi.fn(async () => {}), emitCommandEditorClientResult: vi.fn(async () => {}),
  },
  serialService: { listAvailablePorts: vi.fn(async () => []) },
}));
vi.mock('../../utils/editorLeave', () => ({ registerEditorParticipant: vi.fn(() => () => {}) }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
function deferred<T>() {
  // ES2020 does not expose Promise.withResolvers.
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const live: SendCommandSet[] = [{ id: 'live', name: 'saved', commands: [], isLoop: false, loopDelay: 0, repeatCount: 0 }];
const initial: CommandEditorSnapshot = { items: live, sessionId: 'host', version: 1, dirty: false, dirtyIds: [], saving: false, error: null };
const edited = [{ ...live[0], name: 'typed draft' }];
let root: Root;
let sync!: PopoutSync;
function Probe() { sync = usePopoutSync(); return null; }
function reply(snapshot: CommandEditorSnapshot, success = true, error: string | null = null): CommandEditorResult {
  return { requestId: 'request', success, error, snapshot };
}
async function mountReady() {
  await act(async () => { root.render(createElement(Probe)); });
  await act(async () => { vi.mocked(popoutEventService.onCommandEditorSnapshot).mock.calls[0][0](initial); });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(popoutEventService.onCommandEditorSnapshot).mockResolvedValue(() => {});
  vi.mocked(popoutEventService.onCommandEditorClientLeave).mockResolvedValue(() => {});
  vi.mocked(popoutEventService.onActiveTabChanged).mockResolvedValue(() => {});
  vi.mocked(popoutEventService.onPortStatusesSync).mockResolvedValue(() => {});
  vi.mocked(eventService.onSerialStatus).mockResolvedValue(() => {});
  vi.mocked(serialService.listAvailablePorts).mockResolvedValue([]);
  root = createRoot(document.createElement('div'));
});
afterEach(async () => { await act(async () => { root.unmount(); }); });

describe('popout listener group ownership', () => {
  it('retires fulfilled and late registrations on partial failure and rejects stale callbacks', async () => {
    const late = deferred<() => void>();
    const failed = deferred<() => void>();
    const unSets = vi.fn();
    const unStatus = vi.fn();
    let receive!: (snapshot: CommandEditorSnapshot) => void;
    vi.mocked(popoutEventService.onCommandEditorSnapshot).mockImplementationOnce(callback => { receive = callback; return Promise.resolve(unSets); });
    vi.mocked(popoutEventService.onActiveTabChanged).mockImplementationOnce(() => failed.promise);
    vi.mocked(eventService.onSerialStatus).mockImplementationOnce(() => late.promise);
    await act(async () => { root.render(createElement(Probe)); });
    await act(async () => { failed.reject(new Error('registration failed')); });
    expect(unSets).toHaveBeenCalledTimes(1);
    await act(async () => { receive(initial); late.resolve(unStatus); });
    expect(sync.sets).toEqual([]);
    expect(unStatus).toHaveBeenCalledTimes(1);
    expect(popoutEventService.emitRequestSync).not.toHaveBeenCalled();
  });

  it('unlistens a registration finishing after unmount', async () => {
    const late = deferred<() => void>();
    const unlisten = vi.fn();
    vi.mocked(popoutEventService.onCommandEditorSnapshot).mockImplementationOnce(() => late.promise);
    await act(async () => { root.render(createElement(Probe)); });
    await act(async () => { root.unmount(); });
    root = createRoot(document.createElement('div'));
    await act(async () => { late.resolve(unlisten); });
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(popoutEventService.emitRequestSync).not.toHaveBeenCalled();
  });

  it('waits for every command, remote-close and status listener before requesting sync', async () => {
    const statusReady = deferred<() => void>();
    vi.mocked(eventService.onSerialStatus).mockImplementationOnce(() => statusReady.promise);
    await act(async () => { root.render(createElement(Probe)); });
    expect(popoutEventService.emitRequestSync).not.toHaveBeenCalled();
    await act(async () => { statusReady.resolve(() => {}); });
    expect(popoutEventService.emitRequestSync).toHaveBeenCalledTimes(1);
    expect(sync.ready).toBe(false);
    await act(async () => { vi.mocked(popoutEventService.onCommandEditorSnapshot).mock.calls[0][0](initial); });
    expect(sync.sets).toEqual(live);
  });
});

describe('main-authority retained command drafts', () => {
  it('serializes replacements, keeping newer typing until the corresponding version ACK', async () => {
    await mountReady();
    const first = deferred<CommandEditorResult>();
    const second = deferred<CommandEditorResult>();
    vi.mocked(popoutEventService.requestCommandEditor).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await act(async () => { sync.replaceSets(edited); });
    const newer = [{ ...edited[0], name: 'newer typing' }];
    await act(async () => { sync.replaceSets(newer); });
    expect(popoutEventService.requestCommandEditor).toHaveBeenCalledTimes(1);
    await act(async () => { first.resolve(reply({ ...initial, items: edited, version: 2, dirty: true, dirtyIds: ['live'] })); });
    expect(sync.sets).toEqual(newer);
    expect(popoutEventService.requestCommandEditor).toHaveBeenLastCalledWith({ action: 'replace', items: newer, version: 2, sessionId: 'host' });
    await act(async () => { second.resolve(reply({ ...initial, items: newer, version: 3, dirty: true, dirtyIds: ['live'] })); });
    expect(sync.pending).toBe(false);
    expect(sync.dirtyIds.has('live')).toBe(true);
  });

  it('retains failed/conflicting text instead of replacing it with a main snapshot', async () => {
    await mountReady();
    const main = { ...initial, items: [{ ...live[0], name: 'main edit' }], version: 2, dirty: true, dirtyIds: ['live'] };
    vi.mocked(popoutEventService.requestCommandEditor).mockResolvedValueOnce(reply(main, false, 'editor.conflict'));
    await act(async () => { sync.replaceSets(edited); });
    await act(async () => { vi.mocked(popoutEventService.onCommandEditorSnapshot).mock.calls[0][0](main); });
    expect(sync.sets).toEqual(edited);
    expect(sync.error).toBe('editor.conflict');
    expect(sync.dirty).toBe(true);
    expect(popoutEventService.emitCommandEditorClientState).toHaveBeenLastCalledWith(true);
    vi.mocked(popoutEventService.requestCommandEditor).mockResolvedValueOnce(reply({ ...initial, version: 3 }));
    await act(async () => { expect(await sync.discard()).toBe(true); });
    expect(popoutEventService.requestCommandEditor).toHaveBeenLastCalledWith({ action: 'discard', version: 2, sessionId: 'host' });
    expect(sync.sets).toEqual(live);
    expect(sync.dirty).toBe(false);
  });

  it('does not mark a save complete before persistence ACK and retains drafts on failure', async () => {
    await mountReady();
    const dirty = { ...initial, items: edited, version: 2, dirty: true, dirtyIds: ['live'] };
    await act(async () => { vi.mocked(popoutEventService.onCommandEditorSnapshot).mock.calls[0][0](dirty); });
    const saved = deferred<CommandEditorResult>();
    vi.mocked(popoutEventService.requestCommandEditor).mockReturnValueOnce(saved.promise);
    let outcome!: Promise<boolean>;
    await act(async () => { outcome = sync.save(); });
    expect(sync.saving).toBe(true);
    expect(sync.dirty).toBe(true);
    await act(async () => { saved.resolve(reply({ ...dirty, error: 'disk full' }, false, 'disk full')); expect(await outcome).toBe(false); });
    expect(sync.sets).toEqual(edited);
    expect(sync.dirty).toBe(true);
    expect(sync.error).toBe('disk full');
  });

  it('waits for a pending replace before leave-discard and waits for the discard ACK', async () => {
    await mountReady();
    const replaced = deferred<CommandEditorResult>();
    const discarded = deferred<CommandEditorResult>();
    vi.mocked(popoutEventService.requestCommandEditor).mockReturnValueOnce(replaced.promise).mockReturnValueOnce(discarded.promise);
    await act(async () => { sync.replaceSets(edited); });
    let outcome!: Promise<void> | void;
    await act(async () => {
      const calls = vi.mocked(registerEditorParticipant).mock.calls;
      outcome = calls[calls.length - 1][1].discard();
    });
    expect(popoutEventService.requestCommandEditor).toHaveBeenCalledTimes(1);
    await act(async () => { replaced.resolve(reply({ ...initial, items: edited, version: 2, dirty: true, dirtyIds: ['live'] })); });
    expect(popoutEventService.requestCommandEditor).toHaveBeenLastCalledWith({ action: 'discard', version: 2, sessionId: 'host' });
    expect(sync.sets).toEqual(edited);
    await act(async () => { discarded.resolve(reply({ ...initial, version: 3 })); await outcome; });
    expect(sync.sets).toEqual(live);
  });

  it('acknowledges app-exit remote leave only after the panel save finishes', async () => {
    await mountReady();
    const saved = deferred<CommandEditorResult>();
    vi.mocked(popoutEventService.requestCommandEditor).mockReturnValueOnce(saved.promise);
    await act(async () => { vi.mocked(popoutEventService.onCommandEditorClientLeave).mock.calls[0][0]({ requestId: 'exit', action: 'save' }); });
    expect(popoutEventService.emitCommandEditorClientResult).not.toHaveBeenCalled();
    await act(async () => { saved.resolve(reply({ ...initial, version: 2 })); });
    expect(popoutEventService.emitCommandEditorClientResult).toHaveBeenCalledWith({ requestId: 'exit', success: true, error: null });
  });

  it('adopts a restarted host with a lower version and ignores late snapshots from the retired host', async () => {
    await mountReady();
    const receive = vi.mocked(popoutEventService.onCommandEditorSnapshot).mock.calls[0][0];
    const restored = [{ ...live[0], name: 'restored configuration' }];
    await act(async () => { receive({ ...initial, items: restored, sessionId: 'restarted', version: 0 }); });
    expect(sync.sets).toEqual(restored);
    await act(async () => { receive({ ...initial, items: edited, version: 100 }); });
    expect(sync.sets).toEqual(restored);
    const after = [{ ...restored[0], name: 'edited after restore' }];
    vi.mocked(popoutEventService.requestCommandEditor).mockResolvedValueOnce(reply({ ...initial, items: after, sessionId: 'restarted', version: 1, dirty: true, dirtyIds: ['live'] }));
    await act(async () => { sync.replaceSets(after); });
    expect(sync.sets).toEqual(after);
    expect(sync.error).toBeNull();
  });
});
