// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eventService, popoutEventService } from '../../services/tauri';
import type { CommandEditorResult, CommandEditorSnapshot } from '../../services/tauri';
import type { SendCommandSet } from '../../types';
import { usePopoutSync } from './usePopoutSync';
import type { PopoutSync } from './usePopoutSync';
import { writeEditorRecovery } from '../../utils/entityEditorRecovery';
import { installRecoveryTestStorage } from '../../utils/entityEditorRecovery.testSupport';
installRecoveryTestStorage();

vi.mock('../../services/tauri', () => ({
  eventService: { onSerialStatus: vi.fn() }, serialService: { listAvailablePorts: vi.fn(async () => []) },
  popoutEventService: {
    onCommandEditorSnapshot: vi.fn(), onCommandEditorClientLeave: vi.fn(), onActiveTabChanged: vi.fn(), onPortStatusesSync: vi.fn(),
    requestCommandEditor: vi.fn(), emitRequestSync: vi.fn(async () => {}), emitOpenConfig: vi.fn(async () => {}),
    emitCommandEditorClientState: vi.fn(async () => {}), emitCommandEditorClientResult: vi.fn(async () => {}),
  },
}));
vi.mock('../../utils/editorLeave', () => ({ registerEditorParticipant: vi.fn(() => () => {}) }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const saved: SendCommandSet = { id: 'one', name: 'Saved', commands: [], isLoop: false, loopDelay: 0, repeatCount: 0 };
const initial: CommandEditorSnapshot = { items: [saved], sessionId: 'host', version: 1, dirty: false, dirtyIds: [], saving: false, error: null };
const typed = [{ ...saved, name: 'Unacknowledged panel text' }];
const key = 'hypercom.editor-recovery.pending-commands';
let root: Root;
let sync!: PopoutSync;
function Probe() { sync = usePopoutSync(); return null; }
function receive(next: CommandEditorSnapshot) {
  const calls = vi.mocked(popoutEventService.onCommandEditorSnapshot).mock.calls;
  calls[calls.length - 1][0](next);
}
async function mount() {
  await act(async () => { root.render(createElement(Probe)); });
  await act(async () => { receive(initial); });
}
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  for (const listener of [popoutEventService.onCommandEditorSnapshot, popoutEventService.onCommandEditorClientLeave, popoutEventService.onActiveTabChanged, popoutEventService.onPortStatusesSync, eventService.onSerialStatus]) vi.mocked(listener).mockResolvedValue(() => {});
  root = createRoot(document.createElement('div'));
});
afterEach(async () => { await act(async () => { root.unmount(); }); });

describe('unacknowledged command text crash recovery', () => {
  it('records before ACK, retains text across remount, and requires explicit overwrite before sending it to main', async () => {
    await mount();
    vi.mocked(popoutEventService.requestCommandEditor).mockReturnValueOnce(new Promise<CommandEditorResult>(() => {}));
    await act(async () => { sync.replaceSets(typed); });
    expect(JSON.parse(localStorage.getItem(key)!).payload).toEqual({ baseline: [saved], draft: typed });
    await act(async () => { root.unmount(); });
    root = createRoot(document.createElement('div'));
    vi.mocked(popoutEventService.requestCommandEditor).mockClear();
    await mount();
    expect(sync.sets).toEqual(typed);
    expect(sync.conflict).toBe(true);
    expect(sync.dirty).toBe(true);
    expect(popoutEventService.requestCommandEditor).not.toHaveBeenCalled();
    await act(async () => { expect(await sync.save()).toBe(false); });
    expect(popoutEventService.requestCommandEditor).not.toHaveBeenCalled();
    vi.mocked(popoutEventService.requestCommandEditor).mockResolvedValueOnce({ requestId: 'overwrite', success: true, error: null, snapshot: { ...initial, version: 2, items: typed, dirty: true, dirtyIds: ['one'] } });
    await act(async () => { expect(await sync.overwriteHost()).toBe(true); });
    expect(popoutEventService.requestCommandEditor).toHaveBeenCalledWith(expect.objectContaining({ action: 'replace', items: typed, overwrite: true }));
    expect(localStorage.getItem(key)).toBeNull();
  });
  it('can discard recovered local-only text by reloading main without mutating its draft', async () => {
    writeEditorRecovery('pending-commands', { baseline: [saved], draft: typed });
    await mount();
    await act(async () => { expect(await sync.reloadHost()).toBe(true); });
    expect(sync.sets).toEqual([saved]);
    expect(localStorage.getItem(key)).toBeNull();
    expect(popoutEventService.requestCommandEditor).not.toHaveBeenCalled();
    expect(popoutEventService.emitRequestSync).toHaveBeenLastCalledWith(expect.objectContaining({ resetUndo: true }));
  });
  it('retires a redundant local recovery once the current main draft already contains it', async () => {
    writeEditorRecovery('pending-commands', { baseline: [saved], draft: [saved] });
    await mount();
    expect(sync.dirty).toBe(false);
    expect(localStorage.getItem(key)).toBeNull();
  });
  it.each(['{broken', JSON.stringify({ schema: 0, payload: {} }), JSON.stringify({ schema: 1, payload: { baseline: [saved], draft: typed, pluginConfigs: [] } })])('ignores bad recovery data %s', async raw => {
    localStorage.setItem(key, raw);
    await mount();
    expect(sync.sets).toEqual([saved]);
    expect(sync.dirty).toBe(false);
  });
});

describe('directional host retirement', () => {
  it('never lets an unsolicited unseen old host retire the bound current host', async () => {
    await mount();
    const calls = vi.mocked(popoutEventService.emitRequestSync).mock.calls;
    const clientId = calls[calls.length - 1][0]!.clientId;
    await act(async () => { receive({ ...initial, clientProtocol: 2, clientId }); });
    await act(async () => { receive({ ...initial, sessionId: 'unseen-legacy-host', version: 999, items: typed }); });
    expect(sync.sets).toEqual([saved]);
    expect(sync.ready).toBe(true);
    const stale = { ...initial, clientProtocol: 2 as const, clientId, sessionId: 'unseen-old-host', version: 1000, items: typed, syncRequestId: 'old-request' };
    await act(async () => { receive(stale); });
    expect(sync.sets).toEqual([saved]);
    const probe = calls[calls.length - 1][0]!;
    expect(probe.sessionId).toBe('');
    await act(async () => { receive({ ...initial, clientProtocol: 2, clientId, syncRequestId: probe.syncRequestId }); });
    expect(sync.sets).toEqual([saved]);
    await act(async () => { receive({ ...stale, sessionId: 'actual-new-host', version: 0 }); });
    const freshProbe = calls[calls.length - 1][0]!;
    await act(async () => { receive({ ...initial, sessionId: 'actual-new-host', version: 0, clientProtocol: 2, clientId, challengeId: 'fresh', syncRequestId: freshProbe.syncRequestId }); });
    const echo = calls[calls.length - 1][0]!;
    expect(echo).toMatchObject({ sessionId: 'actual-new-host', challengeId: 'fresh' });
    const newItems = [{ ...saved, name: 'New live host' }];
    await act(async () => { receive({ ...initial, items: newItems, sessionId: 'actual-new-host', version: 0, clientProtocol: 2, clientId, syncRequestId: echo.syncRequestId }); });
    await act(async () => { receive({ ...initial, clientProtocol: 2, clientId, version: 9999 }); receive(stale); });
    expect(sync.ready).toBe(true);
    expect(sync.sets).toEqual(newItems);
  });
});
