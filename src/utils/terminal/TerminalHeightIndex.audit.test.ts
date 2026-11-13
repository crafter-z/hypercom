import { describe, expect, it } from 'vitest';
import { TerminalHeightIndex } from './TerminalHeightIndex';

// A deliberately small dense ledger, not a second tree/geometry implementation.
// Exercises FIFO order across replacement, two-child deletion and re-insertion.
describe('TerminalHeightIndex independent audit', () => {
  it('keeps prefix sums and inverse boundaries consistent under bounded FIFO churn', () => {
    const estimate = 12.5, capacity = 17, first = 2 ** 40;
    const index = new TerminalHeightIndex(estimate, capacity);
    const ledger = new Map<number, number>();
    let seed = 0x98765;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    for (let step = 0; step < 2400; step++) {
      const key = first + random() % 61;
      const value = estimate + (random() % 11) * 2.25;
      index.set(key, value);
      if (value === estimate) ledger.delete(key);
      else {
        ledger.set(key, value);
        if (ledger.size > capacity) ledger.delete(ledger.keys().next().value!);
      }
      if (step % 13 === 0) {
        const cutoff = first + random() % 20;
        index.trimBefore(cutoff);
        for (const key of ledger.keys()) if (key < cutoff) ledger.delete(key);
      }
      expect(index.size).toBe(ledger.size);
      const start = first + random() % 25;
      let prefix = 0;
      for (let key = start; key < first + 61; key++) {
        const height = ledger.get(key) ?? estimate;
        expect(index.height(key)).toBe(height);
        expect(index.range(start, key)).toBe(prefix);
        expect(index.keyAt(start, first + 61 - start, prefix)).toBe(key);
        expect(index.keyAt(start, first + 61 - start, prefix + height - 0.125)).toBe(key);
        prefix += height;
      }
      expect(index.range(start, first + 61)).toBe(prefix);
      expect(index.keyAt(start, first + 61 - start, prefix + 1000)).toBe(first + 60);
      expect(index.keyAt(start, first + 61 - start, -1)).toBe(start);
    }
  });

  it('does not refresh FIFO age on update, but a deleted and remeasured key is new', () => {
    const index = new TerminalHeightIndex(10, 3);
    index.set(20, 20); index.set(10, 30); index.set(30, 40);
    index.set(20, 50); index.set(40, 60);
    expect(index.height(20)).toBe(10);
    index.set(10, 10); index.set(10, 70); index.set(50, 80);
    expect(index.height(30)).toBe(10);
    expect(index.height(10)).toBe(70);
    expect(index.range(0, 60)).toBe(600 + 50 + 60 + 70);
    index.trimBefore(51);
    expect(index.size).toBe(0);
    expect(index.range(0, 60)).toBe(600);
  });

  it('rejects non-finite heights without corrupting sums or evicting valid entries', () => {
    const index = new TerminalHeightIndex(18, 2);
    index.set(1, 36); index.set(2, 54);
    for (const height of [NaN, Infinity, -Infinity]) expect(index.set(3, height)).toBe(false);
    expect(index.size).toBe(2);
    expect(index.range(0, 4)).toBe(126);
    expect(index.set(1, -100)).toBe(true);
    expect(index.height(1)).toBe(18);
    expect(index.range(0, 4)).toBe(108);
    index.clear(); index.set(2, 72);
    expect(index.range(0, 4)).toBe(126);
  });
});
