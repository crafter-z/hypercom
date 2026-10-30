// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig, SendCommandSet } from '../types';
import { useAppStore } from '../stores/useAppStore';
import { useRuleStore } from '../stores/useRuleStore';
import { resetStoresForTests } from '../stores/resetStores';
import { configService } from '../services/tauri';
import { discardEntityDraft, getEntityEditorSnapshot, insertEntityDraft, removeEntityDraft, reorderEntityDraft, replaceEntityDraft, saveEntityDraft, updateEntityDraft } from './entityEditor';

vi.mock('../services/tauri', () => ({ configService: { getConfig: vi.fn(), setConfig: vi.fn() } }));
const set = (id: string, name = id): SendCommandSet => ({ id, name, commands: [], isLoop: false, loopDelay: 0, repeatCount: 0 });
let backend: AppConfig;
let revision: number;
const draft = () => getEntityEditorSnapshot<SendCommandSet>('sendCommandSets');
beforeEach(() => {
  vi.clearAllMocks();
  resetStoresForTests();
  revision = 0;
  backend = { ...useAppStore.getState().config, revision, sendCommandSets: [set('one'), set('two')] };
  useAppStore.getState().setConfig(backend);
  useRuleStore.getState().setSendCommandSets(backend.sendCommandSets);
  vi.mocked(configService.getConfig).mockImplementation(async () => structuredClone({ ...backend, revision }));
  vi.mocked(configService.setConfig).mockImplementation(async (candidate, _restore, expected) => {
    if (expected !== revision) return false;
    backend = structuredClone(candidate);
    revision++;
    return true;
  });
});

