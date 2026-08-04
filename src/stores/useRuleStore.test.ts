import { describe, it, expect, beforeEach } from 'vitest';
import { useRuleStore } from './useRuleStore';
import type { HighlightRuleSet, SendCommandSet, ProtocolTemplate, PortToolConfig, TriggerRule } from '../types';

beforeEach(() => {
  useRuleStore.setState({
    highlightRuleSets: [],
    activeHighlightSetId: null,
    protocolTemplates: [],
    activeProtocolTemplateId: null,
    sendCommandSets: [],
    activeSendCommandSetId: null,
    portToolConfigs: [],
    triggerRules: [],
  });
});

// Helpers
const makeHighlightSet = (id: string, overrides?: Partial<HighlightRuleSet>): HighlightRuleSet => ({
  id, name: `Set ${id}`, rules: [], isEnabled: true, ...overrides,
});
const makeCmdSet = (id: string, overrides?: Partial<SendCommandSet>): SendCommandSet => ({
  id, name: `Cmd ${id}`, commands: [], isLoop: false, loopDelay: 100, repeatCount: 0, ...overrides,
});
const makeProtocol = (id: string, overrides?: Partial<ProtocolTemplate>): ProtocolTemplate => ({
  id, name: `Proto ${id}`, isEnabled: true,
  headerBytes: 'AA BB', lengthFieldOffset: 2, lengthFieldSize: 1,
  lengthEndian: 'big', lengthAdjust: 0, checksumAlgorithm: 'none',
  checksumOffset: 0, footerBytes: '',
  colorHeader: '#ff0000', colorLength: '#00ff00', colorPayload: '#0000ff',
  colorChecksum: '#ffff00', colorFooter: '#ff00ff',
  ...overrides,
});
const makeToolConfig = (id: string, overrides?: Partial<PortToolConfig>): PortToolConfig => ({
  id, name: `Tool ${id}`, portId: 'COM1', command: 'flash.exe {port}', workdir: '', ...overrides,
});

// ==================== Highlight Rule Sets ====================

