// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig, PortToolConfig, ProtocolTemplate, SendCommandSet, TriggerRule } from '../types';
import { useAppStore } from '../stores/useAppStore';
import { useRuleStore } from '../stores/useRuleStore';
import { useSystemStore } from '../stores/useSystemStore';
import { resetStoresForTests } from '../stores/resetStores';
import { configService } from '../services/tauri';
import { adoptEntityEditorBaselineFromConfig, commitEntityEditorDraft, discardEntityDraft, getEntityEditorSnapshot, prepareEntityCollectionForSave, reorderEntityDraft, replaceEntityDraft, resetEntityEditorForTests, saveEntityDraft, updateEntityDraft, validateEntityDraft } from './entityEditor';
import { writeEditorRecovery } from './entityEditorRecovery';
import { installRecoveryTestStorage } from './entityEditorRecovery.testSupport';
const recoveryStorage = installRecoveryTestStorage();

vi.mock('../services/tauri', () => ({ configService: { getConfig: vi.fn(), setConfig: vi.fn() } }));
const commandSet = (id: string, name = id): SendCommandSet => ({ id, name, commands: [], isLoop: false, loopDelay: 0, repeatCount: 0 });
const draft = () => getEntityEditorSnapshot<SendCommandSet>('sendCommandSets');
let backend: AppConfig;
beforeEach(() => {
  vi.clearAllMocks();
  resetStoresForTests();
  localStorage.clear();
  backend = { ...useAppStore.getState().config, revision: 1, sendCommandSets: [commandSet('one'), commandSet('two')] };
  useAppStore.getState().setConfig(backend);
  useRuleStore.getState().setSendCommandSets(backend.sendCommandSets);
  useSystemStore.getState().setUIState({ configReady: true });
  vi.mocked(configService.getConfig).mockImplementation(async () => structuredClone(backend));
  vi.mocked(configService.setConfig).mockImplementation(async candidate => { backend = structuredClone({ ...candidate, revision: (backend.revision ?? 0) + 1 }); return true; });
});

const protocol: ProtocolTemplate = {
  id: 'p', name: 'Protocol', isEnabled: true, headerBytes: '', footerBytes: '', lengthFieldOffset: 0,
  lengthFieldSize: 1, lengthEndian: 'little', lengthAdjust: 0, checksumAlgorithm: 'none', checksumOffset: 0,
  colorHeader: '', colorLength: '', colorPayload: '', colorChecksum: '', colorFooter: '',
};

describe('entity editor remaining validation boundaries', () => {
  it.each([0, 3, 1.5, NaN])('rejects invalid lengthFieldSize %s', lengthFieldSize => {
    expect(validateEntityDraft('protocolTemplates', [{ ...protocol, lengthFieldSize } as unknown as ProtocolTemplate])).toBe('editor.invalidProtocol');
  });
  it.each(['crc16', '', null])('rejects invalid checksumAlgorithm %s', checksumAlgorithm => {
    expect(validateEntityDraft('protocolTemplates', [{ ...protocol, checksumAlgorithm } as unknown as ProtocolTemplate])).toBe('editor.invalidProtocol');
  });
  it('rejects top-level and nested duplicate IDs, including a targeted save', async () => {
    replaceEntityDraft('sendCommandSets', [commandSet('one'), commandSet('one', 'duplicate')]);
    expect(await saveEntityDraft('sendCommandSets', 'one')).toBe(false);
    expect(configService.setConfig).not.toHaveBeenCalled();
    const command = { id: 'cmd', name: 'C', content: 'x', type: 'string' as const, appendLineEnding: 'None' as const, order: 0, delay: 0 };
    expect(validateEntityDraft('sendCommandSets', [{ ...commandSet('one'), commands: [command, command] } as SendCommandSet])).toBe('editor.invalidEntity');
  });
  it('checks port identity and uniqueness on the targeted persisted candidate', async () => {
    const tool = (id: string, portId: string): PortToolConfig => ({ id, name: id, portId, command: 'tool', workdir: '' });
    backend.portToolConfigs = [tool('a', 'COM1'), tool('b', 'COM2')];
    useAppStore.getState().setConfig({ portToolConfigs: backend.portToolConfigs });
    useRuleStore.getState().setPortToolConfigs(backend.portToolConfigs);
    updateEntityDraft<PortToolConfig>('portToolConfigs', 'b', { portId: 'COM1' });
    expect(await saveEntityDraft('portToolConfigs', 'b')).toBe(false);
    expect(getEntityEditorSnapshot('portToolConfigs').error).toBe('editor.invalidEntity');
    updateEntityDraft<PortToolConfig>('portToolConfigs', 'b', { portId: '' });
    expect(await saveEntityDraft('portToolConfigs', 'b')).toBe(false);
    expect(configService.setConfig).not.toHaveBeenCalled();
  });
  it('opens a normalized legacy trigger baseline without manufacturing a dirty draft', () => {
    const trigger: TriggerRule = { id: 'legacy', name: 'Legacy', pattern: 'x', isRegex: false, matchType: 'contains', actionType: 'alert', actionContent: '', actionIsHex: false, isEnabled: true };
    useAppStore.getState().setConfig({ triggerRules: [trigger] });
    useRuleStore.getState().setTriggerRules([trigger]);
    expect(getEntityEditorSnapshot('triggerRules')).toMatchObject({ items: [trigger], dirty: false, error: null });
  });
});

