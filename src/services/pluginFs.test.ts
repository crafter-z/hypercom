import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decodePluginFsFrame, pluginFsService } from './pluginFs';
import type { PluginFsRange } from './pluginFs';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

function frame(results: unknown[], payload = new Uint8Array([1, 2, 3])): ArrayBuffer {
  const metadata = new TextEncoder().encode(JSON.stringify({ results }));
  const buffer = new ArrayBuffer(8 + metadata.length + payload.length);
  new Uint8Array(buffer).set([72, 67, 70, 82]);
  new DataView(buffer).setUint32(4, metadata.length, true);
  new Uint8Array(buffer).set(metadata, 8);
  new Uint8Array(buffer).set(payload, 8 + metadata.length);
  return buffer;
}
const ranges: PluginFsRange[] = [{ rel: 'assets/a', offset: 100, length: 3 }];
beforeEach(() => invoke.mockReset());

describe('plugin FS raw frames', () => {
  it('decodes raw payload without exposing frame metadata to a single range', () => {
    const result = decodePluginFsFrame(frame([{ rel: 'assets/a', offset: 0, length: 3 }]), ranges);
    const item = result.results[0];
    expect('bytes' in item && [...item.bytes]).toEqual([1, 2, 3]);
    expect('bytes' in item && item.bytes.buffer.byteLength).toBe(3);
  });
  it('shares only the payload for batch results and preserves per-entry errors/empty EOF', () => {
    const batch = [ranges[0], { rel: 'b', offset: 0, length: 1 }, { rel: 'c', offset: 0, length: 1 }];
    const result = decodePluginFsFrame(frame([
      { rel: 'assets/a', offset: 0, length: 3 }, { rel: 'b', offset: 3, length: 0, error: 'missing' },
      { rel: 'c', offset: 3, length: 0 },
    ]), batch);
    expect(result.results[1]).toEqual({ rel: 'b', error: 'missing' });
    const first = result.results[0], last = result.results[2];
    expect('bytes' in first && 'bytes' in last && first.bytes.buffer === last.bytes.buffer).toBe(true);
  });
  it.each([null, 'AQID', [1, 2, 3], new Uint8Array([1, 2, 3]), new ArrayBuffer(7)].map(value => ({ value })))('rejects non-raw or short frames: %j', ({ value }) => {
    expect(() => decodePluginFsFrame(value, ranges)).toThrow('raw frame');
  });
  it.each<{ results: unknown[] }>([
    { results: [] }, { results: [{ rel: 'other', offset: 0, length: 3 }] }, { results: [{ rel: 'assets/a', offset: 1, length: 2 }] },
    { results: [{ rel: 'assets/a', offset: 0, length: 4 }] }, { results: [{ rel: 'assets/a', offset: 0, length: 2 }] },
    { results: [{ rel: 'assets/a', offset: 0, length: -1 }] }, { results: [{ rel: 'assets/a', offset: 0, length: 3, error: 'bad' }] },
    { results: [{ rel: 'assets/a', offset: 0, length: 3, error: null }] }, { results: [{ rel: 'assets/a', offset: 0, length: 3, extra: true }] },
  ])('rejects inconsistent metadata: %j', ({ results }) => {
    expect(() => decodePluginFsFrame(frame(results), ranges)).toThrow('raw frame');
  });
  it('rejects bad magic, metadata length, malformed UTF-8 and overlapping descriptors', () => {
    const badMagic = frame([{ rel: 'assets/a', offset: 0, length: 3 }]);
    new Uint8Array(badMagic)[0] = 0;
    expect(() => decodePluginFsFrame(badMagic, ranges)).toThrow('raw frame');
    const badLength = frame([]); new DataView(badLength).setUint32(4, 0xffffffff, true);
    expect(() => decodePluginFsFrame(badLength, ranges)).toThrow('raw frame');
    const badUtf8 = frame([]); new Uint8Array(badUtf8)[8] = 0xff;
    expect(() => decodePluginFsFrame(badUtf8, ranges)).toThrow('raw frame');
    expect(() => decodePluginFsFrame(frame([
      { rel: 'assets/a', offset: 0, length: 2 }, { rel: 'b', offset: 1, length: 1 },
    ]), [ranges[0], { rel: 'b', offset: 0, length: 1 }])).toThrow('raw frame');
  });
  it('rejects invalid UTF-8 even inside otherwise valid JSON strings and oversized metadata', () => {
    const metadata = new TextEncoder().encode(JSON.stringify({ results: [{ rel: 'aX', offset: 0, length: 0 }] }));
    const raw = new ArrayBuffer(8 + metadata.length);
    new Uint8Array(raw).set([72, 67, 70, 82]); new DataView(raw).setUint32(4, metadata.length, true);
    metadata[metadata.indexOf(88)] = 0xff; new Uint8Array(raw).set(metadata, 8);
    expect(() => decodePluginFsFrame(raw, [{ rel: 'a\ufffd', offset: 0, length: 0 }])).toThrow('raw frame');
    const oversized = new ArrayBuffer(8 + 512 * 1024 + 1);
    new Uint8Array(oversized).set([72, 67, 70, 82]); new DataView(oversized).setUint32(4, 512 * 1024 + 1, true);
    expect(() => decodePluginFsFrame(oversized, ranges)).toThrow('raw frame');
    expect(() => decodePluginFsFrame(frame([], new Uint8Array()), [])).toThrow('raw frame');
  });
  it('uses only native raw commands and camelCase wire without spoofing Tauri headers', async () => {
    invoke.mockResolvedValueOnce(frame([{ rel: 'assets/a', offset: 0, length: 3 }]));
    await pluginFsService.readRanges('p', 'g', 's', 'r', ranges, 'background');
    expect(invoke).toHaveBeenCalledExactlyOnceWith('plugin_fs_read_ranges', {
      pluginId: 'p', expectedGeneration: 'g', sessionId: 's', requestId: 'r', ranges, priority: 'background',
    });
    invoke.mockResolvedValueOnce([1, 2, 3]);
    await expect(pluginFsService.readRanges('p', 'g', 's', 'r', ranges, 'background')).rejects.toThrow('raw frame');
  });
  it('validates session and page response shapes and forwards directory fields', async () => {
    invoke.mockResolvedValueOnce('not-a-session');
    await expect(pluginFsService.openSession('p', 'g')).rejects.toThrow('session');
    invoke.mockResolvedValueOnce({ entries: [], nextCursor: 'cursor' });
    await expect(pluginFsService.listDirectoryPage('p', 'g', 's', 'r', {
      grantId: 'grant', relPath: 'sub', limit: 2, priority: 'background',
    })).resolves.toEqual({ entries: [], nextCursor: 'cursor' });
    expect(invoke).toHaveBeenLastCalledWith('plugin_fs_list_directory_page', {
      pluginId: 'p', expectedGeneration: 'g', sessionId: 's', requestId: 'r',
      grantId: 'grant', relPath: 'sub', limit: 2, priority: 'background',
    });
    invoke.mockResolvedValueOnce({ entries: [], nextCursor: 12 });
    await expect(pluginFsService.listDirectoryPage('p', 'g', 's', 'r', { grantId: 'grant', priority: 'background' })).rejects.toThrow('page');
  });
});