describe('session entity drafts versus saved runtime', () => {
  it('versions status-only save transitions so delayed saving snapshots cannot win', async () => {
    updateEntityDraft<SendCommandSet>('sendCommandSets', 'one', { name: 'submitted' });
    const before = draft();
    let finish!: () => void;
    vi.mocked(configService.setConfig).mockImplementationOnce(async candidate => {
      await new Promise<void>(resolve => { finish = resolve; });
      backend = structuredClone(candidate);
      revision++;
      return true;
    });
    const saving = saveEntityDraft('sendCommandSets');
    await vi.waitFor(() => expect(configService.setConfig).toHaveBeenCalledOnce());
    const inFlight = draft();
    expect(inFlight.saving).toBe(true);
    expect(inFlight.version).toBeGreaterThan(before.version);
    finish();
    expect(await saving).toBe(true);
    expect(draft().version).toBeGreaterThan(inFlight.version);
    expect(draft()).toMatchObject({ dirty: false, saving: false });
  });

  it('retains same-record conflicts on ordinary replacement but permits explicit overwrite', async () => {
    updateEntityDraft<SendCommandSet>('sendCommandSets', 'one', { name: 'local' });
    backend = { ...backend, sendCommandSets: [set('one', 'remote'), set('two')] };
    useAppStore.getState().setConfig({ sendCommandSets: backend.sendCommandSets });
    replaceEntityDraft('sendCommandSets', draft().items, draft().version);
    expect(await saveEntityDraft('sendCommandSets')).toBe(false);
    expect(draft().error).toBe('editor.conflict');
    replaceEntityDraft('sendCommandSets', draft().items, draft().version, true);
    expect(await saveEntityDraft('sendCommandSets')).toBe(true);
    expect(backend.sendCommandSets[0].name).toBe('local');
  });

  it('can save an unrelated record without clearing another record conflict', async () => {
    updateEntityDraft<SendCommandSet>('sendCommandSets', 'one', { name: 'local one' });
    backend = { ...backend, sendCommandSets: [set('one', 'remote one'), set('two')] };
    useAppStore.getState().setConfig({ sendCommandSets: backend.sendCommandSets });
    updateEntityDraft<SendCommandSet>('sendCommandSets', 'two', { name: 'saved two' });
    expect(await saveEntityDraft('sendCommandSets', 'two')).toBe(true);
    expect(backend.sendCommandSets.map(item => item.name)).toEqual(['remote one', 'saved two']);
    expect(draft().items.map(item => item.name)).toEqual(['local one', 'saved two']);
    expect(draft().error).toBe('editor.conflict');
    expect(await saveEntityDraft('sendCommandSets')).toBe(false);
  });
  it('saves just one entity without committing or losing other edits, additions, deletion or order', async () => {
    updateEntityDraft<SendCommandSet>('sendCommandSets', 'one', { name: 'saved one' });
    removeEntityDraft('sendCommandSets', 'two');
    insertEntityDraft('sendCommandSets', set('new'));
    reorderEntityDraft('sendCommandSets', ['new', 'one']);
    expect(useRuleStore.getState().sendCommandSets.map(item => item.name)).toEqual(['one', 'two']);
    expect(await saveEntityDraft('sendCommandSets', 'one')).toBe(true);
    expect(backend.sendCommandSets.map(item => item.name)).toEqual(['saved one', 'two']);
    expect(useRuleStore.getState().sendCommandSets).toEqual(backend.sendCommandSets);
    expect(draft().items.map(item => item.name)).toEqual(['new', 'saved one']);
    expect(draft().dirty).toBe(true);
    expect(await saveEntityDraft('sendCommandSets')).toBe(true);
    expect(backend.sendCommandSets.map(item => item.name)).toEqual(['new', 'saved one']);
    expect(draft().dirty).toBe(false);
  });

  it('discards one row without restoring another deletion or losing a newly inserted row', () => {
    updateEntityDraft<SendCommandSet>('sendCommandSets', 'one', { name: 'changed' });
    removeEntityDraft('sendCommandSets', 'two');
    insertEntityDraft('sendCommandSets', set('new'), 'one');
    discardEntityDraft('sendCommandSets', 'one');
    expect(draft().items.map(item => item.name)).toEqual(['new', 'one']);
    expect(draft().dirty).toBe(true);
    discardEntityDraft('sendCommandSets');
    expect(draft().items).toEqual(backend.sendCommandSets);
    expect(draft().dirty).toBe(false);
  });

  it('retains a newer edit while an accepted save is pending and never applies it to runtime prematurely', async () => {
    let finish!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    vi.mocked(configService.setConfig).mockImplementationOnce(async candidate => {
      await held;
      backend = structuredClone(candidate);
      revision++;
      return true;
    });
    updateEntityDraft<SendCommandSet>('sendCommandSets', 'one', { name: 'submitted' });
    const saving = saveEntityDraft('sendCommandSets');
    await vi.waitFor(() => expect(configService.setConfig).toHaveBeenCalledOnce());
    updateEntityDraft<SendCommandSet>('sendCommandSets', 'one', { name: 'newer' });
    finish();
    expect(await saving).toBe(true);
    expect(useRuleStore.getState().sendCommandSets[0].name).toBe('submitted');
    expect(draft().items[0].name).toBe('newer');
    expect(draft().dirty).toBe(true);
    expect(await saveEntityDraft('sendCommandSets')).toBe(true);
    expect(useRuleStore.getState().sendCommandSets[0].name).toBe('newer');
    expect(draft().dirty).toBe(false);
  });

  it('preserves a new local row across unrelated external changes and rejects same-row conflicts', async () => {
    insertEntityDraft('sendCommandSets', set('new'));
    backend = { ...backend, sendCommandSets: [set('one'), set('two', 'remote two')] };
    useAppStore.getState().setConfig({ sendCommandSets: backend.sendCommandSets });
    expect(draft().items.map(item => item.name)).toEqual(['one', 'remote two', 'new']);
    updateEntityDraft<SendCommandSet>('sendCommandSets', 'one', { name: 'local one' });
    backend = { ...backend, sendCommandSets: [set('one', 'remote one'), set('two', 'remote two')] };
    revision++;
    expect(await saveEntityDraft('sendCommandSets')).toBe(false);
    expect(draft().items[0].name).toBe('local one');
    expect(backend.sendCommandSets[0].name).toBe('remote one');
    expect(draft().error).toBe('editor.conflict');
  });

  it('allows incomplete draft fields but blocks saving invalid HEX until it is complete', async () => {
    const item = { ...set('one'), commands: [{ id: 'hex', name: 'HEX', content: 'A', order: 0, delay: 0, type: 'hex' as const, appendLineEnding: 'None' as const }] };
    replaceEntityDraft('sendCommandSets', [item]);
    expect(await saveEntityDraft('sendCommandSets')).toBe(false);
    expect(draft().items[0].commands[0].content).toBe('A');
    expect(useRuleStore.getState().sendCommandSets[0].commands).toEqual([]);
    replaceEntityDraft('sendCommandSets', [{ ...item, commands: [{ ...item.commands[0], content: 'AA' }] }]);
    expect(await saveEntityDraft('sendCommandSets')).toBe(true);
    expect(useRuleStore.getState().sendCommandSets[0].commands[0].content).toBe('AA');
  });

  it('persists collection-only sorting and ignores a duplicate-ID reorder without losing rows', async () => {
    reorderEntityDraft('sendCommandSets', ['one', 'one']);
    expect(draft().items.map(item => item.id)).toEqual(['one', 'two']);
    reorderEntityDraft('sendCommandSets', ['two', 'one']);
    expect(draft().dirty).toBe(true);
    expect(await saveEntityDraft('sendCommandSets')).toBe(true);
    expect(backend.sendCommandSets.map(item => item.id)).toEqual(['two', 'one']);
    expect(draft().dirty).toBe(false);
  });
});

it('accepts equivalent native JSON with different object property order on a later save', async () => {
  updateEntityDraft<SendCommandSet>('sendCommandSets', 'one', { name: 'first save' });
  expect(await saveEntityDraft('sendCommandSets')).toBe(true);
  backend.sendCommandSets = backend.sendCommandSets.map(item => Object.fromEntries(Object.entries(item).reverse()) as SendCommandSet);
  updateEntityDraft<SendCommandSet>('sendCommandSets', 'one', { name: 'second save' });
  expect(await saveEntityDraft('sendCommandSets')).toBe(true);
  expect(backend.sendCommandSets[0].name).toBe('second save');
  expect(draft().dirty).toBe(false);
});
