import { describe, expect, it } from 'vitest';
import { TerminalTimeIndex, type TimeIndexEntry } from './TerminalTimeIndex';

interface LiveEntry extends TimeIndexEntry {}

function expectedLookup(entries: Map<number, number>, target: number): { entry: LiveEntry; status: 'exact' | 'nearest' | 'before-range' | 'after-range' } | null {
  if (!Number.isFinite(target) || entries.size === 0) return null;
  const sorted = [...entries].map(([seq, time]) => ({ seq, time }))
    .sort((a, b) => a.time - b.time || a.seq - b.seq);
  const predecessor = [...sorted].reverse().find((entry) => entry.time <= target);
  if (!predecessor) return { entry: sorted[0], status: 'before-range' };
  return {
    entry: predecessor,
    status: target > sorted[sorted.length - 1].time
      ? 'after-range'
      : predecessor.time === target ? 'exact' : 'nearest',
  };
}

/** Small deterministic PRNG; correctness tests must not depend on wall clock randomness. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe('TerminalTimeIndex', () => {
  it('supports large timestamps, rollback, and stable duplicate ordering', () => {
    const index = new TerminalTimeIndex();
    const now = Date.now();
    index.add(10, now + 300);
    index.add(11, now - 200);
    index.add(12, now + 100);
    index.add(13, now + 100);

    expect(index.lookup(now - 100)).toEqual({ entry: { seq: 11, time: now - 200 }, status: 'nearest' });
    expect(index.lookup(now + 100)).toEqual({ entry: { seq: 13, time: now + 100 }, status: 'exact' });
    expect(index.lookup(now + 301)).toEqual({ entry: { seq: 10, time: now + 300 }, status: 'after-range' });
    expect(index.lookup(now - 201)).toEqual({ entry: { seq: 11, time: now - 200 }, status: 'before-range' });
  });

  it('updates an existing sequence without changing size or retaining the old timestamp', () => {
    const index = new TerminalTimeIndex();
    const now = Date.now();
    index.add(7, now + 1000);
    index.add(8, now + 2000);
    index.add(7, now - 1000);

    expect(index.size).toBe(2);
    expect(index.lookup(now)).toEqual({ entry: { seq: 7, time: now - 1000 }, status: 'nearest' });
    expect(index.lookup(now + 3000)).toEqual({ entry: { seq: 8, time: now + 2000 }, status: 'after-range' });

    // Invalid replacement is ignored, matching the old add contract.
    index.add(7, Number.NaN);
    expect(index.lookup(now)).toEqual({ entry: { seq: 7, time: now - 1000 }, status: 'nearest' });
  });

  it('keeps seq map references valid through two-child deletion and boundary changes', () => {
    const index = new TerminalTimeIndex();
    const now = Date.now();
    const entries = [
      [0, 40], [1, 20], [2, 60], [3, 10], [4, 30],
      [5, 50], [6, 70], [7, 25], [8, 35], [9, 45], [10, 55],
    ] as const;
    for (const [seq, offset] of entries) index.add(seq, now + offset);

    // Root and internal two-child removals exercise physical successor transplant.
    index.delete(0);
    index.delete(2);
    index.delete(7);
    expect(index.size).toBe(entries.length - 3);
    expect(index.lookup(now + 34)?.entry).toEqual({ seq: 4, time: now + 30 });
    expect(index.lookup(now + 80)?.entry).toEqual({ seq: 6, time: now + 70 });

    index.delete(3);
    index.delete(6);
    expect(index.lookup(now)?.entry).toEqual({ seq: 1, time: now + 20 });
    expect(index.lookup(now + 80)?.entry).toEqual({ seq: 10, time: now + 55 });
    index.clear();
    expect(index.size).toBe(0);
    expect(index.lookup(now)).toBeNull();
  });

  it('derives before/after boundaries correctly while deleting current extrema', () => {
    const index = new TerminalTimeIndex();
    const oracle = new Map<number, number>();
    const base = Date.now();
    for (const [seq, offset] of [[1, -300], [2, -100], [3, 100], [4, 300], [5, 300]] as const) {
      index.add(seq, base + offset);
      oracle.set(seq, base + offset);
    }

    for (const seq of [1, 5, 4, 2, 3]) {
      index.delete(seq);
      oracle.delete(seq);
      for (const target of [base - 1000, base - 200, base, base + 200, base + 1000]) {
        expect(index.lookup(target)).toEqual(expectedLookup(oracle, target));
      }
    }
  });

  it('matches a sorted oracle across deterministic rollback, duplicates, updates, and deletes', () => {
    const index = new TerminalTimeIndex();
    const oracle = new Map<number, number>();
    const next = random(0x51_7e_2026);
    const base = Date.now();

    for (let step = 0; step < 900; step++) {
      const seq = Math.floor(next() * 90);
      if (next() < 0.66) {
        // Duplicate timestamp buckets and arbitrary rollback around a real epoch.
        const time = base + (Math.floor(next() * 41) - 20) * 1000;
        index.add(seq, time);
        oracle.set(seq, time);
      } else {
        index.delete(seq);
        oracle.delete(seq);
      }
      if (step % 13 === 0) {
        const target = base + (Math.floor(next() * 61) - 30) * 1000;
        expect(index.lookup(target)).toEqual(expectedLookup(oracle, target));
      }
    }

    for (let offset = -25; offset <= 25; offset++) {
      expect(index.lookup(base + offset * 1000)).toEqual(expectedLookup(oracle, base + offset * 1000));
    }
    expect(index.size).toBe(oracle.size);
  });

  it('returns value snapshots rather than mutable AVL nodes', () => {
    const index = new TerminalTimeIndex();
    const now = Date.now();
    index.add(1, now);
    const result = index.lookup(now)!;
    result.entry.time = now - 999999;
    result.entry.seq = 999999;
    expect(index.lookup(now)).toEqual({ entry: { seq: 1, time: now }, status: 'exact' });
  });

  it('ignores invalid timestamps and non-finite lookup targets', () => {
    const index = new TerminalTimeIndex();
    index.add(1, null);
    index.add(2, Number.POSITIVE_INFINITY);
    index.add(3, Number.NEGATIVE_INFINITY);
    expect(index.size).toBe(0);
    expect(index.lookup(Number.NaN)).toBeNull();
    expect(index.lookup(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
