// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePopoutBridge } from './usePopoutBridge';
import { useAppStore } from '../stores/useAppStore';
import { useRuleStore } from '../stores/useRuleStore';
import { useSystemStore } from '../stores/useSystemStore';
import { resetStoresForTests } from '../stores/resetStores';
import { popoutEventService, popoutService, serialService } from '../services/tauri';
import type { CommandEditorClientResult } from '../services/tauri';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { getEditorLeaveDialogState, requestEditorLeave, respondEditorLeave } from '../utils/editorLeave';

vi.mock('@tauri-apps/api/webviewWindow', () => ({ WebviewWindow: { getByLabel: vi.fn(async () => null) } }));

vi.mock('../services/tauri', () => ({
  serialService: { sendSerialData: vi.fn(async () => 3) },
  gitBashSimService: { resizeGitBashSim: vi.fn(async () => {}) },
  popoutService: { terminalClosed: vi.fn(() => true) },
  popoutEventService: {
    onSendCommand: vi.fn(), onOpenConfig: vi.fn(), onCommandEditorRequest: vi.fn(), onCommandEditorClientState: vi.fn(),
    onRequestSync: vi.fn(), onTerminalRequestSnapshot: vi.fn(), onTerminalClosed: vi.fn(),
    emitActiveTabChanged: vi.fn(async () => {}), emitCommandSetsChanged: vi.fn(async () => {}),
    emitCommandEditorSnapshot: vi.fn(async () => {}), emitCommandEditorResult: vi.fn(async () => {}),
    emitPortStatusesSync: vi.fn(async () => {}), emitTerminalSnapshot: vi.fn(async () => {}),
    requestCommandEditorClientLeave: vi.fn(),
  },
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let tabId: string;
function Probe() { usePopoutBridge(); return null; }
function activateClient(clientId: string, sessionId: string) {
  const handshake = vi.mocked(popoutEventService.onRequestSync).mock.calls[0][0];
  handshake({ clientId, sessionId, sequence: 0 });
  const calls = vi.mocked(popoutEventService.emitCommandEditorSnapshot).mock.calls;
  const challenge = calls[calls.length - 1][0];
  expect(challenge).toMatchObject({ clientId, sessionId, challengeId: expect.any(String) });
  handshake({ clientId, sessionId, sequence: 1, challengeId: challenge.challengeId });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(WebviewWindow.getByLabel).mockResolvedValue(null);
  resetStoresForTests();
  useAppStore.setState({ ports: [{ id: 'COM1', name: 'COM1', status: 'connected', type: 'real', isHidden: false }] });
  tabId = useAppStore.getState().openTab('COM1');
  useAppStore.getState().setTabPoppedOut(tabId, true);
  useRuleStore.getState().setSendCommandSets([{ id: 'set', name: 'saved', commands: [], isLoop: false, loopDelay: 0, repeatCount: 0 }]);
  vi.mocked(popoutEventService.onSendCommand).mockResolvedValue(() => {});
  vi.mocked(popoutEventService.onOpenConfig).mockResolvedValue(() => {});
  vi.mocked(popoutEventService.onCommandEditorRequest).mockResolvedValue(() => {});
  vi.mocked(popoutEventService.onCommandEditorClientState).mockResolvedValue(() => {});
  vi.mocked(popoutEventService.onRequestSync).mockResolvedValue(() => {});
  vi.mocked(popoutEventService.onTerminalRequestSnapshot).mockResolvedValue(() => {});
  vi.mocked(popoutEventService.onTerminalClosed).mockResolvedValue(() => {});
  root = createRoot(document.createElement('div'));
});
afterEach(async () => { await respondEditorLeave('continue'); await act(async () => { root.unmount(); }); });

describe('main popout bridge retirement', () => {
  it('does not activate an unseen delayed client request without fresh live proof', async () => {
    await act(async () => { root.render(createElement(Probe)); });
    const calls = vi.mocked(popoutEventService.emitCommandEditorSnapshot).mock.calls;
    const sessionId = calls[calls.length - 1][0].sessionId;
    const handshake = vi.mocked(popoutEventService.onRequestSync).mock.calls[0][0];
    const report = vi.mocked(popoutEventService.onCommandEditorClientState).mock.calls[0][0];
    handshake({ clientId: 'unseen-old', sessionId, sequence: 0 });
    const oldChallenge = calls[calls.length - 1][0].challengeId;
    activateClient('current', sessionId);
    report({ clientId: 'current', sessionId, sequence: 2, unresolved: true });
    // An old proof issued before this handoff must itself be re-challenged.
    handshake({ clientId: 'unseen-old', sessionId, sequence: 1, challengeId: oldChallenge });
    report({ clientId: 'unseen-old', sessionId, sequence: 99, unresolved: false });
    const leaving = requestEditorLeave(['popout:pending-commands']);
    expect(getEditorLeaveDialogState().open).toBe(true);
    await respondEditorLeave('continue');
    expect(await leaving).toBe(false);
    report({ clientId: 'current', sessionId, sequence: 3, unresolved: false });
    const clean = requestEditorLeave(['popout:pending-commands']);
    expect(getEditorLeaveDialogState().open).toBe(false);
    expect(await clean).toBe(true);
  });
  it('rejects retired-client and out-of-order states including delayed cleanup false', async () => {
    await act(async () => { root.render(createElement(Probe)); });
    const snapshots = vi.mocked(popoutEventService.emitCommandEditorSnapshot).mock.calls;
    const sessionId = snapshots[snapshots.length - 1][0].sessionId;
    const handshake = vi.mocked(popoutEventService.onRequestSync).mock.calls[0][0];
    const report = vi.mocked(popoutEventService.onCommandEditorClientState).mock.calls[0][0];
    activateClient('old', sessionId);
    report({ clientId: 'old', sessionId, sequence: 2, unresolved: true });
    activateClient('new', sessionId);
    report({ clientId: 'new', sessionId, sequence: 2, unresolved: true });
    report({ clientId: 'old', sessionId, sequence: 99, unresolved: false });
    report(false); // legacy cleanup cannot override modern state either
    const dirty = requestEditorLeave(['popout:pending-commands']);
    expect(getEditorLeaveDialogState().open).toBe(true);
    await respondEditorLeave('continue');
    expect(await dirty).toBe(false);
    report({ clientId: 'new', sessionId, sequence: 3, unresolved: false });
    report({ clientId: 'new', sessionId, sequence: 2, unresolved: true });
    report({ clientId: 'old', sessionId, sequence: 100, unresolved: true });
    handshake({ clientId: 'old', sessionId, sequence: 101 });
    report(true);
    const clean = requestEditorLeave(['popout:pending-commands']);
    expect(getEditorLeaveDialogState().open).toBe(false);
    expect(await clean).toBe(true);
  });

  it('ignores a prior host session even when its state sequence is higher', async () => {
    await act(async () => { root.render(createElement(Probe)); });
    const snapshots = vi.mocked(popoutEventService.emitCommandEditorSnapshot).mock.calls;
    const sessionId = snapshots[snapshots.length - 1][0].sessionId;
    activateClient('panel', sessionId);
    const report = vi.mocked(popoutEventService.onCommandEditorClientState).mock.calls[0][0];
    report({ clientId: 'panel', sessionId, sequence: 2, unresolved: true });
    report({ clientId: 'panel', sessionId: 'retired-host', sequence: 100, unresolved: false });
    const leaving = requestEditorLeave(['popout:pending-commands']);
    expect(getEditorLeaveDialogState().open).toBe(true);
    await respondEditorLeave('continue');
    expect(await leaving).toBe(false);
  });

  it('does not let a retired client leave ACK approve a newer panel', async () => {
    await act(async () => { root.render(createElement(Probe)); });
    const snapshots = vi.mocked(popoutEventService.emitCommandEditorSnapshot).mock.calls;
    const sessionId = snapshots[snapshots.length - 1][0].sessionId;
    const report = vi.mocked(popoutEventService.onCommandEditorClientState).mock.calls[0][0];
    activateClient('old', sessionId);
    report({ clientId: 'old', sessionId, sequence: 2, unresolved: true });
    vi.mocked(WebviewWindow.getByLabel).mockResolvedValue({} as WebviewWindow);
    let finish!: (result: CommandEditorClientResult) => void;
    vi.mocked(popoutEventService.requestCommandEditorClientLeave).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const leaving = requestEditorLeave(['popout:pending-commands']);
    const response = respondEditorLeave('save');
    await vi.waitFor(() => expect(popoutEventService.requestCommandEditorClientLeave).toHaveBeenCalledOnce());
    expect(popoutEventService.requestCommandEditorClientLeave).toHaveBeenCalledWith('save', { clientId: 'old', sessionId, sequence: 2 });
    activateClient('new', sessionId);
    report({ clientId: 'new', sessionId, sequence: 2, unresolved: true });
    finish({ requestId: 'old-request', clientId: 'old', sessionId, sequence: 3, unresolved: false, success: true, error: null });
    await response;
    expect(getEditorLeaveDialogState()).toMatchObject({ open: true, error: 'editor.saveFailed' });
    vi.mocked(popoutEventService.requestCommandEditorClientLeave).mockResolvedValueOnce({
      requestId: 'new-request', clientId: 'new', sessionId, sequence: 3, unresolved: false, success: true, error: null,
    });
    await respondEditorLeave('save');
    expect(await leaving).toBe(true);
  });
  it('retires stale pending text after native destruction without asking a dead panel', async () => {
    await act(async () => { root.render(createElement(Probe)); });
    vi.mocked(popoutEventService.onCommandEditorClientState).mock.calls[0][0](true);
    vi.mocked(WebviewWindow.getByLabel).mockResolvedValueOnce(null);
    const leaving = requestEditorLeave(['popout:pending-commands']);
    await respondEditorLeave('save');
    expect(await leaving).toBe(true);
    expect(WebviewWindow.getByLabel).toHaveBeenCalledWith('quick-send');
    expect(popoutEventService.requestCommandEditorClientLeave).not.toHaveBeenCalled();
  });

  it('does not clear a newer pending-state report when an earlier leave ACK succeeds', async () => {
    await act(async () => { root.render(createElement(Probe)); });
    const report = vi.mocked(popoutEventService.onCommandEditorClientState).mock.calls[0][0];
    report(true);
    vi.mocked(WebviewWindow.getByLabel).mockResolvedValueOnce({} as WebviewWindow);
    let finish!: (result: { requestId: string; success: boolean; error: null }) => void;
    vi.mocked(popoutEventService.requestCommandEditorClientLeave).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const leaving = requestEditorLeave(['popout:pending-commands']);
    const response = respondEditorLeave('save');
    await vi.waitFor(() => expect(popoutEventService.requestCommandEditorClientLeave).toHaveBeenCalledOnce());
    report(true);
    finish({ requestId: 'old', success: true, error: null });
    await response;
    expect(getEditorLeaveDialogState()).toMatchObject({ open: true, error: 'editor.saveFailed' });
    await respondEditorLeave('continue');
    expect(await leaving).toBe(false);
  });
  it('rejects stale callbacks rather than mutating stores or sending', async () => {
    let finishRegistration!: (unlisten: () => void) => void;
    const unlisten = vi.fn();
    vi.mocked(popoutEventService.onSendCommand).mockImplementationOnce(() => new Promise(resolve => { finishRegistration = resolve; }));
    await act(async () => { root.render(createElement(Probe)); });
    await act(async () => { root.unmount(); });
    root = createRoot(document.createElement('div'));
    const rules = useRuleStore.getState().sendCommandSets;
    await act(async () => {
      vi.mocked(popoutEventService.onSendCommand).mock.calls[0][0]({ portId: 'COM1', content: 'old', isHex: false, lineEnding: 'None' });
      vi.mocked(popoutEventService.onOpenConfig).mock.calls[0][0]({ page: 'commands' });
      vi.mocked(popoutEventService.onCommandEditorRequest).mock.calls[0][0]({ action: 'replace', items: rules, requestId: 'stale', version: 3, sessionId: 'retired' });
      vi.mocked(popoutEventService.onRequestSync).mock.calls[0][0]();
      vi.mocked(popoutEventService.onTerminalRequestSnapshot).mock.calls[0][0]({ portId: 'COM1' });
      vi.mocked(popoutEventService.onTerminalClosed).mock.calls[0][0]({ portId: 'COM1' });
      finishRegistration(unlisten);
    });
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(serialService.sendSerialData).not.toHaveBeenCalled();
    expect(useRuleStore.getState().sendCommandSets).toBe(rules);
    expect(useSystemStore.getState().ui.isConfigOpen).toBe(false);
    expect(useAppStore.getState().tabs.find(tab => tab.id === tabId)).toMatchObject({ poppedOut: true });
    expect(popoutService.terminalClosed).not.toHaveBeenCalled();
    expect(popoutEventService.emitActiveTabChanged).not.toHaveBeenCalled();
    expect(popoutEventService.emitTerminalSnapshot).not.toHaveBeenCalled();
  });
});

