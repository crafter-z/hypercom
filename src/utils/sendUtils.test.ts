/**
 * Tests for send-area pure helpers.
 */
import { describe, it, expect } from 'vitest';
import {
  getLineEndingBytes,
  parseHexBytes,
  computeByteCount,
  formatLineEndingHex,
  textToHexPreview,
  hexToTextPreview,
  sanitizeHexInput,
  LINE_ENDING_VALUES,
} from './sendUtils';

describe('sendUtils', () => {
  describe('getLineEndingBytes', () => {
    it('maps line-ending values to raw bytes', () => {
      expect(getLineEndingBytes('\\r\\n')).toEqual([0x0d, 0x0a]);
      expect(getLineEndingBytes('\\r')).toEqual([0x0d]);
      expect(getLineEndingBytes('\\n')).toEqual([0x0a]);
      expect(getLineEndingBytes('None')).toEqual([]);
    });
  });

  describe('parseHexBytes', () => {
    it('parses space-separated hex', () => {
      expect(parseHexBytes('48 65 6C')).toEqual([0x48, 0x65, 0x6c]);
    });

    it('parses compact hex', () => {
      expect(parseHexBytes('AABBCC')).toEqual([0xaa, 0xbb, 0xcc]);
    });

    it('pads trailing nibble with leading zero after whitespace strip', () => {
      // "48 6" → "486" (odd) → last nibble '6' is padded to '06'
      expect(parseHexBytes('48 6')).toEqual([0x48, 0x06]);
    });

    it('pads single-nibble and odd-length compact input', () => {
      expect(parseHexBytes('C')).toEqual([0x0c]);
      expect(parseHexBytes('486')).toEqual([0x48, 0x06]);
      expect(parseHexBytes('ABC')).toEqual([0xab, 0x0c]);
    });

    it('returns empty for empty input', () => {
      expect(parseHexBytes('')).toEqual([]);
      expect(parseHexBytes('   ')).toEqual([]);
    });
  });

  describe('computeByteCount', () => {
    it('counts parsed hex bytes plus line ending suffix', () => {
      const result = computeByteCount('48 65 6C', true, 'ASCII', '\\r\\n');
      expect(result.count).toBe(5);
      expect(result.label).toBe('5 B');
    });

    it('counts UTF-8 text bytes plus suffix', () => {
      const result = computeByteCount('hello', false, 'UTF-8', '\\n');
      expect(result.count).toBe(6);
      expect(result.label).toBe('6 B');
    });

    it('counts multi-byte UTF-8 characters correctly', () => {
      const result = computeByteCount('你好', false, 'UTF-8', 'None');
      expect(result.count).toBe(6);
      expect(result.label).toBe('6 B');
    });

    it('shows character hint for GBK / ISO-8859-1', () => {
      const gbk = computeByteCount('abc', false, 'GBK', 'None');
      expect(gbk.count).toBe(3);
      expect(gbk.label).toBe('3 chars · ? bytes');
      expect(gbk.tooltip).toBeTruthy();

      const iso = computeByteCount('abc', false, 'ISO-8859-1', 'None');
      expect(iso.label).toBe('3 chars · ? bytes');
    });
  });

  describe('formatLineEndingHex', () => {
    it('formats line endings as hex bytes', () => {
      expect(formatLineEndingHex('\\r\\n')).toBe('0D 0A');
      expect(formatLineEndingHex('\\r')).toBe('0D');
      expect(formatLineEndingHex('\\n')).toBe('0A');
      expect(formatLineEndingHex('None')).toBeNull();
    });
  });

  describe('textToHexPreview', () => {
    it('converts ascii text to spaced uppercase hex bytes', () => {
      expect(textToHexPreview('hello')).toBe('68 65 6C 6C 6F');
    });

    it('returns empty string for empty input', () => {
      expect(textToHexPreview('')).toBe('');
    });

    it('encodes multi-byte UTF-8 characters', () => {
      // 中 = U+4E2D → UTF-8 E4 B8 AD
      expect(textToHexPreview('中')).toBe('E4 B8 AD');
    });
  });

  describe('hexToTextPreview', () => {
    it('decodes space-separated hex to text', () => {
      expect(hexToTextPreview('68 65 6C 6C 6F')).toBe('hello');
    });

    it('decodes compact hex to text', () => {
      expect(hexToTextPreview('68656C6C6F')).toBe('hello');
    });

    it('returns empty string for empty input', () => {
      expect(hexToTextPreview('')).toBe('');
      expect(hexToTextPreview('   ')).toBe('');
    });

    it('returns empty string for invalid-only input', () => {
      expect(hexToTextPreview('ZZ GG')).toBe('');
    });
  });

  describe('round-trip textToHexPreview <-> hexToTextPreview', () => {
    it('round-trips ascii text', () => {
      const samples = ['hello', 'AT+OK', 'abc 123', ''];
      for (const s of samples) {
        expect(hexToTextPreview(textToHexPreview(s))).toBe(s);
      }
    });
  });

  describe('sanitizeHexInput', () => {
    it('strips non-hex characters but keeps spaces and case', () => {
      expect(sanitizeHexInput('GG 12 ZZ34 ')).toBe(' 12 34 ');
    });

    it('keeps valid hex digits and whitespace untouched', () => {
      expect(sanitizeHexInput('AB cd 09\n')).toBe('AB cd 09\n');
    });
  });

  describe('LINE_ENDING_VALUES (issue #5-6 regression)', () => {
    it('every option value round-trips through getLineEndingBytes', () => {
      expect(LINE_ENDING_VALUES).toEqual(['\\r\\n', '\\r', '\\n', 'None']);
      for (const v of LINE_ENDING_VALUES) {
        const bytes = getLineEndingBytes(v);
        if (v === 'None') {
          expect(bytes).toEqual([]);
        } else {
          expect(bytes.length).toBeGreaterThan(0);
        }
      }
    });

    it('values are the canonical escaped forms (never the raw JSX-attribute form)', () => {
      // 6-char "\\r\\n" (raw JSX attribute, unescaped by the Babel pipeline)
      // would hit the `default` branch -> empty bytes -> null hex -> stuck hint.
      // Canonical escaped lengths: '\r\n'=4, '\r'=2, '\n'=2, 'None'=4.
      const expectedLen: Record<string, number> = { '\\r\\n': 4, '\\r': 2, '\\n': 2, None: 4 };
      for (const v of LINE_ENDING_VALUES) {
        expect(v.length).toBe(expectedLen[v]);
        if (v !== 'None') {
          expect(formatLineEndingHex(v)).not.toBeNull();
        }
      }
    });
  });
});
