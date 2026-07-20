/**
 * Tests for send-area pure helpers.
 */
import { describe, it, expect } from 'vitest';
import {
  getLineEndingBytes,
  parseHexBytes,
  computeByteCount,
  formatLineEndingHex,
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
});