describe('prepare / commit / adopt and late edits', () => {
  it('prepares a three-way candidate without committing runtime, then commits only after acknowledgement', () => {
    updateEntityDraft<SendCommandSet>('sendCommandSets', 'one', { name: 'local' });
    const remote = [commandSet('one'), commandSet('two', 'remote'), commandSet('three')];
    const prepared = prepareEntityCollectionForSave('sendCommandSets', remote);
    expect(prepared.items).toEqual([commandSet('one', 'local'), commandSet('two', 'remote'), commandSet('three')]);
    expect(useRuleStore.getState().sendCommandSets).toEqual(backend.sendCommandSets);
    commitEntityEditorDraft('sendCommandSets', prepared.items, prepared.version, 2);
    expect(draft().dirty).toBe(false);
    expect(useRuleStore.getState().sendCommandSets).toEqual(prepared.items);
    expect(useAppStore.getState().config.sendCommandSets).toEqual(prepared.items);
  });
  it('retains local-only order when the runtime store changes independently', () => {
    reorderEntityDraft('sendCommandSets', ['two', 'one']);
    useRuleStore.getState().setSendCommandSets([commandSet('one', 'runtime'), commandSet('two')]);
    expect(draft().items.map(item => item.id)).toEqual(['two', 'one']);
    expect(draft().dirty).toBe(true);
  });
  it.each([undefined, 'one'])('retains an intentional revert while save(%s) is in flight', async id => {
    let release!: () => void;
    vi.mocked(configService.setConfig).mockImplementationOnce(async candidate => {
      await new Promise<void>(resolve => { release = resolve; });
      backend = { ...candidate, revision: 2 }; return true;
    });
    updateEntityDraft<SendCommandSet>('sendCommandSets', 'one', { name: 'submitted' });
    const saving = saveEntityDraft('sendCommandSets', id);
    await vi.waitFor(() => expect(configService.setConfig).toHaveBeenCalledOnce());
    updateEntityDraft<SendCommandSet>('sendCommandSets', 'one', { name: 'one' });
    release();
    expect(await saving).toBe(true);
    expect(backend.sendCommandSets[0].name).toBe('submitted');
    expect(draft().items[0].name).toBe('one');
    expect(draft().dirty).toBe(true);
  });
  it('uses the prepared snapshot, not the old baseline, when full-save edits are reverted', () => {
    updateEntityDraft<SendCommandSet>('sendCommandSets', 'one', { name: 'submitted' });
    const prepared = prepareEntityCollectionForSave('sendCommandSets', backend.sendCommandSets);
    updateEntityDraft<SendCommandSet>('sendCommandSets', 'one', { name: 'one' });
    commitEntityEditorDraft('sendCommandSets', prepared.items, prepared.version, 2);
    expect(draft().items[0].name).toBe('one');
    expect(draft().dirty).toBe(true);
    expect(useRuleStore.getState().sendCommandSets[0].name).toBe('submitted');
  });
  it('adopts a known baseline without an in-flight old save overwriting it', async () => {
    let release!: () => void;
    vi.mocked(configService.setConfig).mockImplementationOnce(() => new Promise<boolean>(resolve => { release = () => resolve(true); }));
    updateEntityDraft<SendCommandSet>('sendCommandSets', 'one', { name: 'old submission' });
    const saving = saveEntityDraft('sendCommandSets');
    await vi.waitFor(() => expect(configService.setConfig).toHaveBeenCalledOnce());
    const imported = { ...backend, revision: 10, sendCommandSets: [commandSet('imported')] };
    adoptEntityEditorBaselineFromConfig(imported);
    release();
    expect(await saving).toBe(false);
    expect(draft()).toMatchObject({ items: imported.sendCommandSets, dirty: false, saving: false });
    expect(useAppStore.getState().config.revision).toBe(10);
    expect(useRuleStore.getState().sendCommandSets).toEqual(imported.sendCommandSets);
    commitEntityEditorDraft('sendCommandSets', [commandSet('late')], undefined, 2);
    expect(draft().items).toEqual(imported.sendCommandSets);
  });
});

