import { afterEach, describe, expect, it, vi } from 'vitest';
import { EDITOR_LEAVE_SAVE_TIMEOUT_MS, forceDiscardEditorLeave, getEditorLeaveDialogState, registerEditorParticipant, requestEditorLeave, respondEditorLeave } from './editorLeave';

const unregister: Array<() => void> = [];
afterEach(async () => {
  await respondEditorLeave('continue');
  unregister.splice(0).forEach(stop => stop());
  vi.useRealTimers();
});

describe('unsaved editor leave decisions', () => {
  it('times out a hanging discard and force-closes without awaiting it again', async () => {
    vi.useFakeTimers();
    const discard = vi.fn(() => new Promise<void>(() => {}));
    unregister.push(registerEditorParticipant('stuck-discard', {
      isDirty: () => true, label: () => 'Panel', save: async () => false, discard,
    }));
    const leaving = requestEditorLeave(['stuck-discard']);
    const response = respondEditorLeave('discard');
    await vi.advanceTimersByTimeAsync(EDITOR_LEAVE_SAVE_TIMEOUT_MS);
    await response;
    expect(getEditorLeaveDialogState().error).toBe('editor.saveFailed');
    expect(await forceDiscardEditorLeave()).toBe(true);
    expect(await leaving).toBe(true);
    expect(discard).toHaveBeenCalledTimes(2);
    expect(getEditorLeaveDialogState().open).toBe(false);
  });

  it('force discard stays in the requested scope and ignores a throwing participant', async () => {
    const unrelated = vi.fn();
    unregister.push(registerEditorParticipant('scoped', {
      isDirty: () => true, label: () => 'Settings', save: async () => false,
      discard: () => { throw new Error('offline'); },
    }));
    unregister.push(registerEditorParticipant('unrelated', {
      isDirty: () => true, label: () => 'Commands', save: async () => false, discard: unrelated,
    }));
    const leaving = requestEditorLeave(['scoped']);
    await forceDiscardEditorLeave();
    expect(await leaving).toBe(true);
    expect(unrelated).not.toHaveBeenCalled();
  });

  it('does not call a clean remote participant during ordinary discard', async () => {
    let dirty = true;
    const cleanDiscard = vi.fn(async () => { throw new Error('no panel'); });
    unregister.push(registerEditorParticipant('dirty-local', {
      isDirty: () => dirty, label: () => 'Settings', save: async () => false, discard: () => { dirty = false; },
    }));
    unregister.push(registerEditorParticipant('clean-remote', {
      isDirty: () => false, label: () => 'Panel', save: async () => false, discard: cleanDiscard,
    }));
    const leaving = requestEditorLeave();
    await respondEditorLeave('discard');
    expect(await leaving).toBe(true);
    expect(cleanDiscard).not.toHaveBeenCalled();
  });

  it('ignores a late failed approval after force-close without corrupting a new prompt', async () => {
    let finish!: (value: boolean) => void;
    unregister.push(registerEditorParticipant('late-failure', {
      isDirty: () => true, label: () => 'Panel', save: () => new Promise(resolve => { finish = resolve; }), discard: () => {},
    }));
    const first = requestEditorLeave();
    const response = respondEditorLeave('save');
    await Promise.resolve();
    await forceDiscardEditorLeave();
    expect(await first).toBe(true);
    const second = requestEditorLeave();
    finish(false);
    await response;
    expect(getEditorLeaveDialogState()).toMatchObject({ open: true, error: null });
    await respondEditorLeave('continue');
    expect(await second).toBe(false);
  });
  it('keeps failed saves visible and lets the user retry without resolving close early', async () => {
    let dirty = true;
    let diskAvailable = false;
    unregister.push(registerEditorParticipant('failed-save', {
      isDirty: () => dirty, label: () => 'Commands',
      save: async () => { if (!diskAvailable) return false; dirty = false; return true; },
      discard: () => { dirty = false; },
    }));
    const leaving = requestEditorLeave();
    await respondEditorLeave('save');
    expect(getEditorLeaveDialogState()).toMatchObject({ open: true, error: 'editor.saveFailed' });
    expect(dirty).toBe(true);
    diskAvailable = true;
    await respondEditorLeave('save');
    expect(await leaving).toBe(true);
    expect(getEditorLeaveDialogState().open).toBe(false);
  });

  it('does not close over a newer edit made after the saved snapshot was captured', async () => {
    let dirty = true;
    let finish!: () => void;
    const disk = new Promise<void>(resolve => { finish = resolve; });
    unregister.push(registerEditorParticipant('late-edit', {
      isDirty: () => dirty, label: () => 'Rules', save: async () => { await disk; return true; }, discard: () => { dirty = false; },
    }));
    const leaving = requestEditorLeave();
    const saving = respondEditorLeave('save');
    finish();
    await saving;
    expect(getEditorLeaveDialogState().open).toBe(true);
    await respondEditorLeave('continue');
    expect(await leaving).toBe(false);
    expect(dirty).toBe(true);
  });

  it('waits for asynchronous discard acknowledgement before approving close', async () => {
    let dirty = true;
    let acknowledge!: () => void;
    const host = new Promise<void>(resolve => { acknowledge = resolve; });
    unregister.push(registerEditorParticipant('remote-discard', {
      isDirty: () => dirty, label: () => 'Panel', save: async () => false,
      discard: async () => { await host; dirty = false; },
    }));
    const leaving = requestEditorLeave();
    const discarding = respondEditorLeave('discard');
    expect(getEditorLeaveDialogState().open).toBe(true);
    acknowledge();
    await discarding;
    expect(await leaving).toBe(true);
    expect(dirty).toBe(false);
  });

  it('upgrades a settings-only prompt to app-exit scope without losing a newly dirty panel', async () => {
    let settingsDirty = true;
    let panelDirty = false;
    let finish!: () => void;
    const disk = new Promise<void>(resolve => { finish = resolve; });
    unregister.push(registerEditorParticipant('settings', {
      isDirty: () => settingsDirty, label: () => 'Settings',
      save: async () => { await disk; settingsDirty = false; return true; }, discard: () => { settingsDirty = false; },
    }));
    unregister.push(registerEditorParticipant('panel', {
      isDirty: () => panelDirty, label: () => 'Panel', save: async () => false, discard: () => { panelDirty = false; },
    }));
    const settingsClose = requestEditorLeave(['settings']);
    const saving = respondEditorLeave('save');
    panelDirty = true;
    const appExit = requestEditorLeave();
    finish();
    await saving;
    expect(getEditorLeaveDialogState().open).toBe(true);
    await respondEditorLeave('continue');
    expect(await settingsClose).toBe(false);
    expect(await appExit).toBe(false);
    expect(panelDirty).toBe(true);
  });
});
