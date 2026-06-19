import { describe, it, expect } from 'vitest';
import { applyHighlightSets } from './highlightEngine';
import type { HighlightRuleSet, HighlightRule } from '../types';

// Helpers
const makeRule = (overrides?: Partial<HighlightRule>): HighlightRule => ({
  id: 'r1',
  name: 'test',
  pattern: 'test',
  isRegex: false,
  ...overrides,
});

const makeRuleSet = (overrides?: Partial<HighlightRuleSet>): HighlightRuleSet => ({
  id: 'rs1',
  name: 'Test Set',
  rules: [],
  isEnabled: true,
  ...overrides,
});

// ==================== Basic ====================

describe('applyHighlightSets', () => {
  it('returns escaped HTML for empty text', () => {
    const result = applyHighlightSets('', []);
    expect(result).toBe('');
  });

  it('returns escaped HTML when no rule sets are provided', () => {
    const result = applyHighlightSets('hello', []);
    expect(result).toBe('hello');
  });

  it('escapes HTML special characters when no highlights match', () => {
    const result = applyHighlightSets('<script>alert("xss")</script>', []);
    expect(result).toContain('&lt;script&gt;');
    expect(result).toContain('&lt;/script&gt;');
    expect(result).not.toContain('<script>');
  });

  it('returns escaped text when all rule sets are disabled', () => {
    const set = makeRuleSet({ isEnabled: false, rules: [makeRule({ pattern: 'alert' })] });
    const result = applyHighlightSets('alert: test', [set]);
    expect(result).toBe('alert: test');
  });

  // ==================== Keyword matching ====================

  it('highlights keyword match with span', () => {
    const set = makeRuleSet({
      rules: [makeRule({ pattern: 'ERROR', isRegex: false, color: '#ff0000' })],
    });
    const result = applyHighlightSets('ERROR: something failed', [set]);
    expect(result).toContain('<span style="color:#ff0000">ERROR</span>');
  });

  it('keyword matching is case-insensitive', () => {
    const set = makeRuleSet({
      rules: [makeRule({ pattern: 'error', isRegex: false, color: '#ff0000' })],
    });
    const result = applyHighlightSets('ERROR: something failed', [set]);
    expect(result).toContain('<span style="color:#ff0000">ERROR</span>');
  });

  it('highlights multiple keyword occurrences', () => {
    const set = makeRuleSet({
      rules: [makeRule({ pattern: 'foo', isRegex: false, color: '#00ff00' })],
    });
    const result = applyHighlightSets('foo bar foo', [set]);
    const matches = result.match(/color:#00ff00/g);
    expect(matches).toHaveLength(2);
  });

  // ==================== Regex matching ====================

  it('highlights regex match', () => {
    const set = makeRuleSet({
      rules: [makeRule({ pattern: '\\d+', isRegex: true, color: '#0000ff' })],
    });
    const result = applyHighlightSets('abc 123 def', [set]);
    expect(result).toContain('<span style="color:#0000ff">123</span>');
  });

  it('handles invalid regex gracefully', () => {
    const set = makeRuleSet({
      rules: [makeRule({ pattern: '[invalid', isRegex: true, color: '#ff0000' })],
    });
    const result = applyHighlightSets('test', [set]);
    expect(result).toBe('test');
  });

  it('skips regex pattern longer than 200 chars (ReDoS protection)', () => {
    const longPattern = 'a'.repeat(201);
    const set = makeRuleSet({
      rules: [makeRule({ pattern: longPattern, isRegex: true, color: '#ff0000' })],
    });
    const result = applyHighlightSets('test', [set]);
    expect(result).toBe('test');
  });

  it('skips empty pattern', () => {
    const set = makeRuleSet({
      rules: [makeRule({ pattern: '', isRegex: false, color: '#ff0000' })],
    });
    const result = applyHighlightSets('test', [set]);
    expect(result).toBe('test');
  });

  // ==================== Style building ====================

  it('applies bold and italic styles', () => {
    const set = makeRuleSet({
      rules: [makeRule({ pattern: 'bold', isRegex: false, bold: true, italic: true })],
    });
    const result = applyHighlightSets('bold text', [set]);
    expect(result).toContain('font-weight:bold');
    expect(result).toContain('font-style:italic');
  });

  it('rejects invalid color values', () => {
    const set = makeRuleSet({
      rules: [makeRule({ pattern: 'bad', isRegex: false, color: 'javascript:alert(1)' })],
    });
    const result = applyHighlightSets('bad color', [set]);
    expect(result).not.toContain('javascript:alert');
  });

  it('accepts valid hex color', () => {
    const set = makeRuleSet({
      rules: [makeRule({ pattern: 'hex', isRegex: false, color: '#ff00aa' })],
    });
    const result = applyHighlightSets('hex color', [set]);
    expect(result).toContain('color:#ff00aa');
  });

  it('accepts named color', () => {
    const set = makeRuleSet({
      rules: [makeRule({ pattern: 'red', isRegex: false, color: 'tomato' })],
    });
    const result = applyHighlightSets('red alert', [set]);
    expect(result).toContain('color:tomato');
  });

  // ==================== Multiple rule sets ====================

  it('applies rules from multiple enabled sets', () => {
    const set1 = makeRuleSet({
      id: 's1',
      rules: [makeRule({ id: 'r1', pattern: 'error', isRegex: false, color: '#ff0000' })],
    });
    const set2 = makeRuleSet({
      id: 's2',
      rules: [makeRule({ id: 'r2', pattern: 'warn', isRegex: false, color: '#ffaa00' })],
    });
    const result = applyHighlightSets('error and warn', [set1, set2]);
    expect(result).toContain('color:#ff0000');
    expect(result).toContain('color:#ffaa00');
  });

  it('skips disabled sets', () => {
    const enabled = makeRuleSet({
      id: 'enabled',
      isEnabled: true,
      rules: [makeRule({ id: 'r1', pattern: 'hello', isRegex: false, color: '#00ff00' })],
    });
    const disabled = makeRuleSet({
      id: 'disabled',
      isEnabled: false,
      rules: [makeRule({ id: 'r2', pattern: 'world', isRegex: false, color: '#ff0000' })],
    });
    const result = applyHighlightSets('hello world', [enabled, disabled]);
    expect(result).toContain('color:#00ff00');
    expect(result).not.toContain('color:#ff0000');
  });

  // ==================== Overlap handling ====================

  it('prefers longer match when overlaps', () => {
    const set = makeRuleSet({
      rules: [
        makeRule({ id: 'r1', pattern: 'hello', isRegex: false, color: '#ff0000' }),
        makeRule({ id: 'r2', pattern: 'hello world', isRegex: false, color: '#00ff00' }),
      ],
    });
    const result = applyHighlightSets('hello world', [set]);
    // The longer match "hello world" should win over "hello"
    expect(result).toContain('color:#00ff00');
  });

  // ==================== XSS protection ====================

  it('escapes HTML within highlighted content', () => {
    const set = makeRuleSet({
      rules: [makeRule({ pattern: '<script>', isRegex: false, color: '#ff0000' })],
    });
    const result = applyHighlightSets('before <script> after', [set]);
    expect(result).toContain('&lt;script&gt;');
    expect(result).not.toContain('<script>');
  });

  // ==================== No match ====================

  it('preserves original text when no rules match', () => {
    const set = makeRuleSet({
      rules: [makeRule({ pattern: 'zzz', isRegex: false, color: '#ff0000' })],
    });
    const result = applyHighlightSets('no match here', [set]);
    expect(result).toBe('no match here');
  });

  // ==================== Edge cases ====================

  it('handles text with only the matched keyword', () => {
    const set = makeRuleSet({
      rules: [makeRule({ pattern: 'solo', isRegex: false, color: '#ff0000' })],
    });
    const result = applyHighlightSets('solo', [set]);
    expect(result).toContain('<span');
  });

  it('handles zero-width regex match without infinite loop', () => {
    const set = makeRuleSet({
      rules: [makeRule({ pattern: 'x*', isRegex: true, color: '#ff0000' })],
    });
    const result = applyHighlightSets('test', [set]);
    // Should not hang - just verify it completes
    expect(typeof result).toBe('string');
  });
});