describe('crash/session-end draft recovery', () => {
  it('waits for the real startup baseline instead of treating defaults as remote deletions', () => {
    updateEntityDraft<SendCommandSet>('sendCommandSets', 'one', { name: 'recovered local' });
    resetEntityEditorForTests(true);
    useSystemStore.getState().setUIState({ configReady: false });
    useAppStore.getState().setConfig({ sendCommandSets: [] });
    useRuleStore.getState().setSendCommandSets([]);
    expect(draft().items[0].name).toBe('recovered local');
    useAppStore.getState().setConfig(backend);
    useRuleStore.getState().setSendCommandSets(backend.sendCommandSets);
    useSystemStore.getState().setUIState({ configReady: true });
    expect(draft()).toMatchObject({ dirty: true, error: null });
    expect(draft().items).toEqual([commandSet('one', 'recovered local'), commandSet('two')]);
  });
  it('reconciles the recorded baseline with today’s backend, without promoting local text to runtime', () => {
    updateEntityDraft<SendCommandSet>('sendCommandSets', 'one', { name: 'recovered local' });
    resetEntityEditorForTests(true);
    const remote = [commandSet('one'), commandSet('two', 'remote'), commandSet('three')];
    useAppStore.getState().setConfig({ sendCommandSets: remote });
    useRuleStore.getState().setSendCommandSets(remote);
    expect(draft().items).toEqual([commandSet('one', 'recovered local'), commandSet('two', 'remote'), commandSet('three')]);
    expect(draft().dirty).toBe(true);
    expect(useRuleStore.getState().sendCommandSets).toEqual(remote);
    expect(configService.setConfig).not.toHaveBeenCalled();
  });
  it('keeps a recovered same-record conflict visible until explicitly resolved or discarded', async () => {
    updateEntityDraft<SendCommandSet>('sendCommandSets', 'one', { name: 'recovered local' });
    resetEntityEditorForTests(true);
    const remote = [commandSet('one', 'remote'), commandSet('two')];
    backend = { ...backend, sendCommandSets: remote, revision: 2 };
    useAppStore.getState().setConfig(backend);
    useRuleStore.getState().setSendCommandSets(remote);
    expect(draft()).toMatchObject({ dirty: true, error: 'editor.conflict' });
    expect(await saveEntityDraft('sendCommandSets')).toBe(false);
    discardEntityDraft('sendCommandSets');
    expect(draft()).toMatchObject({ items: remote, dirty: false, error: null });
    expect(localStorage.getItem('hypercom.editor-recovery.sendCommandSets')).toBeNull();
  });
  it('retains incomplete HEX text but still blocks persistence validation', async () => {
    const incomplete = { ...commandSet('one'), commands: [{ id: 'hex', name: 'H', order: 0, delay: 0, type: 'hex' as const, content: 'A', appendLineEnding: 'None' as const }] };
    replaceEntityDraft('sendCommandSets', [incomplete]);
    resetEntityEditorForTests(true);
    expect(draft().items).toEqual([incomplete]);
    expect(await saveEntityDraft('sendCommandSets')).toBe(false);
    expect(draft().error).toBe('editor.invalidHex');
  });
  it.each([
    '{broken', JSON.stringify({ schema: 0, payload: {} }),
    JSON.stringify({ schema: 1, payload: {}, extra: true }),
    JSON.stringify({ schema: 1, payload: { baseline: [], draft: [], conflicts: [], pluginConfigs: [] } }),
  ])('ignores corrupt, old and foreign recovery data: %s', raw => {
    localStorage.setItem('hypercom.editor-recovery.sendCommandSets', raw);
    expect(draft()).toMatchObject({ items: backend.sendCommandSets, dirty: false });
  });
  it('rejects unknown entity fields and remains usable when storage writes fail', () => {
    writeEditorRecovery('sendCommandSets', { baseline: backend.sendCommandSets, draft: [{ ...commandSet('one'), permissions: ['all'] }], conflicts: [] });
    expect(draft().dirty).toBe(false);
    const denied = vi.spyOn(recoveryStorage, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    expect(() => updateEntityDraft<SendCommandSet>('sendCommandSets', 'one', { name: 'still editable' })).not.toThrow();
    expect(draft().items[0].name).toBe('still editable');
    denied.mockRestore();
  });
});
