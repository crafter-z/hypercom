import { describe, expect, it } from 'vitest';
import { TerminalHeightIndex } from './TerminalHeightIndex';

describe('TerminalHeightIndex', () => {
  it('allocates nothing for unvisited million-record histories and supports large seqs', () => {
    const index = new TerminalHeightIndex(20);
    const first = 2 ** 40;
    expect(index.range(first, first + 1_000_000)).toBe(20_000_000);
    expect(index.keyAt(first, 1_000_000, 19_999_999)).toBe(first + 999_999);
    expect(index.size).toBe(0);
  });
  it('matches a linear oracle across updates, deletion, trim, and inverse queries', () => {
    const index = new TerminalHeightIndex(18), heights = Array<number>(257).fill(18);
    let seed = 12345;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    for (let step = 0; step < 1500; step++) {
      const key = random() % heights.length;
      const height = 18 * (1 + random() % 12);
      heights[key] = height; index.set(key, height);
      const first = random() % 40, end = first + random() % (heights.length - first);
      expect(index.range(first, end)).toBe(heights.slice(first, end).reduce((a, b) => a + b, 0));
      const point = random() % (index.range(first, heights.length) + 100);
      let expected = first, top = heights[first];
      while (top <= point && expected < heights.length - 1) top += heights[++expected];
      expect(index.keyAt(first, heights.length - first, point)).toBe(expected);
    }
    index.trimBefore(100);
    expect(index.range(0, 100)).toBe(1800);
    expect(index.range(100, heights.length)).toBe(heights.slice(100).reduce((a, b) => a + b, 0));
    index.clear();
    expect(index.size).toBe(0);
    expect(index.range(0, heights.length)).toBe(heights.length * 18);
  });
  it('bounds cache memory and removes evicted corrections from prefix sums', () => {
    const index = new TerminalHeightIndex(10, 4);
    for (let key = 0; key < 100; key++) index.set(key, 100);
    expect(index.size).toBe(4);
    expect(index.range(0, 100)).toBe(1000 + 4 * 90);
    index.set(99, 10);
    expect(index.size).toBe(3);
    index.trimBefore(99);
    expect(index.size).toBe(0);
  });
});