describe('Highlight Rule Set CRUD', () => {
  it('setHighlightRuleSets replaces the entire array', () => {
    useRuleStore.getState().addHighlightRuleSet(makeHighlightSet('h1'));
    useRuleStore.getState().setHighlightRuleSets([makeHighlightSet('h2'), makeHighlightSet('h3')]);
    const sets = useRuleStore.getState().highlightRuleSets;
    expect(sets).toHaveLength(2);
    expect(sets.map(s => s.id)).toEqual(['h2', 'h3']);
  });

  it('addHighlightRuleSet appends to the array', () => {
    useRuleStore.getState().addHighlightRuleSet(makeHighlightSet('h1'));
    useRuleStore.getState().addHighlightRuleSet(makeHighlightSet('h2'));
    expect(useRuleStore.getState().highlightRuleSets).toHaveLength(2);
  });

  it('updateHighlightRuleSet patches existing set', () => {
    useRuleStore.getState().addHighlightRuleSet(makeHighlightSet('h1'));
    useRuleStore.getState().updateHighlightRuleSet('h1', { name: 'Renamed', isEnabled: false });
    const s = useRuleStore.getState().highlightRuleSets[0];
    expect(s.name).toBe('Renamed');
    expect(s.isEnabled).toBe(false);
  });

  it('updateHighlightRuleSet is no-op for unknown id', () => {
    useRuleStore.getState().addHighlightRuleSet(makeHighlightSet('h1'));
    useRuleStore.getState().updateHighlightRuleSet('ghost', { isEnabled: false });
    expect(useRuleStore.getState().highlightRuleSets[0].isEnabled).toBe(true);
  });

  it('removeHighlightRuleSet deletes the correct set', () => {
    useRuleStore.getState().addHighlightRuleSet(makeHighlightSet('h1'));
    useRuleStore.getState().addHighlightRuleSet(makeHighlightSet('h2'));
    useRuleStore.getState().removeHighlightRuleSet('h1');
    const sets = useRuleStore.getState().highlightRuleSets;
    expect(sets).toHaveLength(1);
    expect(sets[0].id).toBe('h2');
  });

  it('removeHighlightRuleSet falls back activeHighlightSetId to first remaining', () => {
    useRuleStore.getState().addHighlightRuleSet(makeHighlightSet('h1'));
    useRuleStore.getState().addHighlightRuleSet(makeHighlightSet('h2'));
    useRuleStore.getState().setActiveHighlightSetId('h1');
    useRuleStore.getState().removeHighlightRuleSet('h1');
    expect(useRuleStore.getState().activeHighlightSetId).toBe('h2');
  });

  it('removeHighlightRuleSet sets activeHighlightSetId to null when last removed', () => {
    useRuleStore.getState().addHighlightRuleSet(makeHighlightSet('h1'));
    useRuleStore.getState().setActiveHighlightSetId('h1');
    useRuleStore.getState().removeHighlightRuleSet('h1');
    expect(useRuleStore.getState().activeHighlightSetId).toBeNull();
  });

  it('removeHighlightRuleSet does not change activeHighlightSetId if not removed', () => {
    useRuleStore.getState().addHighlightRuleSet(makeHighlightSet('h1'));
    useRuleStore.getState().addHighlightRuleSet(makeHighlightSet('h2'));
    useRuleStore.getState().setActiveHighlightSetId('h2');
    useRuleStore.getState().removeHighlightRuleSet('h1');
    expect(useRuleStore.getState().activeHighlightSetId).toBe('h2');
  });

  it('removeHighlightRuleSet is no-op for unknown id', () => {
    useRuleStore.getState().addHighlightRuleSet(makeHighlightSet('h1'));
    useRuleStore.getState().removeHighlightRuleSet('ghost');
    expect(useRuleStore.getState().highlightRuleSets).toHaveLength(1);
  });

  it('setActiveHighlightSetId updates active id', () => {
    useRuleStore.getState().setActiveHighlightSetId('h1');
    expect(useRuleStore.getState().activeHighlightSetId).toBe('h1');
    useRuleStore.getState().setActiveHighlightSetId(null);
    expect(useRuleStore.getState().activeHighlightSetId).toBeNull();
  });
});

// ==================== Send Command Sets ====================

