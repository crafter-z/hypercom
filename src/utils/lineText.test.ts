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
  // issue #14：lineBytes 现在估算 V8 真实占用（对象头 + Uint8Array 包装 +
  // parsedFields），不再只算 payload 字节——让 byte-budget trim 反映真实量级。
  it('counts object header + Uint8Array wrapper + payload for rawData', () => {
    // 128 (header) + 3 (payload) + 40 (wrapper) = 171
    expect(lineBytes(makeLine({ rawData: new Uint8Array([1, 2, 3]) }))).toBe(171);
  });

  it('counts object header + UTF-16 string for content', () => {
    // 128 (header) + 2 chars * 2 B = 132
    expect(lineBytes(makeLine({ content: '你好' }))).toBe(132);
  });

  it('counts only object header when nothing is stored', () => {
    expect(lineBytes(makeLine({ content: undefined }))).toBe(128);
  });

  it('adds parsedFields overhead', () => {
    const line = makeLine({
      rawData: new Uint8Array([1, 2]),
      parsedFields: [
        { name: 'head', byteStart: 0, byteEnd: 1, color: '#f00' },
        { name: 'len', byteStart: 1, byteEnd: 2, color: '#0f0' },
      ],
    });
    // 128 + (2 + 40) + 2 * 96 = 362
    expect(lineBytes(line)).toBe(362);
  });
});
