/**
 * Tests for QuickSend text-mode pure helpers (issue #5-4).
 */
import { describe, it, expect } from 'vitest';
import {
  splitSendLines,
  isValidHexLine,
  clampInterval,
  clampRoundInterval,
} from './textSend';

describe('textSend', () => {
  describe('splitSendLines', () => {
    it('splits on LF', () => {
      expect(splitSendLines('AT\r\nOK')).toEqual(['AT', 'OK']);
      expect(splitSendLines('a\nb\nc')).toEqual(['a', 'b', 'c']);
    });

    it('splits on CRLF', () => {
      expect(splitSendLines('a\r\nb\r\nc')).toEqual(['a', 'b', 'c']);
    });

    it('trims trailing empty lines', () => {
      expect(splitSendLines('a\nb\n\n\n')).toEqual(['a', 'b']);
    });

    it('trims trailing whitespace-only lines', () => {
      expect(splitSendLines('a\nb\n  \n\t')).toEqual(['a', 'b']);
    });

    it('keeps internal blank lines', () => {
      expect(splitSendLines('a\n\nb')).toEqual(['a', '', 'b']);
    });

    it('returns [] for empty / whitespace-only input', () => {
      expect(splitSendLines('')).toEqual([]);
      expect(splitSendLines('   \n\t\n')).toEqual([]);
    });

    it('keeps a single line untouched', () => {
      expect(splitSendLines('AT')).toEqual(['AT']);
      expect(splitSendLines('a  b')).toEqual(['a  b']);
    });
  });

  describe('isValidHexLine', () => {
    it('accepts space-separated hex bytes', () => {
      expect(isValidHexLine('48 65 6C')).toBe(true);
    });

    it('accepts compact hex', () => {
      expect(isValidHexLine('AABBCC')).toBe(true);
      expect(isValidHexLine('aabbcc')).toBe(true);
    });

    it('rejects odd-length (stray nibble)', () => {
      expect(isValidHexLine('4')).toBe(false);
      expect(isValidHexLine('486')).toBe(false);
      expect(isValidHexLine('48 6')).toBe(false);
    });

    it('rejects non-hex characters', () => {
      expect(isValidHexLine('zz')).toBe(false);
      expect(isValidHexLine('0x48')).toBe(false);
      expect(isValidHexLine('48 6G')).toBe(false);
    });

    it('rejects empty / whitespace-only lines', () => {
      expect(isValidHexLine('')).toBe(false);
      expect(isValidHexLine('   ')).toBe(false);
    });

    it('accepts single-byte and leading-space forms', () => {
      expect(isValidHexLine('48')).toBe(true);
      expect(isValidHexLine(' 48 65 ')).toBe(true);
    });
  });

  describe('clampInterval', () => {
    it('clamps below-minimum to 1', () => {
      expect(clampInterval(0)).toBe(1);
      expect(clampInterval(-5)).toBe(1);
    });

    it('passes through valid values', () => {
      expect(clampInterval(1)).toBe(1);
      expect(clampInterval(200)).toBe(200);
      expect(clampInterval(60_000)).toBe(60_000);
    });

    it('rounds fractional values', () => {
      expect(clampInterval(3.4)).toBe(3);
      expect(clampInterval(3.6)).toBe(4);
    });

    it('falls back to 1 for non-finite input', () => {
      expect(clampInterval(NaN)).toBe(1);
      expect(clampInterval(Infinity)).toBe(1);
    });
  });

  describe('clampRoundInterval', () => {
    it('allows 0 (no inter-round delay)', () => {
      expect(clampRoundInterval(0)).toBe(0);
    });

    it('clamps negatives to 0', () => {
      expect(clampRoundInterval(-10)).toBe(0);
    });

    it('passes through positive values and rounds', () => {
      expect(clampRoundInterval(1000)).toBe(1000);
      expect(clampRoundInterval(999.5)).toBe(1000);
    });

    it('falls back to 0 for non-finite input', () => {
      expect(clampRoundInterval(NaN)).toBe(0);
      expect(clampRoundInterval(Infinity)).toBe(0);
    });
  });
});
