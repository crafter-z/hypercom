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
const a: SendCommandSet = { id: 'a', name: 'saved', commands: [], isLoop: false, loopDelay: 0, repeatCount: 0 };
const b: SendCommandSet = { ...a, id: 'b', name: 'other' };
const live = [a, b];
const initial: CommandEditorSnapshot = { items: live, sessionId: 'host', version: 1, dirty: false, dirtyIds: [], saving: false, error: null };
const edited = [{ ...a, name: 'panel draft' }, b];
const main = { ...initial, items: [{ ...a, name: 'main edit' }, b], version: 2, dirty: true, dirtyIds: ['a'] };
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

describe('popout conflict escape hatches', () => {
  it('resends the full local replace on the latest host version and reports touched ids', async () => {
    await mountReady();
    vi.mocked(popoutEventService.requestCommandEditor).mockResolvedValueOnce(reply(main, false, 'editor.conflict'));
    await act(async () => { sync.replaceSets(edited); });
    expect(sync.conflict).toBe(true);
    expect(sync.sets).toEqual(edited);

    vi.mocked(popoutEventService.requestCommandEditor).mockResolvedValueOnce(
      reply({ ...initial, items: edited, version: 3, dirty: true, dirtyIds: ['a'] }),
    );
    await act(async () => { expect(await sync.overwriteHost()).toBe(true); });
    expect(popoutEventService.requestCommandEditor).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'replace', items: edited, version: 2, sessionId: 'host', ids: ['a'], overwrite: true }),
    );
    expect(sync.conflict).toBe(false);
    expect(sync.error).toBeNull();
  });

  it('reloads the host draft and drops unacknowledged local text', async () => {
    await mountReady();
    vi.mocked(popoutEventService.requestCommandEditor).mockResolvedValueOnce(reply(main, false, 'editor.conflict'));
    await act(async () => { sync.replaceSets(edited); });
    expect(sync.sets).toEqual(edited);
    await act(async () => { expect(await sync.reloadHost()).toBe(true); });
    expect(sync.sets).toEqual(main.items);
    expect(sync.error).toBeNull();
    expect(popoutEventService.requestCommandEditor).toHaveBeenCalledTimes(1);
    expect(registerEditorParticipant).toHaveBeenCalled();
  });
});
