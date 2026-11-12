import { describe, expect, it } from 'vitest';
import { isLikelyAsciiNoise } from './asciiNoise';

const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);

// The predicate classifies raw bytes and never decodes them. In particular,
// UTF-8/GBK Chinese bytes are intentionally noise under this ASCII-only rule.
describe('isLikelyAsciiNoise', () => {
  it('keeps an empty line and ordinary printable ASCII', () => {
    expect(isLikelyAsciiNoise(new Uint8Array())).toBe(false);
    expect(isLikelyAsciiNoise(ascii('INFO ready: 3 packets'))).toBe(false);
  });

  it('keeps whitespace separators but hides unreadable ASCII controls', () => {
    expect(isLikelyAsciiNoise(new Uint8Array([0x09, 0x0d, 0x0a, 0x09]))).toBe(false);
    expect(isLikelyAsciiNoise(new Uint8Array([0x00, 0x01, 0x02, 0x03]))).toBe(true);
    expect(isLikelyAsciiNoise(new Uint8Array([0x00, 65, 0x01, 66, 0x1b, 67, 0x7f]))).toBe(true);
  });

  it('does not hide short all-unreadable lines before the four-byte threshold', () => {
    expect(isLikelyAsciiNoise(new Uint8Array([0x80]))).toBe(false);
    expect(isLikelyAsciiNoise(new Uint8Array([0x80, 0x81, 0x82]))).toBe(false);
    expect(isLikelyAsciiNoise(new Uint8Array([0x80, 0x81, 0x82, 0x83]))).toBe(true);
  });

  it('hides isolated readable characters inside a sufficiently large binary line', () => {
    const line = new Uint8Array([
      0x80, 0x41, 0x81, 0x42, 0x82, 0x43, 0x83, 0x44,
      0x84, 0x45, 0x85, 0x46, 0x86, 0x47,
    ]);
    expect(isLikelyAsciiNoise(line)).toBe(true);
  });

  it('requires the non-readable share to reach thirty percent', () => {
    // Four non-readable bytes out of fourteen is below 30%.
    expect(
      isLikelyAsciiNoise(
        new Uint8Array([0x80, 0x81, 0x82, 0x83, ...ascii('abcdefghij')]),
      ),
    ).toBe(false);
    // Four non-readable bytes out of thirteen is above 30%.
    expect(
      isLikelyAsciiNoise(
        new Uint8Array([0x80, 0x81, 0x82, 0x83, ...ascii('abcdefghi')]),
      ),
    ).toBe(true);
  });

  it('does not let a long run of spaces protect a binary line', () => {
    const spaces = new Uint8Array(12).fill(0x20);
    const line = new Uint8Array([0x80, 0x81, 0x82, 0x83, 0x84, 0x85, ...spaces]);
    expect(isLikelyAsciiNoise(line)).toBe(true);
  });

  it('keeps a binary line containing a long alphanumeric English run', () => {
    const english = ascii('packet=READY');
    const line = new Uint8Array([0x80, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, ...english]);
    expect(isLikelyAsciiNoise(line)).toBe(false);
  });

  it('treats UTF-8 and GBK Chinese byte sequences as ASCII-target noise', () => {
    expect(isLikelyAsciiNoise(new Uint8Array([0xe4, 0xbd, 0xa0, 0xe5, 0xa5, 0xbd]))).toBe(true);
    expect(isLikelyAsciiNoise(new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]))).toBe(true);
  });

  it('does not mutate the caller-owned raw bytes', () => {
    const line = new Uint8Array([0x80, 0x41, 0x81, 0x42, 0x82, 0x43, 0x83, 0x44]);
    const before = line.slice();
    isLikelyAsciiNoise(line);
    expect(line).toEqual(before);
  });
});
