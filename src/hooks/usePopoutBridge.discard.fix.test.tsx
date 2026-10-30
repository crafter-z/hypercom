// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePopoutBridge } from './usePopoutBridge';
import { useAppStore } from '../stores/useAppStore';
import { useRuleStore } from '../stores/useRuleStore';
import { resetStoresForTests } from '../stores/resetStores';
import { popoutEventService } from '../services/tauri';
import type { CommandEditorRequest, CommandEditorResult } from '../services/tauri';
import { getEntityEditorSnapshot, resetEntityEditorForTests, updateEntityDraft } from '../utils/entityEditor';
import type { SendCommandSet } from '../types';

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
type RequestWithIds = CommandEditorRequest & { ids?: string[] };
let root: Root;
const a: SendCommandSet = { id: 'a', name: 'A', commands: [], isLoop: false, loopDelay: 0, repeatCount: 0 };
const b: SendCommandSet = { ...a, id: 'b', name: 'B' };
function Probe() { usePopoutBridge(); return null; }
async function settle() { await new Promise(resolve => setTimeout(resolve, 0)); }
function lastResult(): CommandEditorResult {
  const calls = vi.mocked(popoutEventService.emitCommandEditorResult).mock.calls;
  return calls[calls.length - 1][0];
}
beforeEach(async () => {
  vi.clearAllMocks();
  resetStoresForTests();
  resetEntityEditorForTests();
  useRuleStore.getState().setSendCommandSets([a, b]);
  useAppStore.setState(state => ({ config: { ...state.config, sendCommandSets: [a, b] } }));
  vi.mocked(popoutEventService.onSendCommand).mockResolvedValue(() => {});
  vi.mocked(popoutEventService.onOpenConfig).mockResolvedValue(() => {});
  vi.mocked(popoutEventService.onCommandEditorRequest).mockResolvedValue(() => {});
  vi.mocked(popoutEventService.onCommandEditorClientState).mockResolvedValue(() => {});
  vi.mocked(popoutEventService.onRequestSync).mockResolvedValue(() => {});
  vi.mocked(popoutEventService.onTerminalRequestSnapshot).mockResolvedValue(() => {});
  vi.mocked(popoutEventService.onTerminalClosed).mockResolvedValue(() => {});
  root = createRoot(document.createElement('div'));
  await act(async () => { root.render(createElement(Probe)); });
});
afterEach(async () => { await act(async () => { root.unmount(); }); });

