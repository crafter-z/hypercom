import { describe, it, expect } from 'vitest';
import { evaluateTriggers, bytesToHexString, normalizeHexPattern } from './triggerEngine';
import type { TriggerRule } from '../types';

function makeRule(overrides: Partial<TriggerRule> = {}): TriggerRule {
  return {
    id: 'test-1',
    name: 'Test Rule',
    pattern: 'ERROR',
    isRegex: false,
    matchType: 'contains',
    actionType: 'alert',
    actionContent: 'Error detected',
    actionIsHex: false,
    isEnabled: true,
    ...overrides,
  };
}

describe('bytesToHexString', () => {
  it('converts bytes to uppercase space-separated hex', () => {
    expect(bytesToHexString([0xaa, 0x55, 0x0f])).toBe('AA 55 0F');
  });

  it('handles empty array', () => {
    expect(bytesToHexString([])).toBe('');
  });

  it('masks values to single byte', () => {
    expect(bytesToHexString([256, 255])).toBe('00 FF');
  });
});

describe('normalizeHexPattern', () => {
  it('uppercases and collapses whitespace', () => {
    expect(normalizeHexPattern('aa  55 bb')).toBe('AA 55 BB');
  });

  it('trims leading/trailing spaces', () => {
    expect(normalizeHexPattern('  FF 00  ')).toBe('FF 00');
  });
});

describe('evaluateTriggers', () => {
  describe('contains match', () => {
    it('matches when content contains pattern', () => {
      const rule = makeRule({ pattern: 'ERROR', matchType: 'contains' });
      const result = evaluateTriggers('some ERROR here', undefined, [rule]);
      expect(result).toHaveLength(1);
      expect(result[0].rule.id).toBe('test-1');
      expect(result[0].matchedText).toBe('some ERROR here');
    });

    it('does not match when pattern absent', () => {
      const rule = makeRule({ pattern: 'ERROR', matchType: 'contains' });
      const result = evaluateTriggers('all good', undefined, [rule]);
      expect(result).toHaveLength(0);
    });
  });

  describe('exact match', () => {
    it('matches when content equals pattern exactly', () => {
      const rule = makeRule({ pattern: 'OK', matchType: 'exact' });
      const result = evaluateTriggers('OK', undefined, [rule]);
      expect(result).toHaveLength(1);
    });

    it('does not match on partial content', () => {
      const rule = makeRule({ pattern: 'OK', matchType: 'exact' });
      const result = evaluateTriggers('OK done', undefined, [rule]);
      expect(result).toHaveLength(0);
    });
  });

  describe('regex match', () => {
    it('matches valid regex pattern', () => {
      const rule = makeRule({ pattern: 'ERR\\d+', matchType: 'regex' });
      const result = evaluateTriggers('got ERR42', undefined, [rule]);
      expect(result).toHaveLength(1);
    });

    it('skips invalid regex without throwing', () => {
      const rule = makeRule({ pattern: '[invalid', matchType: 'regex' });
      const result = evaluateTriggers('anything', undefined, [rule]);
      expect(result).toHaveLength(0);
    });

    it('does not match when regex does not match', () => {
      const rule = makeRule({ pattern: '^\\d+$', matchType: 'regex' });
      const result = evaluateTriggers('abc123', undefined, [rule]);
      expect(result).toHaveLength(0);
    });
  });

  describe('hex match', () => {
    it('matches hex pattern in rawData', () => {
      const rule = makeRule({ pattern: 'AA 55', matchType: 'hex' });
      const result = evaluateTriggers('', [0xaa, 0x55, 0x00], [rule]);
      expect(result).toHaveLength(1);
    });

    it('normalizes pattern case and spacing', () => {
      const rule = makeRule({ pattern: 'aa  55', matchType: 'hex' });
      const result = evaluateTriggers('', [0xaa, 0x55], [rule]);
      expect(result).toHaveLength(1);
    });

    it('does not match when hex pattern absent', () => {
      const rule = makeRule({ pattern: 'FF FF', matchType: 'hex' });
      const result = evaluateTriggers('', [0xaa, 0x55], [rule]);
      expect(result).toHaveLength(0);
    });

    it('skips hex match when rawData is undefined', () => {
      const rule = makeRule({ pattern: 'AA', matchType: 'hex' });
      const result = evaluateTriggers('text', undefined, [rule]);
      expect(result).toHaveLength(0);
    });

    it('skips hex match when rawData is empty', () => {
      const rule = makeRule({ pattern: 'AA', matchType: 'hex' });
      const result = evaluateTriggers('', [], [rule]);
      expect(result).toHaveLength(0);
    });
  });

  describe('disabled rules', () => {
    it('skips disabled rules', () => {
      const rule = makeRule({ isEnabled: false, pattern: 'ERROR' });
      const result = evaluateTriggers('ERROR', undefined, [rule]);
      expect(result).toHaveLength(0);
    });
  });

  describe('pattern length limit', () => {
    it('skips patterns longer than 200 chars', () => {
      const longPattern = 'A'.repeat(201);
      const rule = makeRule({ pattern: longPattern, matchType: 'contains' });
      const result = evaluateTriggers(longPattern, undefined, [rule]);
      expect(result).toHaveLength(0);
    });

    it('allows patterns of exactly 200 chars', () => {
      const pattern = 'A'.repeat(200);
      const rule = makeRule({ pattern, matchType: 'contains' });
      const result = evaluateTriggers(pattern, undefined, [rule]);
      expect(result).toHaveLength(1);
    });
  });

  describe('multiple triggers', () => {
    it('returns all matching triggers', () => {
      const rules = [
        makeRule({ id: 'r1', pattern: 'ERROR', matchType: 'contains' }),
        makeRule({ id: 'r2', pattern: 'ERR', matchType: 'contains' }),
        makeRule({ id: 'r3', pattern: 'WARN', matchType: 'contains' }),
      ];
      const result = evaluateTriggers('ERROR found', undefined, rules);
      expect(result).toHaveLength(2);
      expect(result.map((a) => a.rule.id)).toEqual(['r1', 'r2']);
    });

    it('returns empty for no matches', () => {
      const rules = [
        makeRule({ id: 'r1', pattern: 'ERROR' }),
        makeRule({ id: 'r2', pattern: 'WARN' }),
      ];
      const result = evaluateTriggers('all good', undefined, rules);
      expect(result).toHaveLength(0);
    });
  });

  describe('empty pattern', () => {
    it('skips rules with empty pattern', () => {
      const rule = makeRule({ pattern: '' });
      const result = evaluateTriggers('anything', undefined, [rule]);
      expect(result).toHaveLength(0);
    });
  });
});