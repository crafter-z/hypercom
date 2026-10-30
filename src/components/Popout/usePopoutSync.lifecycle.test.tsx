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
import { installRecoveryTestStorage } from '../../utils/entityEditorRecovery.testSupport';
installRecoveryTestStorage();

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
  localStorage.clear();
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
  it('echoes only its host-session challenge and stays disabled until binding confirmation', async () => {
    await mountReady();
    const requests = vi.mocked(popoutEventService.emitRequestSync).mock.calls;
    const identity = requests[requests.length - 1][0]!;
    const receive = vi.mocked(popoutEventService.onCommandEditorSnapshot).mock.calls[0][0];
    await act(async () => { receive({ ...initial, clientProtocol: 2 }); });
    expect(sync.ready).toBe(false);
    await act(async () => { sync.replaceSets(edited); });
    expect(popoutEventService.requestCommandEditor).not.toHaveBeenCalled();
    const before = requests.length;
    await act(async () => { receive({ ...initial, clientProtocol: 2, clientId: 'another-panel', challengeId: 'foreign' }); });
    expect(requests.length).toBe(before);
    const challenge = { ...initial, clientProtocol: 2 as const, clientId: identity.clientId, challengeId: 'fresh-nonce' };
    await act(async () => { receive(challenge); });
    expect(sync.ready).toBe(false);
    expect(popoutEventService.emitRequestSync).toHaveBeenLastCalledWith(expect.objectContaining({
      clientId: identity.clientId, sessionId: 'host', challengeId: 'fresh-nonce',
    }));
    await act(async () => { receive({ ...initial, clientProtocol: 2, clientId: identity.clientId }); });
    expect(sync.ready).toBe(true);
    const boundRequests = requests.length;
    await act(async () => { receive(challenge); receive({ ...initial, clientProtocol: 2 }); });
    expect(sync.ready).toBe(true);
    expect(requests.length).toBe(boundRequests);
  });
  it('targets leave requests to its client and host session and returns a sequenced ACK', async () => {
    await mountReady();
    const syncCalls = vi.mocked(popoutEventService.emitRequestSync).mock.calls;
    const identity = syncCalls[syncCalls.length - 1][0]!;
    const leave = vi.mocked(popoutEventService.onCommandEditorClientLeave).mock.calls[0][0];
    await act(async () => {
      leave({ ...identity, clientId: 'retired-panel', action: 'discard', requestId: 'wrong-client' });
      leave({ ...identity, sessionId: 'retired-host', action: 'save', requestId: 'wrong-host' });
    });
    expect(popoutEventService.requestCommandEditor).not.toHaveBeenCalled();
    vi.mocked(popoutEventService.requestCommandEditor).mockResolvedValueOnce(reply({ ...initial, version: 2 }));
    await act(async () => { leave({ ...identity, action: 'save', requestId: 'current' }); });
    expect(popoutEventService.emitCommandEditorClientResult).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'current', success: true, clientId: identity.clientId, sessionId: 'host', unresolved: false,
      sequence: expect.any(Number),
    }));
    const result = vi.mocked(popoutEventService.emitCommandEditorClientResult).mock.calls[0][0];
    expect(result.sequence).toBeGreaterThan(identity.sequence);
  });

  it('keeps one client identity and strictly increasing state sequences through cleanup', async () => {
    await mountReady();
    await act(async () => { root.unmount(); });
    root = createRoot(document.createElement('div'));
    const states = vi.mocked(popoutEventService.emitCommandEditorClientState).mock.calls.map(([state]) => {
      if (typeof state === 'boolean') throw new Error('modern panel emitted legacy state');
      return state;
    });
    expect(new Set(states.map(state => state.clientId)).size).toBe(1);
    for (let i = 1; i < states.length; i++) expect(states[i].sequence).toBeGreaterThan(states[i - 1].sequence);
    expect(states[states.length - 1]).toMatchObject({ sessionId: 'host', unresolved: false });
  });

  it('does not continue queued replacements after the owning panel unmounts', async () => {
    await mountReady();
    const first = deferred<CommandEditorResult>();
    vi.mocked(popoutEventService.requestCommandEditor).mockReturnValueOnce(first.promise);
    await act(async () => { sync.replaceSets(edited); sync.replaceSets([{ ...live[0], name: 'newer' }]); });
    await act(async () => { root.unmount(); });
    root = createRoot(document.createElement('div'));
    await act(async () => { first.resolve(reply({ ...initial, version: 2, items: edited })); });
    expect(popoutEventService.requestCommandEditor).toHaveBeenCalledTimes(1);
  });
  it('can close after discarding its work while preserving an earlier host-only draft', async () => {
    await mountReady();
    const hostDraft = { ...initial, items: [{ ...live[0], name: 'main draft' }], version: 2, dirty: true, dirtyIds: ['live'] };
    await act(async () => { vi.mocked(popoutEventService.onCommandEditorSnapshot).mock.calls[0][0](hostDraft); });
    const participant = () => {
      const calls = vi.mocked(registerEditorParticipant).mock.calls;
      return calls[calls.length - 1][1];
    };
    expect(participant().isDirty()).toBe(false);
    vi.mocked(popoutEventService.requestCommandEditor)
      .mockResolvedValueOnce(reply({ ...hostDraft, items: edited, version: 3 }))
      .mockResolvedValueOnce(reply({ ...hostDraft, version: 4 }));
    await act(async () => { sync.replaceSets(edited); });
    expect(participant().isDirty()).toBe(true);
    await act(async () => { expect(await sync.discard()).toBe(true); });
    expect(sync.sets).toEqual(hostDraft.items);
    expect(sync.dirty).toBe(true);
    expect(participant().isDirty()).toBe(false);
  });
  it('replays unresolved text to a restarted host even without another keystroke', async () => {
    await mountReady();
    vi.mocked(popoutEventService.requestCommandEditor).mockResolvedValueOnce(reply(initial, false, 'editor.conflict'));
    await act(async () => { sync.replaceSets(edited); });
    vi.mocked(popoutEventService.emitCommandEditorClientState).mockClear();
    await act(async () => {
      vi.mocked(popoutEventService.onCommandEditorSnapshot).mock.calls[0][0]({ ...initial, sessionId: 'restarted', version: 0 });
    });
    expect(popoutEventService.emitCommandEditorClientState).toHaveBeenLastCalledWith(expect.objectContaining({ unresolved: true, clientId: expect.any(String), sequence: expect.any(Number) }));
    expect(sync.sets).toEqual(edited);
  });

  it('ignores an older saving snapshot after a newer persistence result', async () => {
    await mountReady();
    const receive = vi.mocked(popoutEventService.onCommandEditorSnapshot).mock.calls[0][0];
    const inFlight = { ...initial, items: edited, version: 3, dirty: true, dirtyIds: ['live'], saving: true };
    await act(async () => { receive(inFlight); });
    await act(async () => { receive({ ...initial, items: edited, version: 4 }); });
    await act(async () => { receive(inFlight); });
    expect(sync.saving).toBe(false);
    expect(sync.dirty).toBe(false);
    expect(sync.sets).toEqual(edited);
  });
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
    expect(popoutEventService.requestCommandEditor).toHaveBeenLastCalledWith({ action: 'replace', items: newer, version: 2, sessionId: 'host', ids: ['live'], clientId: expect.any(String) });
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
    expect(popoutEventService.emitCommandEditorClientState).toHaveBeenLastCalledWith(expect.objectContaining({ unresolved: true, clientId: expect.any(String), sequence: expect.any(Number) }));
    vi.mocked(popoutEventService.requestCommandEditor).mockResolvedValueOnce(reply({ ...initial, version: 3 }));
    await act(async () => { expect(await sync.discard()).toBe(true); });
    expect(popoutEventService.requestCommandEditor).toHaveBeenLastCalledWith({ action: 'discard', version: 2, sessionId: 'host', ids: ['live'], clientId: expect.any(String) });
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
    expect(popoutEventService.requestCommandEditor).toHaveBeenLastCalledWith({ action: 'discard', version: 2, sessionId: 'host', ids: ['live'], clientId: expect.any(String) });
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