describe('cross-window discard attribution', () => {
  it('requires explicit consent before a legacy unattributed whole-collection discard', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    updateEntityDraft<SendCommandSet>('sendCommandSets', 'b', { name: 'B main' });
    const snapshots = vi.mocked(popoutEventService.emitCommandEditorSnapshot).mock.calls;
    const sessionId = snapshots[snapshots.length - 1][0].sessionId;
    const request = vi.mocked(popoutEventService.onCommandEditorRequest).mock.calls[0][0];
    await act(async () => {
      request({ action: 'discard', version: getEntityEditorSnapshot('sendCommandSets').version, sessionId, requestId: 'legacy' });
      await settle();
    });
    expect(lastResult().success).toBe(false);
    expect(lastResult().snapshot.items).toEqual([a, { ...b, name: 'B main' }]);
    expect(confirm).toHaveBeenCalledOnce();
    confirm.mockRestore();
  });
  it('restores the main draft from before the panel edit rather than the persisted baseline', async () => {
    updateEntityDraft<SendCommandSet>('sendCommandSets', 'a', { name: 'A main draft' });
    const before = getEntityEditorSnapshot<SendCommandSet>('sendCommandSets');
    const snapshots = vi.mocked(popoutEventService.emitCommandEditorSnapshot).mock.calls;
    const sessionId = snapshots[snapshots.length - 1][0].sessionId;
    const request = vi.mocked(popoutEventService.onCommandEditorRequest).mock.calls[0][0];
    await act(async () => {
      request({ action: 'replace', items: [{ ...a, name: 'A panel' }, b], version: before.version, sessionId, requestId: 'replace', ids: ['a'] });
      await settle();
    });
    await act(async () => {
      request({ action: 'discard', version: getEntityEditorSnapshot('sendCommandSets').version, sessionId, requestId: 'discard', ids: ['a'] });
      await settle();
    });
    expect(lastResult().success).toBe(true);
    expect(lastResult().snapshot.items).toEqual([{ ...a, name: 'A main draft' }, b]);
    expect(lastResult().snapshot.dirty).toBe(true);
  });

  it('does not discard main text for a panel replace that was never accepted', async () => {
    const snapshots = vi.mocked(popoutEventService.emitCommandEditorSnapshot).mock.calls;
    const sessionId = snapshots[snapshots.length - 1][0].sessionId;
    const request = vi.mocked(popoutEventService.onCommandEditorRequest).mock.calls[0][0];
    updateEntityDraft<SendCommandSet>('sendCommandSets', 'a', { name: 'A main' });
    await act(async () => {
      request({ action: 'replace', items: [{ ...a, name: 'A panel' }, b], version: 0, sessionId, requestId: 'conflict', ids: ['a'] });
      await settle();
    });
    expect(lastResult().success).toBe(false);
    await act(async () => {
      request({ action: 'discard', version: getEntityEditorSnapshot('sendCommandSets').version, sessionId, requestId: 'discard', ids: ['a'] });
      await settle();
    });
    expect(lastResult().success).toBe(true);
    expect(lastResult().snapshot.items).toEqual([{ ...a, name: 'A main' }, b]);
  });

  it('uses a newly adopted main edit as the undo baseline for subsequent panel typing', async () => {
    const snapshots = vi.mocked(popoutEventService.emitCommandEditorSnapshot).mock.calls;
    const sessionId = snapshots[snapshots.length - 1][0].sessionId;
    const request = vi.mocked(popoutEventService.onCommandEditorRequest).mock.calls[0][0];
    await act(async () => {
      request({ action: 'replace', items: [{ ...a, name: 'A panel' }, b], version: 0, sessionId, requestId: 'first', ids: ['a'] });
      await settle();
    });
    updateEntityDraft<SendCommandSet>('sendCommandSets', 'a', { name: 'A main adopted' });
    await act(async () => {
      request({ action: 'replace', items: [{ ...a, name: 'A panel again' }, b], version: getEntityEditorSnapshot('sendCommandSets').version, sessionId, requestId: 'second', ids: ['a'] });
      await settle();
      request({ action: 'discard', version: getEntityEditorSnapshot('sendCommandSets').version, sessionId, requestId: 'discard', ids: ['a'] });
      await settle();
    });
    expect(lastResult().success).toBe(true);
    expect(lastResult().snapshot.items).toEqual([{ ...a, name: 'A main adopted' }, b]);
  });

  it('refuses to roll back a later main edit on the same command set', async () => {
    const snapshots = vi.mocked(popoutEventService.emitCommandEditorSnapshot).mock.calls;
    const sessionId = snapshots[snapshots.length - 1][0].sessionId;
    const request = vi.mocked(popoutEventService.onCommandEditorRequest).mock.calls[0][0];
    await act(async () => {
      request({ action: 'replace', items: [{ ...a, name: 'A panel' }, b], version: 0, sessionId, requestId: 'replace', ids: ['a'] });
      await settle();
    });
    updateEntityDraft<SendCommandSet>('sendCommandSets', 'a', { name: 'A main later' });
    await act(async () => {
      request({ action: 'discard', version: getEntityEditorSnapshot('sendCommandSets').version, sessionId, requestId: 'discard', ids: ['a'] });
      await settle();
    });
    expect(lastResult()).toMatchObject({ success: false, error: 'editor.conflict' });
    expect(lastResult().snapshot.items).toEqual([{ ...a, name: 'A main later' }, b]);
  });
  it('rolls back only the command sets reported by the panel and keeps main-window edits', async () => {
    const snapshots = vi.mocked(popoutEventService.emitCommandEditorSnapshot).mock.calls;
    const sessionId = snapshots[snapshots.length - 1][0].sessionId;
    const request = vi.mocked(popoutEventService.onCommandEditorRequest).mock.calls[0][0];
    const edited = [{ ...a, name: 'A panel' }, b];
    const replace: RequestWithIds = { action: 'replace', items: edited, version: 0, sessionId, requestId: 'r1', ids: ['a'] };
    await act(async () => { request(replace); await settle(); });
    expect(getEntityEditorSnapshot<SendCommandSet>('sendCommandSets').items[0].name).toBe('A panel');

    updateEntityDraft<SendCommandSet>('sendCommandSets', 'b', { name: 'B main' });
    const version = getEntityEditorSnapshot('sendCommandSets').version;
    const discard: RequestWithIds = { action: 'discard', version, sessionId, requestId: 'r2' };
    await act(async () => { request(discard); await settle(); });

    const result = lastResult();
    expect(result.success).toBe(true);
    expect(result.snapshot.items).toEqual([a, { ...b, name: 'B main' }]);
  });
});
