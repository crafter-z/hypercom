/**
 * Tests for StreamingDecoderCache — the shared GBK-safe streaming decode cache.
 * Locks the caching/streaming/invalidation behaviors that prevent multi-byte
 * mojibake on serial traffic (see streamingDecoder.ts header).
 */
import { describe, it, expect } from 'vitest';
import { StreamingDecoderCache } from './streamingDecoder';

describe('StreamingDecoderCache', () => {
  it('returns the same cached decoder instance for a repeated port+label', () => {
    const cache = new StreamingDecoderCache();
    expect(cache.get('COM3', 'utf-8')).toBe(cache.get('COM3', 'utf-8'));
  });

  it('reassembles a multi-byte char split across two streaming decode calls', () => {
    const cache = new StreamingDecoderCache();
    const decoder = cache.get('COM3', 'utf-8');
    // '€' = E2 82 AC. A fresh decoder per event would emit U+FFFD on both halves;
    // the persistent streaming decoder retains the partial and completes it.
    const first = decoder.decode(new Uint8Array([0xe2, 0x82]), { stream: true });
    const second = decoder.decode(new Uint8Array([0xac]), { stream: true });
    expect(first).toBe('');
    expect(second).toBe('€');
  });

  it('invalidates stale labels for a port when a new label is requested', () => {
    const cache = new StreamingDecoderCache();
    const utf8First = cache.get('COM3', 'utf-8');
    cache.get('COM3', 'gbk'); // creating under a new label drops the utf-8 entry
    const utf8Again = cache.get('COM3', 'utf-8');
    expect(utf8Again).not.toBe(utf8First);
  });

  it('clearPort drops only that port, leaving other ports cached', () => {
    const cache = new StreamingDecoderCache();
    const com3 = cache.get('COM3', 'utf-8');
    const com4 = cache.get('COM4', 'utf-8');
    cache.clearPort('COM3');
    expect(cache.get('COM3', 'utf-8')).not.toBe(com3);
    expect(cache.get('COM4', 'utf-8')).toBe(com4);
  });

  it('falls back to utf-8 for an unsupported label instead of throwing', () => {
    const cache = new StreamingDecoderCache();
    const decoder = cache.get('COM3', 'definitely-not-an-encoding');
    expect(decoder.decode(new Uint8Array([0x41]))).toBe('A');
  });
});
