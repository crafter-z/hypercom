import { afterEach, describe, expect, it, vi } from 'vitest';
import { pluginFileHandleService } from '../services/pluginFileHandle';
import type { PluginFileSelection } from '../services/pluginFileHandle';
import { pluginFsService } from '../services/pluginFs';
import { PluginFileHandleHost } from './pluginFileHandle';
import { PLUGIN_FILE_HANDLE_SDK } from './pluginFileHandleSdk';
import { pluginFsTransferables, releasePluginFsResult } from './pluginFs';

const handleId = '12345678-abcd-1234-abcd-123456789abc';
const sessionId = '12345678-abcd-1234-abcd-123456789afe';
const selection: PluginFileSelection = { handleId, mode: 'read', name: 'log.txt', size: 3 };
const nativeSelection = { ...selection, activeHandles: [handleId] };
function fixture() {
  const acquire = vi.fn().mockResolvedValue(sessionId);
  const invalidate = vi.fn();
  const host = new PluginFileHandleHost('com.example.demo', 'generation', { acquire, invalidate });
  return { host, acquire, invalidate };
}
function deferred<T>() {
  let complete!: (value: T) => void;
  const promise = new Promise<T>(resolve => { complete = resolve; });
  return { promise, complete };
}
afterEach(() => vi.restoreAllMocks());

describe('selected file host ownership', () => {
  it('does not accept paths and a cancel-before-dispatch never opens a session', async () => {
    const { host, acquire } = fixture();
    await expect(host.dispatch('fs.openFile', { requestId: 'bad', options: { path: 'C:/private.log' } })).rejects.toThrow('unsupported');
    await host.dispatch('fs.cancelFileRequest', { requestId: 'early' });
    await expect(host.dispatch('fs.openFile', { requestId: 'early' })).rejects.toMatchObject({ name: 'AbortError' });
    expect(acquire).not.toHaveBeenCalled();
  });

  it('closes a late native selection rather than delivering it to a retired Worker', async () => {
    const { host } = fixture();
    const active = deferred<typeof nativeSelection>();
    const pick = vi.spyOn(pluginFileHandleService, 'pick').mockReturnValue(active.promise);
    const cancel = vi.spyOn(pluginFsService, 'cancel').mockResolvedValue();
    const close = vi.spyOn(pluginFileHandleService, 'close').mockResolvedValue();
    const operation = host.dispatch('fs.openFile', { requestId: 'pick' });
    const failed = expect(operation).rejects.toThrow('retired');
    await vi.waitFor(() => expect(pick).toHaveBeenCalled());
    host.stop();
    active.complete(nativeSelection);
    await failed;
    expect(cancel).toHaveBeenCalledWith('com.example.demo', sessionId, 'pick');
    expect(close).toHaveBeenCalledWith({ pluginId: 'com.example.demo', sessionId, expectedGeneration: 'generation' }, handleId);
  });

  it('does not expose native session data and holds a read lease through host delivery', async () => {
    const { host } = fixture();
    vi.spyOn(pluginFileHandleService, 'pick').mockResolvedValue(nativeSelection);
    const opened = await host.dispatch('fs.openFile', { requestId: 'pick' });
    expect(opened).toEqual(selection);
    expect(host.readSource(handleId)).toEqual({ handleId, sessionId, size: 3 });
    await expect(host.dispatch('fs.commitFile', { requestId: 'wrong-mode', handleId })).rejects.toThrow('PLUGIN_FILE_HANDLE_INVALID');
    const bytes = new Uint8Array([2, 3]);
    const read = vi.spyOn(pluginFileHandleService, 'read').mockResolvedValue(bytes);
    const release = vi.spyOn(pluginFsService, 'release').mockResolvedValue();
    const result = await host.dispatch('fs.readFileWindow', { requestId: 'read', handleId, offset: 1, length: 8 });
    expect(pluginFsTransferables(result)).toEqual([bytes.buffer]);
    expect(read).toHaveBeenCalledWith({ pluginId: 'com.example.demo', expectedGeneration: 'generation', sessionId, requestId: 'read' }, handleId, 1, 8, 2);
    expect(release).not.toHaveBeenCalled();
    await releasePluginFsResult(result);
    expect(release).toHaveBeenCalledWith('com.example.demo', sessionId, 'read');
  });
});

describe('selected file Worker wrappers', () => {
  type Reader = { handleId: string; windows: (options: { chunkSize: number }) => AsyncIterable<Uint8Array> };
  type Writer = { write: (bytes: Uint8Array) => Promise<number>; commit: () => Promise<{ bytesWritten: number }> };
  function sdk(callHost: (op: string, args: Record<string, unknown>) => Promise<unknown>) {
    return new Function('callHost', `${PLUGIN_FILE_HANDLE_SDK}; return pluginFileSdk;`)(callHost) as {
      openFile: () => Promise<Reader>; createFile: () => Promise<Writer>;
    };
  }

  it('reads lazily and explicitly closes the handle when iteration stops', async () => {
    const rpc = vi.fn().mockImplementation(async (op: string) => op === 'fs.openFile' ? selection : new Uint8Array([5]));
    const reader = await sdk(rpc).openFile();
    expect(rpc).toHaveBeenCalledTimes(1);
    for await (const bytes of reader.windows({ chunkSize: 1 })) {
      expect(bytes).toEqual(new Uint8Array([5]));
      break;
    }
    expect(rpc.mock.calls.map(call => call[0])).toEqual(['fs.openFile', 'fs.readFileWindow', 'fs.closeFile']);
    expect(rpc.mock.calls[1][1]).toMatchObject({ offset: 0, length: 1 });
  });

  it('sends the selected bytes only and publishes explicitly', async () => {
    const rpc = vi.fn().mockImplementation(async (op: string) => ({
      'fs.createFile': { ...selection, mode: 'write' }, 'fs.writeFileChunk': 2, 'fs.commitFile': { bytesWritten: 2 },
    })[op as 'fs.createFile' | 'fs.writeFileChunk' | 'fs.commitFile']);
    const writer = await sdk(rpc).createFile();
    await writer.write(new Uint8Array([8, 1, 2, 9]).subarray(1, 3));
    const sent = rpc.mock.calls[1][1].bytes as Uint8Array;
    expect(sent).toEqual(new Uint8Array([1, 2]));
    expect(sent.buffer.byteLength).toBe(2);
    await expect(writer.commit()).resolves.toEqual({ bytesWritten: 2 });
    expect(rpc.mock.calls.map(call => call[0])).toEqual(['fs.createFile', 'fs.writeFileChunk', 'fs.commitFile']);
  });
});
