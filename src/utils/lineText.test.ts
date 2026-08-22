import { describe, it, expect } from 'vitest';
import type { TerminalLine } from '../types';
import { decodeBytes, getLineText, lineBytes, normalizeEncodingLabel } from './lineText';

const makeLine = (overrides?: Partial<TerminalLine>): TerminalLine => ({
  timestamp: 0,
  direction: 'RX',
  isHex: false,
  ...overrides,
});

describe('normalizeEncodingLabel', () => {
  it('maps ASCII to utf-8', () => {
    expect(normalizeEncodingLabel('ASCII')).toBe('utf-8');
    expect(normalizeEncodingLabel('ascii')).toBe('utf-8');
  });

  it('lowercases other encodings', () => {
    expect(normalizeEncodingLabel('UTF-8')).toBe('utf-8');
    expect(normalizeEncodingLabel('GBK')).toBe('gbk');
    expect(normalizeEncodingLabel('ISO-8859-1')).toBe('iso-8859-1');
  });
});

describe('decodeBytes', () => {
  it('decodes UTF-8 bytes', () => {
    expect(decodeBytes(new TextEncoder().encode('你好'), 'UTF-8')).toBe('你好');
  });

  it('decodes GBK bytes', () => {
    // "你" in GBK = 0xC4 0xE3, "好" = 0xBA 0xC3
    expect(decodeBytes(new Uint8Array([0xC4, 0xE3, 0xBA, 0xC3]), 'GBK')).toBe('你好');
  });

  it('falls back to utf-8 for invalid labels', () => {
    expect(decodeBytes(new Uint8Array([72, 105]), 'INVALID' as never)).toBe('Hi');
  });

  it('reuses cached decoder instances for the same label', () => {
    // No observable API — smoke: repeated decodes are stable
    const bytes = new Uint8Array([65, 66]);
    expect(decodeBytes(bytes, 'UTF-8')).toBe('AB');
    expect(decodeBytes(bytes, 'UTF-8')).toBe('AB');
  });
});

describe('getLineText', () => {
  it('returns content when present (TX/TOOL/replay lines)', () => {
    expect(getLineText(makeLine({ content: 'hello' }), 'UTF-8')).toBe('hello');
  });

  it('decodes rawData under the given encoding', () => {
    const line = makeLine({ rawData: new TextEncoder().encode('你好') });
    expect(getLineText(line, 'UTF-8')).toBe('你好');
  });

  it('decodes GBK rawData under GBK', () => {
    const line = makeLine({ rawData: new Uint8Array([0xC4, 0xE3, 0xBA, 0xC3]) });
    expect(getLineText(line, 'GBK')).toBe('你好');
  });

  it('re-decodes with a different encoding on switch', () => {
    const line = makeLine({ rawData: new Uint8Array([0xC4, 0xE3, 0xBA, 0xC3]) });
    expect(getLineText(line, 'UTF-8')).not.toBe('你好');
    expect(getLineText(line, 'GBK')).toBe('你好');
  });

  it('returns empty string when neither content nor rawData', () => {
    expect(getLineText(makeLine({ content: undefined }), 'UTF-8')).toBe('');
  });

  it('prefers content over rawData', () => {
    const line = makeLine({
      content: 'stale',
      rawData: new TextEncoder().encode('fresh'),
    });
    expect(getLineText(line, 'UTF-8')).toBe('stale');
  });
});

describe('lineBytes', () => {
  it('uses rawData length when present', () => {
    expect(lineBytes(makeLine({ rawData: new Uint8Array([1, 2, 3]) }))).toBe(3);
  });

  it('uses UTF-8 content byte length for multi-byte text', () => {
    expect(lineBytes(makeLine({ content: '你好' }))).toBe(6);
  });

  it('returns 0 when nothing is stored', () => {
    expect(lineBytes(makeLine({ content: undefined }))).toBe(0);
  });
});
