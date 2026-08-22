import { describe, it, expect } from 'vitest';
import type { TerminalLine } from '../../types';
import { TerminalBuffer } from './TerminalBuffer';

const makeLine = (tag: string, size = 2): TerminalLine => ({
  timestamp: 0,
  direction: 'RX',
  content: undefined,
  rawData: new Uint8Array(size).fill(tag.charCodeAt(0)),
  isHex: false,
});

const makeBuf = (maxLines = 10, maxBytes = 0) => new TerminalBuffer({ maxLines, maxBytes });

describe('TerminalBuffer append', () => {
  it('assigns monotonic seqs in order', () => {
    const b = makeBuf();
    expect(b.append(makeLine('a')).seq).toBe(0);
    expect(b.append(makeLine('b')).seq).toBe(1);
    expect(b.append(makeLine('c')).seq).toBe(2);
  });

  it('is empty initially', () => {
    const b = makeBuf();
    expect(b.length).toBe(0);
    expect(b.firstSeq).toBe(0);
    expect(b.lastSeq).toBe(-1);
  });

  it('getBySeq returns null outside the live window', () => {
    const b = makeBuf();
    b.append(makeLine('a'));
    expect(b.getBySeq(0)).not.toBeNull();
    expect(b.getBySeq(1)).toBeNull();
    expect(b.getBySeq(-1)).toBeNull();
  });
});

describe('TerminalBuffer capacity trim', () => {
  it('overwrites the oldest line at capacity', () => {
    const b = makeBuf(3);
    b.append(makeLine('a'));
    b.append(makeLine('b'));
    b.append(makeLine('c'));
    const r = b.append(makeLine('d'));
    expect(r.trimmed).toBe(true);
    expect(b.length).toBe(3);
    expect(b.firstSeq).toBe(1);
    expect(b.lastSeq).toBe(3);
    expect(b.getBySeq(0)).toBeNull();
    expect(b.getBySeq(1)?.rawData?.[0]).toBe('b'.charCodeAt(0));
    expect(b.getBySeq(3)?.rawData?.[0]).toBe('d'.charCodeAt(0));
  });

  it('seqs of surviving lines stay stable across trims', () => {
    const b = makeBuf(3);
    for (const t of ['a', 'b', 'c', 'd', 'e']) b.append(makeLine(t));
    // window is [2..4]; line 'c' keeps seq 2
    expect(b.getBySeq(2)?.rawData?.[0]).toBe('c'.charCodeAt(0));
    expect(b.getBySeq(4)?.rawData?.[0]).toBe('e'.charCodeAt(0));
  });

  it('no trim before capacity', () => {
    const b = makeBuf(3);
    expect(b.append(makeLine('a')).trimmed).toBe(false);
    expect(b.append(makeLine('b')).trimmed).toBe(false);
  });

  it('capacity 1 keeps only the newest line', () => {
    const b = makeBuf(1);
    b.append(makeLine('a'));
    b.append(makeLine('b'));
    expect(b.length).toBe(1);
    expect(b.getBySeq(1)?.rawData?.[0]).toBe('b'.charCodeAt(0));
  });
});

describe('TerminalBuffer byte budget', () => {
  it('drops oldest lines until totalBytes ≤ half the budget', () => {
    // 5 lines × 4 bytes = 20 bytes; budget 16 → trim to ≤ 8 → keep 2 lines
    const b = makeBuf(10, 16);
    for (const t of ['a', 'b', 'c', 'd', 'e']) b.append(makeLine(t, 4));
    expect(b.bytes).toBeLessThanOrEqual(8);
    expect(b.length).toBe(2);
    expect(b.getBySeq(3)?.rawData?.[0]).toBe('d'.charCodeAt(0));
    expect(b.getBySeq(4)?.rawData?.[0]).toBe('e'.charCodeAt(0));
  });

  it('reports trimmed when byte budget forces drops', () => {
    const b = makeBuf(10, 4);
    expect(b.append(makeLine('a', 2)).trimmed).toBe(false); // 2 ≤ 4
    expect(b.append(makeLine('b', 2)).trimmed).toBe(false); // 4 = 4 预算内
    const r = b.append(makeLine('c', 2));                    // 6 > 4 → 裁到 ≤ 2
    expect(r.trimmed).toBe(true);
    expect(b.length).toBe(1);
    expect(b.getBySeq(b.lastSeq)?.rawData?.[0]).toBe('c'.charCodeAt(0));
  });

  it('byte budget of 0 disables the check', () => {
    const b = makeBuf(10, 0);
    for (let i = 0; i < 5; i++) b.append(makeLine(String(i), 100));
    expect(b.length).toBe(5);
  });
});