describe('Send Command Set CRUD', () => {
  it('setSendCommandSets replaces the entire array', () => {
    useRuleStore.getState().addSendCommandSet(makeCmdSet('s1'));
    useRuleStore.getState().setSendCommandSets([makeCmdSet('s2')]);
    expect(useRuleStore.getState().sendCommandSets.map(s => s.id)).toEqual(['s2']);
  });

  it('addSendCommandSet appends to the array', () => {
    useRuleStore.getState().addSendCommandSet(makeCmdSet('s1'));
    useRuleStore.getState().addSendCommandSet(makeCmdSet('s2'));
    expect(useRuleStore.getState().sendCommandSets).toHaveLength(2);
  });

  it('updateSendCommandSet patches existing set', () => {
    useRuleStore.getState().addSendCommandSet(makeCmdSet('s1'));
    useRuleStore.getState().updateSendCommandSet('s1', { name: 'New', isLoop: true, loopDelay: 500 });
    const s = useRuleStore.getState().sendCommandSets[0];
    expect(s.name).toBe('New');
    expect(s.isLoop).toBe(true);
    expect(s.loopDelay).toBe(500);
  });

  it('updateSendCommandSet is no-op for unknown id', () => {
    useRuleStore.getState().addSendCommandSet(makeCmdSet('s1'));
    useRuleStore.getState().updateSendCommandSet('ghost', { isLoop: true });
    expect(useRuleStore.getState().sendCommandSets[0].isLoop).toBe(false);
  });

  it('removeSendCommandSet deletes the correct set', () => {
    useRuleStore.getState().addSendCommandSet(makeCmdSet('s1'));
    useRuleStore.getState().addSendCommandSet(makeCmdSet('s2'));
    useRuleStore.getState().removeSendCommandSet('s1');
    expect(useRuleStore.getState().sendCommandSets.map(s => s.id)).toEqual(['s2']);
  });

  it('removeSendCommandSet falls back activeSendCommandSetId to first remaining', () => {
    useRuleStore.getState().addSendCommandSet(makeCmdSet('s1'));
    useRuleStore.getState().addSendCommandSet(makeCmdSet('s2'));
    useRuleStore.getState().setActiveSendCommandSetId('s1');
    useRuleStore.getState().removeSendCommandSet('s1');
    expect(useRuleStore.getState().activeSendCommandSetId).toBe('s2');
  });

  it('removeSendCommandSet sets activeSendCommandSetId to null when last removed', () => {
    useRuleStore.getState().addSendCommandSet(makeCmdSet('s1'));
    useRuleStore.getState().setActiveSendCommandSetId('s1');
    useRuleStore.getState().removeSendCommandSet('s1');
    expect(useRuleStore.getState().activeSendCommandSetId).toBeNull();
  });

  it('removeSendCommandSet is no-op for unknown id', () => {
    useRuleStore.getState().addSendCommandSet(makeCmdSet('s1'));
    useRuleStore.getState().removeSendCommandSet('ghost');
    expect(useRuleStore.getState().sendCommandSets).toHaveLength(1);
  });

  it('setActiveSendCommandSetId updates active id', () => {
    useRuleStore.getState().setActiveSendCommandSetId('s1');
    expect(useRuleStore.getState().activeSendCommandSetId).toBe('s1');
  });

  it('setSendCommandSets auto-selects first set when active is null', () => {
    useRuleStore.getState().setSendCommandSets([makeCmdSet('s1'), makeCmdSet('s2')]);
    expect(useRuleStore.getState().activeSendCommandSetId).toBe('s1');
  });

  it('setSendCommandSets preserves a still-valid active selection', () => {
    useRuleStore.getState().setSendCommandSets([makeCmdSet('s1'), makeCmdSet('s2')]);
    useRuleStore.getState().setActiveSendCommandSetId('s2');
    useRuleStore.getState().setSendCommandSets([makeCmdSet('s1'), makeCmdSet('s2')]);
    expect(useRuleStore.getState().activeSendCommandSetId).toBe('s2');
  });

  it('setSendCommandSets falls back to first when active no longer exists', () => {
    useRuleStore.getState().setSendCommandSets([makeCmdSet('s1')]);
    useRuleStore.getState().setSendCommandSets([makeCmdSet('s2')]);
    expect(useRuleStore.getState().activeSendCommandSetId).toBe('s2');
  });

  it('setSendCommandSets sets active to null when given empty array', () => {
    useRuleStore.getState().setSendCommandSets([makeCmdSet('s1')]);
    useRuleStore.getState().setSendCommandSets([]);
    expect(useRuleStore.getState().activeSendCommandSetId).toBeNull();
  });

  it('addSendCommandSet activates the first added set', () => {
    useRuleStore.getState().addSendCommandSet(makeCmdSet('s1'));
    expect(useRuleStore.getState().activeSendCommandSetId).toBe('s1');
  });

  it('addSendCommandSet keeps existing active selection', () => {
    useRuleStore.getState().addSendCommandSet(makeCmdSet('s1'));
    useRuleStore.getState().addSendCommandSet(makeCmdSet('s2'));
    expect(useRuleStore.getState().activeSendCommandSetId).toBe('s1');
  });
});

// ==================== Protocol Templates ====================

