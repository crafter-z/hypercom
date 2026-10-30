// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorLeaveDialog } from './EditorLeaveDialog';
import {
  EDITOR_LEAVE_SAVE_TIMEOUT_MS, getEditorLeaveDialogState, registerEditorParticipant,
  requestEditorLeave, respondEditorLeave,
} from '../../utils/editorLeave';
import { insertEntityDraft, listDirtyEntityKinds, resetEntityEditorForTests } from '../../utils/entityEditor';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ label: 'main', destroy: vi.fn(async () => {}), onCloseRequested: vi.fn(async () => () => {}) }),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('../../services/tauri', () => ({
  systemService: { completeEditorClose: vi.fn(async () => {}), cancelEditorClose: vi.fn(async () => {}) },
}));
vi.mock('./usePluginViewOverlay', () => ({ usePluginViewOverlay: () => true }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
let dirty: boolean;
let discard: () => void;
let unregister: () => void;
function findButton(text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find(candidate => candidate.textContent === text);
  if (!button) throw new Error(`button ${text} not found`);
  return button as HTMLButtonElement;
}
beforeEach(async () => {
  vi.useFakeTimers();
  resetEntityEditorForTests();
  dirty = true;
  discard = vi.fn(() => { dirty = false; });
  unregister = registerEditorParticipant('hanging-save', {
    isDirty: () => dirty,
    save: () => new Promise<boolean>(() => {}),
    discard: () => discard(),
    label: () => 'Panel',
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(createElement(EditorLeaveDialog)); });
});
afterEach(async () => {
  await act(async () => { await respondEditorLeave('continue'); });
  unregister();
  await act(async () => { root.unmount(); });
  container.remove();
  vi.useRealTimers();
});

describe('editor leave save timeout escape hatch', () => {
  it('the force button survives a failing discard without clearing drafts outside the requested scope', async () => {
    discard = vi.fn(() => { throw new Error('offline panel'); });
    let leaving!: Promise<boolean>;
    await act(async () => { leaving = requestEditorLeave(['hanging-save']); });
    await act(async () => { await respondEditorLeave('discard'); });
    act(() => { insertEntityDraft('sendCommandSets', { id: 'outside', name: 'Outside', commands: [], isLoop: false, loopDelay: 0, repeatCount: 0 }); });
    await act(async () => { findButton('editor.discardAllAndClose').click(); });
    expect(await leaving).toBe(true);
    expect(getEditorLeaveDialogState().open).toBe(false);
    expect(listDirtyEntityKinds()).toEqual(['sendCommandSets']);
  });
  it('turns a hanging save into editor.saveFailed after 15s so the escape button can discard all', async () => {
    expect(EDITOR_LEAVE_SAVE_TIMEOUT_MS).toBe(15_000);
    let leaving!: Promise<boolean>;
    await act(async () => { leaving = requestEditorLeave(); });
    await act(async () => {
      const responding = respondEditorLeave('save');
      await vi.advanceTimersByTimeAsync(EDITOR_LEAVE_SAVE_TIMEOUT_MS);
      await responding;
    });
    expect(getEditorLeaveDialogState()).toMatchObject({ open: true, error: 'editor.saveFailed' });

    act(() => {
      insertEntityDraft('sendCommandSets', { id: 'set', name: 'Set', commands: [], isLoop: false, loopDelay: 0, repeatCount: 0 });
    });
    expect(listDirtyEntityKinds()).toEqual(['sendCommandSets']);

    const escape = findButton('editor.discardAllAndClose');
    await act(async () => {
      escape.click();
      await leaving;
    });
    expect(discard).toHaveBeenCalledTimes(1);
    expect(listDirtyEntityKinds()).toEqual([]);
    expect(await leaving).toBe(true);
    expect(getEditorLeaveDialogState().open).toBe(false);
  });
});
