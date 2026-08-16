/**
 * Tests for mergeLiveRuleEntities (issue #5-2).
 *
 * The helper must make a full-config save (ConfigModal footer Save /
 * DiagnosticLogDialog diag toggle) carry the LIVE useRuleStore entities
 * instead of the stale startup snapshot in useAppStore.config, which would
 * otherwise clobber the per-set ✓ saves that wrote config.json directly.
 */
import { describe, it, expect } from 'vitest';
import { mergeLiveRuleEntities, type LiveRuleEntities } from './configMerge';
import type { AppConfig } from '../types';

const makeConfig = (overrides: Partial<AppConfig> = {}): AppConfig => ({
  closeBehavior: 'minimize',
  memoryLimitMb: 256,
  memoryPerPortBudgetMb: 200,
  language: 'zh-CN',
  theme: 'dark',
  preventScreenOff: false,
  preventSleep: false,
  autoReconnect: false,
  maxRetries: 3,
  terminalFont: 'Consolas, monospace',
  terminalFontSize: 14,
  uiFont: 'Inter, sans-serif',
  uiFontSize: 14,
  defaultBaudRates: [9600, 19200],
  defaultLineEnding: '\\r\\n',
  sendPrefix: '',
  backgroundImage: '',
  backgroundImageEnabled: false,
  backgroundImageOpacity: 50,
  backgroundImageBlur: 0,
  showPortType: true,
  sendOnEnter: true,
  quickSendInlineCount: 6,
  timestampMode: 'perLine',
  timestampFormat: 'absolute',
  autoSaveLog: true,
  logDirectory: '',
  logFilenameFormat: '[com]-[datetime]',
  logFormat: 'string',
  logEncoding: 'UTF-8',
  logSplitEnabled: true,
  logSplitSizeMb: 100,
  logIncludeTimestamp: true,
  logIncludeDirection: true,
  logSubdirMode: 'date',
  backupEnabled: false,
  backupInterval: 24,
  backupDirectory: '',
  restoreSession: true,
  diagLogEnabled: true,
  // issue #12：updateCheckMode 必填字面量类型，fixture 补默认值
  updateCheckMode: 'stable',
  sendCommandSets: [],
  highlightRuleSets: [],
  protocolTemplates: [],
  triggerRules: [],
  portPresets: [],
  portToolConfigs: [],
  portGroups: [],
  portMeta: [],
  ...overrides,
});

const makeLiveEntities = (overrides: Partial<LiveRuleEntities> = {}): LiveRuleEntities => ({
  sendCommandSets: [{ id: 'cs1', name: 'AT init', commands: [], isLoop: false, loopDelay: 1000, repeatCount: 0 }],
  highlightRuleSets: [{ id: 'hs1', name: 'Errors', rules: [{ id: 'r1', name: 'ERR', pattern: 'ERR', isRegex: false, color: '#ff6b6b', bold: true, italic: false }], isEnabled: true }],
  protocolTemplates: [{
    id: 'pt1', name: 'Frame', isEnabled: true, headerBytes: 'AA BB',
    lengthFieldOffset: 2, lengthFieldSize: 1, lengthEndian: 'little', lengthAdjust: 0,
    checksumAlgorithm: 'sum8', checksumOffset: 0, footerBytes: '0D 0A',
    colorHeader: '#4fc3f7', colorLength: '#ce9178', colorPayload: '#dcdcaa',
    colorChecksum: '#b5cea8', colorFooter: '#6a9955',
  }],
  triggerRules: [{ id: 'tr1', name: 'Alert', pattern: 'BOOT OK', isRegex: false, matchType: 'contains', actionType: 'alert', actionContent: '', actionIsHex: false, isEnabled: true }],
  portToolConfigs: [{ id: 'tc1', name: 'Flasher', portId: 'COM3', command: 'flash {port}', workdir: '' }],
  ...overrides,
});