describe('Protocol Template CRUD', () => {
  it('setProtocolTemplates replaces the entire array', () => {
    useRuleStore.getState().addProtocolTemplate(makeProtocol('p1'));
    useRuleStore.getState().setProtocolTemplates([makeProtocol('p2')]);
    expect(useRuleStore.getState().protocolTemplates.map(t => t.id)).toEqual(['p2']);
  });

  it('addProtocolTemplate appends to the array', () => {
    useRuleStore.getState().addProtocolTemplate(makeProtocol('p1'));
    useRuleStore.getState().addProtocolTemplate(makeProtocol('p2'));
    expect(useRuleStore.getState().protocolTemplates).toHaveLength(2);
  });

  it('updateProtocolTemplate patches existing template', () => {
    useRuleStore.getState().addProtocolTemplate(makeProtocol('p1'));
    useRuleStore.getState().updateProtocolTemplate('p1', {
      name: 'Updated',
      checksumAlgorithm: 'crc8',
      isEnabled: false,
    });
    const t = useRuleStore.getState().protocolTemplates[0];
    expect(t.name).toBe('Updated');
    expect(t.checksumAlgorithm).toBe('crc8');
    expect(t.isEnabled).toBe(false);
  });

  it('updateProtocolTemplate is no-op for unknown id', () => {
    useRuleStore.getState().addProtocolTemplate(makeProtocol('p1'));
    useRuleStore.getState().updateProtocolTemplate('ghost', { isEnabled: false });
    expect(useRuleStore.getState().protocolTemplates[0].isEnabled).toBe(true);
  });

  it('removeProtocolTemplate deletes the correct template', () => {
    useRuleStore.getState().addProtocolTemplate(makeProtocol('p1'));
    useRuleStore.getState().addProtocolTemplate(makeProtocol('p2'));
    useRuleStore.getState().removeProtocolTemplate('p1');
    expect(useRuleStore.getState().protocolTemplates.map(t => t.id)).toEqual(['p2']);
  });

  it('removeProtocolTemplate is no-op for unknown id', () => {
    useRuleStore.getState().addProtocolTemplate(makeProtocol('p1'));
    useRuleStore.getState().removeProtocolTemplate('ghost');
    expect(useRuleStore.getState().protocolTemplates).toHaveLength(1);
  });

  it('setActiveProtocolTemplateId updates active id', () => {
    useRuleStore.getState().setActiveProtocolTemplateId('p1');
    expect(useRuleStore.getState().activeProtocolTemplateId).toBe('p1');
    useRuleStore.getState().setActiveProtocolTemplateId(null);
    expect(useRuleStore.getState().activeProtocolTemplateId).toBeNull();
  });
});

// ==================== Port Tool Configs ====================

describe('Port Tool Config CRUD', () => {
  it('setPortToolConfigs replaces the entire array', () => {
    useRuleStore.getState().addPortToolConfig(makeToolConfig('t1'));
    useRuleStore.getState().setPortToolConfigs([makeToolConfig('t2')]);
    expect(useRuleStore.getState().portToolConfigs.map(c => c.id)).toEqual(['t2']);
  });

  it('addPortToolConfig appends to the array', () => {
    useRuleStore.getState().addPortToolConfig(makeToolConfig('t1'));
    useRuleStore.getState().addPortToolConfig(makeToolConfig('t2'));
    expect(useRuleStore.getState().portToolConfigs).toHaveLength(2);
  });

  it('updatePortToolConfig patches existing config', () => {
    useRuleStore.getState().addPortToolConfig(makeToolConfig('t1'));
    useRuleStore.getState().updatePortToolConfig('t1', {
      name: 'STM32 Flash',
      command: 'stm32flash -w fw.bin {port}',
      workdir: 'C:\\tools',
    });
    const c = useRuleStore.getState().portToolConfigs[0];
    expect(c.name).toBe('STM32 Flash');
    expect(c.command).toBe('stm32flash -w fw.bin {port}');
    expect(c.workdir).toBe('C:\\tools');
  });

  it('updatePortToolConfig is no-op for unknown id', () => {
    useRuleStore.getState().addPortToolConfig(makeToolConfig('t1'));
    useRuleStore.getState().updatePortToolConfig('ghost', { name: 'X' });
    expect(useRuleStore.getState().portToolConfigs[0].name).toBe('Tool t1');
  });

  it('removePortToolConfig deletes the correct config', () => {
    useRuleStore.getState().addPortToolConfig(makeToolConfig('t1'));
    useRuleStore.getState().addPortToolConfig(makeToolConfig('t2'));
    useRuleStore.getState().removePortToolConfig('t1');
    expect(useRuleStore.getState().portToolConfigs.map(c => c.id)).toEqual(['t2']);
  });

  it('removePortToolConfig is no-op for unknown id', () => {
    useRuleStore.getState().addPortToolConfig(makeToolConfig('t1'));
    useRuleStore.getState().removePortToolConfig('ghost');
    expect(useRuleStore.getState().portToolConfigs).toHaveLength(1);
  });

  it('findToolConfigByPort returns matching config', () => {
    useRuleStore.getState().addPortToolConfig(makeToolConfig('t1', { portId: 'COM3' }));
    useRuleStore.getState().addPortToolConfig(makeToolConfig('t2', { portId: 'COM5' }));
    const found = useRuleStore.getState().findToolConfigByPort('COM5');
    expect(found).toBeDefined();
    expect(found!.id).toBe('t2');
  });

  it('findToolConfigByPort returns undefined for unmatched port', () => {
    useRuleStore.getState().addPortToolConfig(makeToolConfig('t1', { portId: 'COM3' }));
    expect(useRuleStore.getState().findToolConfigByPort('COM99')).toBeUndefined();
  });

  it('findToolConfigByPort returns first match when multiple configs share portId', () => {
    useRuleStore.getState().addPortToolConfig(makeToolConfig('t1', { portId: 'COM3' }));
    useRuleStore.getState().addPortToolConfig(makeToolConfig('t2', { portId: 'COM3' }));
    const found = useRuleStore.getState().findToolConfigByPort('COM3');
    expect(found!.id).toBe('t1');
  });
});

