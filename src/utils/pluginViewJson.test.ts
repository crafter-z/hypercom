import { describe, expect, it } from 'vitest';
import { boundedPluginViewJson } from './pluginViewJson';

describe('plugin view JSON boundary', () => {
  it.each([new ArrayBuffer(1024 * 1024), new DataView(new ArrayBuffer(16)), new Map([['a', 1]]), new Set([1]), new Uint8Array([1]), new Date()])('rejects non-JSON containers rather than accounting them as an empty object', value => {
    expect(() => boundedPluginViewJson({ value }, 256 * 1024)).toThrow('JSON values only');
  });
  it.each([false, true])('rejects lone surrogate values and object keys before the Rust wire, fallback: %s', fallback => {
    const descriptor = Object.getOwnPropertyDescriptor(String.prototype, 'isWellFormed');
    if (fallback) Object.defineProperty(String.prototype, 'isWellFormed', { value: undefined, configurable: true });
    try {
      for (const invalid of ['\ud800', '\udfff', 'a\ud800b', '\ud800\ud800']) {
        expect(() => boundedPluginViewJson({ nested: [invalid] }, 1024)).toThrow('well-formed UTF-16');
        expect(() => boundedPluginViewJson({ [invalid]: true }, 1024)).toThrow('well-formed UTF-16');
      }
      expect(boundedPluginViewJson({ emoji: '\ud83d\ude00' }, 1024).value).toEqual({ emoji: '\ud83d\ude00' });
    } finally {
      if (fallback && descriptor) Object.defineProperty(String.prototype, 'isWellFormed', descriptor);
      else if (fallback) Reflect.deleteProperty(String.prototype, 'isWellFormed');
    }
  });
  it('retains only an independent normalized JSON value and charges UTF-8 bytes', () => {
    const original = { rows: [{ label: '温度', value: 26.3 }], paused: false };
    const normalized = boundedPluginViewJson(original, 256);
    original.rows[0].value = 100;
    expect(normalized.value).toEqual({ rows: [{ label: '温度', value: 26.3 }], paused: false });
    expect(() => boundedPluginViewJson('温'.repeat(100), 200)).toThrow('capacity');
  });
  it('rejects cycles, nonfinite numbers and deep structures before serialization', () => {
    const cycle: { child?: unknown } = {}; cycle.child = cycle;
    expect(() => boundedPluginViewJson(cycle, 256)).toThrow('cycles');
    expect(() => boundedPluginViewJson({ temperature: NaN }, 256)).toThrow('finite');
    let deep: unknown = null; for (let i = 0; i < 100; i++) deep = { next: deep };
    expect(() => boundedPluginViewJson(deep, 256)).toThrow('complexity');
  });
});