describe('mergeLiveRuleEntities', () => {
  it('overrides stale config entity arrays with the live rule-store values', () => {
    const staleConfig = makeConfig({
      sendCommandSets: [{ id: 'cs-old', name: 'stale', commands: [], isLoop: false, loopDelay: 100, repeatCount: 0 }],
      highlightRuleSets: [{ id: 'hs-old', name: 'stale', rules: [], isEnabled: false }],
    });
    const live = makeLiveEntities();

    const merged = mergeLiveRuleEntities(staleConfig, live);

    // Live references win for every entity field the rule store holds.
    expect(merged.sendCommandSets).toBe(live.sendCommandSets);
    expect(merged.highlightRuleSets).toBe(live.highlightRuleSets);
    expect(merged.protocolTemplates).toBe(live.protocolTemplates);
    expect(merged.triggerRules).toBe(live.triggerRules);
    expect(merged.portToolConfigs).toBe(live.portToolConfigs);
    // The stale snapshot items are gone.
    expect(merged.sendCommandSets).not.toBe(staleConfig.sendCommandSets);
    expect(merged.highlightRuleSets).not.toBe(staleConfig.highlightRuleSets);
  });

  it('writes empty rule-store arrays over stale non-empty config arrays (resurrection fix)', () => {
    const staleConfig = makeConfig({
      sendCommandSets: [{ id: 'cs-old', name: 'stale', commands: [], isLoop: false, loopDelay: 100, repeatCount: 0 }],
      highlightRuleSets: [{ id: 'hs-old', name: 'stale', rules: [], isEnabled: false }],
      protocolTemplates: [{
        id: 'pt-old', name: 'stale', isEnabled: false, headerBytes: '', lengthFieldOffset: 0,
        lengthFieldSize: 1, lengthEndian: 'little', lengthAdjust: 0, checksumAlgorithm: 'none',
        checksumOffset: 0, footerBytes: '', colorHeader: '#4fc3f7', colorLength: '#ce9178',
        colorPayload: '#dcdcaa', colorChecksum: '#b5cea8', colorFooter: '#6a9955',
      }],
      triggerRules: [{ id: 'tr-old', name: 'stale', pattern: '', isRegex: false, matchType: 'contains', actionType: 'alert', actionContent: '', actionIsHex: false, isEnabled: false }],
      portToolConfigs: [{ id: 'tc-old', name: 'stale', portId: '', command: '', workdir: '' }],
    });
    const live = makeLiveEntities({
      sendCommandSets: [],
      highlightRuleSets: [],
      protocolTemplates: [],
      triggerRules: [],
      portToolConfigs: [],
    });

    const merged = mergeLiveRuleEntities(staleConfig, live);

    expect(merged.sendCommandSets).toEqual([]);
    expect(merged.highlightRuleSets).toEqual([]);
    expect(merged.protocolTemplates).toEqual([]);
    expect(merged.triggerRules).toEqual([]);
    expect(merged.portToolConfigs).toEqual([]);
  });

  it('preserves non-entity config fields untouched', () => {
    const config = makeConfig({
      language: 'en-US',
      theme: 'light',
      diagLogEnabled: false,
      portGroups: [{ id: 'g1', name: 'Group', isExpanded: true, portIds: ['COM1'], order: 0 }],
      portMeta: [{ portId: 'COM1', alias: 'Board', isHidden: false }],
      portPresets: [{ id: 'p1', name: 'P', baudRate: 9600, dataBits: 8, parity: 'None', stopBits: 'One', handshake: 'None', dtr: true, rts: true }],
    });
    const live = makeLiveEntities();

    const merged = mergeLiveRuleEntities(config, live);

    expect(merged.language).toBe('en-US');
    expect(merged.theme).toBe('light');
    expect(merged.diagLogEnabled).toBe(false);
    expect(merged.logSubdirMode).toBe('date');
    // Entities owned by other sync paths (useAppInit auto-save) keep their references.
    expect(merged.portGroups).toBe(config.portGroups);
    expect(merged.portMeta).toBe(config.portMeta);
    expect(merged.portPresets).toBe(config.portPresets);
  });

  it('returns a new object and does not mutate the input', () => {
    const staleConfig = makeConfig({
      sendCommandSets: [{ id: 'cs-old', name: 'stale', commands: [], isLoop: false, loopDelay: 100, repeatCount: 0 }],
    });
    const live = makeLiveEntities();

    const merged = mergeLiveRuleEntities(staleConfig, live);

    expect(merged).not.toBe(staleConfig);
    // Input untouched: still holds the stale array.
    expect(staleConfig.sendCommandSets).toHaveLength(1);
    expect(staleConfig.sendCommandSets[0].id).toBe('cs-old');
  });
});