describe('TerminalBuffer snapshot', () => {
  it('returns the whole window in stream order', () => {
    const b = makeBuf(10);
    for (const t of ['a', 'b', 'c']) b.append(makeLine(t));
    const lines = b.snapshot();
    expect(lines.map((l) => l.rawData?.[0])).toEqual(['a', 'b', 'c'].map((c) => c.charCodeAt(0)));
  });

  it('clamps range arguments', () => {
    const b = makeBuf(10);
    for (const t of ['a', 'b', 'c']) b.append(makeLine(t));
    expect(b.snapshot(1, 1).length).toBe(1);
    expect(b.snapshot(0, 99).length).toBe(3);
    expect(b.snapshot(-5, 1).length).toBe(2);
  });

  it('returns [] when empty', () => {
    expect(makeBuf().snapshot()).toEqual([]);
  });
});

describe('TerminalBuffer clear', () => {
  it('empties the buffer', () => {
    const b = makeBuf(3);
    b.append(makeLine('a'));
    b.append(makeLine('b'));
    b.clear();
    expect(b.length).toBe(0);
    expect(b.bytes).toBe(0);
    expect(b.getBySeq(0)).toBeNull();
  });

  it('keeps seqs monotonic across clear (no reuse)', () => {
    const b = makeBuf(3);
    b.append(makeLine('a'));
    b.clear();
    b.append(makeLine('b'));
    // 'b' is a NEW line — its seq must not collide with the old 'a' (seq 0)
    expect(b.firstSeq).toBe(1);
    expect(b.getBySeq(1)?.rawData?.[0]).toBe('b'.charCodeAt(0));
  });
});

describe('TerminalBuffer replaceAll', () => {
  it('replaces the whole buffer, trimming to capacity', () => {
    const b = makeBuf(3);
    b.append(makeLine('old'));
    b.replaceAll(['a', 'b', 'c', 'd'].map((t) => makeLine(t)));
    expect(b.length).toBe(3);
    expect(b.getBySeq(b.lastSeq)?.rawData?.[0]).toBe('d'.charCodeAt(0));
    expect(b.firstSeq).toBe(2); // 'old'(seq 0) + 4 行 → 容量 3 → 保留 [2..4]
  });

  it('clears everything when given empty', () => {
    const b = makeBuf(3);
    b.append(makeLine('a'));
    b.replaceAll([]);
    expect(b.length).toBe(0);
  });
});

describe('TerminalBuffer setLimits', () => {
  it('shrinking maxLines drops the oldest lines', () => {
    const b = makeBuf(5);
    for (const t of ['a', 'b', 'c', 'd', 'e']) b.append(makeLine(t));
    b.setLimits({ maxLines: 2 });
    expect(b.length).toBe(2);
    expect(b.getBySeq(b.firstSeq)?.rawData?.[0]).toBe('d'.charCodeAt(0));
    expect(b.getBySeq(b.lastSeq)?.rawData?.[0]).toBe('e'.charCodeAt(0));
  });

  it('growing maxLines keeps existing lines', () => {
    const b = makeBuf(2);
    b.append(makeLine('a'));
    b.append(makeLine('b'));
    b.setLimits({ maxLines: 10 });
    expect(b.length).toBe(2);
    expect(b.firstSeq).toBe(0);
  });

  it('re-applies the byte budget after change', () => {
    const b = makeBuf(10, 0);
    for (const t of ['a', 'b', 'c', 'd']) b.append(makeLine(t, 4));
    b.setLimits({ maxBytes: 16 });
    // 16 bytes → keep ≤ 8 → 2 lines
    expect(b.length).toBe(2);
  });

  it('maxLines clamps to at least 1', () => {
    const b = makeBuf(5);
    b.append(makeLine('a'));
    b.setLimits({ maxLines: 0 });
    expect(b.maxLines).toBe(1);
    expect(b.length).toBe(1);
  });
});
