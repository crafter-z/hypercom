import { describe, expect, it } from 'vitest';
import { isSafeRegexPattern, MAX_SAFE_REGEX_PATTERN_LENGTH, tryCreateSafeRegex } from './safeRegex';

describe('safeRegex', () => {
  it('rejects nested quantifiers that can trigger catastrophic backtracking', () => {
    expect(isSafeRegexPattern('(a+)+$')).toBe(false);
    expect(isSafeRegexPattern('(?:a+){2}')).toBe(false);
    expect(tryCreateSafeRegex('(a+)+$')).toBeNull();
  });

  it('allows ordinary and lazy quantifiers', () => {
    expect(isSafeRegexPattern('^ERR\\d+?$')).toBe(true);
    expect(isSafeRegexPattern('colou?r')).toBe(true);
    expect(tryCreateSafeRegex('^ERR\\d+?$')?.test('ERR12')).toBe(true);
  });

  it('rejects invalid and overlong patterns before construction', () => {
    expect(isSafeRegexPattern('[unterminated')).toBe(false);
    expect(isSafeRegexPattern('a'.repeat(MAX_SAFE_REGEX_PATTERN_LENGTH + 1))).toBe(false);
  });

  it('supports bounded groups without nesting a quantifier', () => {
    expect(isSafeRegexPattern('^(?:ab|cd){2}$')).toBe(true);
    expect(tryCreateSafeRegex('^(?:ab|cd){2}$')?.test('abcd')).toBe(true);
  });
});
