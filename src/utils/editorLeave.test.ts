import { afterEach, describe, expect, it } from 'vitest';
import { getEditorLeaveDialogState, registerEditorParticipant, requestEditorLeave, respondEditorLeave } from './editorLeave';

const unregister: Array<() => void> = [];
afterEach(async () => {
  await respondEditorLeave('continue');
  unregister.splice(0).forEach(stop => stop());
});

describe('unsaved editor leave decisions', () => {
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