// ==================== Trigger Rule CRUD ====================

const makeTriggerRule = (id: string, overrides?: Partial<TriggerRule>): TriggerRule => ({
  id, name: `Rule ${id}`, pattern: 'ERROR', isRegex: false, matchType: 'contains',
  actionType: 'alert', actionContent: '', actionIsHex: false, isEnabled: true,
  ...overrides,
});

describe('Trigger Rule CRUD', () => {
  it('setTriggerRules replaces the entire array', () => {
    useRuleStore.getState().setTriggerRules([makeTriggerRule('t1')]);
    useRuleStore.getState().setTriggerRules([makeTriggerRule('t2')]);
    expect(useRuleStore.getState().triggerRules.map(r => r.id)).toEqual(['t2']);
  });

  it('addTriggerRule appends to the array', () => {
    useRuleStore.getState().addTriggerRule(makeTriggerRule('t1'));
    useRuleStore.getState().addTriggerRule(makeTriggerRule('t2'));
    expect(useRuleStore.getState().triggerRules).toHaveLength(2);
  });

  it('updateTriggerRule patches existing rule', () => {
    useRuleStore.getState().addTriggerRule(makeTriggerRule('t1'));
    useRuleStore.getState().updateTriggerRule('t1', { pattern: 'FATAL', portId: 'COM3' });
    const rule = useRuleStore.getState().triggerRules[0];
    expect(rule.pattern).toBe('FATAL');
    expect(rule.portId).toBe('COM3');
  });

  it('updateTriggerRule is no-op for unknown id', () => {
    useRuleStore.getState().addTriggerRule(makeTriggerRule('t1'));
    useRuleStore.getState().updateTriggerRule('ghost', { pattern: 'X' });
    expect(useRuleStore.getState().triggerRules[0].pattern).toBe('ERROR');
  });

  it('removeTriggerRule deletes the correct rule', () => {
    useRuleStore.getState().addTriggerRule(makeTriggerRule('t1'));
    useRuleStore.getState().addTriggerRule(makeTriggerRule('t2'));
    useRuleStore.getState().removeTriggerRule('t1');
    expect(useRuleStore.getState().triggerRules.map(r => r.id)).toEqual(['t2']);
  });

  it('removeTriggerRule is no-op for unknown id', () => {
    useRuleStore.getState().addTriggerRule(makeTriggerRule('t1'));
    useRuleStore.getState().removeTriggerRule('ghost');
    expect(useRuleStore.getState().triggerRules).toHaveLength(1);
  });

  it('updateTriggerRule clears portId back to undefined for all-ports scope', () => {
    useRuleStore.getState().addTriggerRule(makeTriggerRule('t1', { portId: 'COM3' }));
    useRuleStore.getState().updateTriggerRule('t1', { portId: undefined });
    expect(useRuleStore.getState().triggerRules[0].portId).toBeUndefined();
  });
});
