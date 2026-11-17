import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pluginFsService } from '../services/pluginFs';
import { attachPluginFsLease, PluginFsContext, pluginFsTransferables, releasePluginFsResult, releasePluginFsResultWithRetry } from './pluginFs';
vi.mock('../services/pluginFs', () => ({ pluginFsService: {
  openSession: vi.fn(), closeSession: vi.fn(), readRanges: vi.fn(), listDirectoryPage: vi.fn(), cancel: vi.fn(), release: vi.fn(),
} }));
const sessionId = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';
const range = { rel: 'assets/a', offset: 0, length: 3 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(pluginFsService.openSession).mockReset().mockResolvedValue(sessionId);
  vi.mocked(pluginFsService.readRanges).mockReset().mockImplementation(async () => ({ results: [{ rel: 'assets/a', bytes: new Uint8Array([1, 2, 3]) }] }));
  vi.mocked(pluginFsService.listDirectoryPage).mockReset().mockResolvedValue({ entries: [], nextCursor: null });
  vi.mocked(pluginFsService.closeSession).mockReset().mockResolvedValue();
  vi.mocked(pluginFsService.cancel).mockReset().mockResolvedValue();
  vi.mocked(pluginFsService.release).mockReset().mockResolvedValue();
});
afterEach(() => { vi.restoreAllMocks(); });

describe('epoch-scoped lazy FS context', () => {
  it('does not open at construction/stop and opens once for multiple reads', async () => {
    const unused = new PluginFsContext('p', 'g', 1); unused.stop();
    expect(pluginFsService.openSession).not.toHaveBeenCalled();
    const context = new PluginFsContext('p', 'g', 2);
    const first = await context.readRanges(requestId, [range], 'background');
    expect(pluginFsService.release).not.toHaveBeenCalled();
    const second = await context.readRanges('second', [range], 'background');
    expect(pluginFsService.openSession).toHaveBeenCalledExactlyOnceWith('p', 'g');
    await releasePluginFsResult(first); await releasePluginFsResult(second);
    context.stop();
  });
  it('retains a single-read lease until the final byte result is released exactly once', async () => {
    const context = new PluginFsContext('p', 'g', 1);
    const bytes = await context.readRange(requestId, range, 'interactive');
    expect(pluginFsService.release).not.toHaveBeenCalled();
    await releasePluginFsResult(bytes); await releasePluginFsResult(bytes);
    expect(pluginFsService.release).toHaveBeenCalledExactlyOnceWith('p', sessionId, requestId);
    context.stop();
  });
  it('closes a late native open on stop, never dispatches the retired read', async () => {
    const opening = deferred<string>(); vi.mocked(pluginFsService.openSession).mockReturnValueOnce(opening.promise);
    const context = new PluginFsContext('p', 'g', 1);
    const request = context.readRange(requestId, range, 'background');
    const rejection = expect(request).rejects.toThrow('retired');
    context.stop(); opening.resolve(sessionId); await rejection;
    expect(pluginFsService.closeSession).toHaveBeenCalledExactlyOnceWith('p', sessionId);
    expect(pluginFsService.readRanges).not.toHaveBeenCalled();
  });
  it('cancels an in-flight native read and releases late bytes instead of delivering', async () => {
    const reading = deferred<{ results: Array<{ rel: string; bytes: Uint8Array }> }>();
    const started = deferred<void>();
    vi.mocked(pluginFsService.readRanges).mockImplementationOnce(() => { started.resolve(); return reading.promise; });
    const context = new PluginFsContext('p', 'g', 1);
    const request = context.readRange(requestId, range, 'background');
    const rejection = expect(request).rejects.toMatchObject({ name: 'AbortError' });
    await started.promise;
    await context.cancel(requestId);
    reading.resolve({ results: [{ rel: range.rel, bytes: new Uint8Array([1]) }] }); await rejection;
    expect(pluginFsService.cancel).toHaveBeenCalledWith('p', sessionId, requestId);
    expect(pluginFsService.release).toHaveBeenCalledWith('p', sessionId, requestId);
    context.stop();
  });
  it('does not release an in-flight native byte lease merely because its Worker stopped', async () => {
    const reading = deferred<{ results: Array<{ rel: string; bytes: Uint8Array }> }>();
    const started = deferred<void>();
    vi.mocked(pluginFsService.readRanges).mockImplementationOnce(() => { started.resolve(); return reading.promise; });
    const context = new PluginFsContext('p', 'g', 1);
    const request = context.readRanges(requestId, [range], 'background');
    const rejected = expect(request).rejects.toThrow('retired');
    await started.promise; context.stop();
    expect(pluginFsService.cancel).toHaveBeenCalledWith('p', sessionId, requestId);
    expect(pluginFsService.closeSession).toHaveBeenCalledWith('p', sessionId);
    expect(pluginFsService.release).not.toHaveBeenCalled();
    reading.resolve({ results: [{ rel: range.rel, bytes: new Uint8Array([1]) }] }); await rejected;
    expect(pluginFsService.release).toHaveBeenCalledExactlyOnceWith('p', sessionId, requestId);
  });
  it('handles cancel-before-read without an unnecessary open IPC', async () => {
    const context = new PluginFsContext('p', 'g', 1);
    await context.cancel(requestId);
    await expect(context.readRange(requestId, range, 'background')).rejects.toMatchObject({ name: 'AbortError' });
    expect(pluginFsService.openSession).not.toHaveBeenCalled(); context.stop();
  });
  it('releases malformed/rejected native reads and post-read authority failures', async () => {
    const context = new PluginFsContext('p', 'g', 1);
    vi.mocked(pluginFsService.readRanges).mockRejectedValueOnce(new Error('bad raw frame'));
    await expect(context.readRanges(requestId, [range], 'background')).rejects.toThrow('bad raw frame');
    expect(pluginFsService.release).toHaveBeenCalledWith('p', sessionId, requestId);
    vi.mocked(pluginFsService.readRanges).mockImplementationOnce(async () => { context.stop(); return { results: [] }; });
    await expect(context.readRanges('other', [range], 'background')).rejects.toThrow('retired');
    expect(pluginFsService.release).toHaveBeenCalledWith('p', sessionId, 'other');
  });
  it('reopens on the next new request after native session invalidation, never retries old requests', async () => {
    const context = new PluginFsContext('p', 'g', 1);
    vi.mocked(pluginFsService.readRanges).mockRejectedValueOnce('PLUGIN_FS_SESSION_INVALID: expired');
    await expect(context.readRanges(requestId, [range], 'background')).rejects.toContain('PLUGIN_FS_SESSION_INVALID');
    const result = await context.readRanges('next', [range], 'background');
    expect(pluginFsService.openSession).toHaveBeenCalledTimes(2);
    expect(pluginFsService.readRanges).toHaveBeenCalledTimes(2);
    await releasePluginFsResult(result); context.stop();
  });
  it('releases a single-range item error instead of retaining a native lease', async () => {
    const context = new PluginFsContext('p', 'g', 1);
    vi.mocked(pluginFsService.readRanges).mockResolvedValueOnce({ results: [{ rel: range.rel, error: 'missing' }] });
    await expect(context.readRange(requestId, range, 'background')).rejects.toThrow('missing');
    expect(pluginFsService.release).toHaveBeenCalledWith('p', sessionId, requestId); context.stop();
  });
  it('retries a failed native release and drops historical request bookkeeping even on failure', async () => {
    const context = new PluginFsContext('p', 'g', 1);
    const result = await context.readRanges(requestId, [range], 'background');
    vi.mocked(pluginFsService.release).mockRejectedValueOnce(new Error('release transport failed'));
    await expect(releasePluginFsResult(result)).rejects.toThrow('release transport failed');
    context.stop();
    expect(pluginFsService.cancel).not.toHaveBeenCalled();
    await releasePluginFsResult(result); await releasePluginFsResult(result);
    expect(pluginFsService.release).toHaveBeenCalledTimes(2);
  });
  it('coalesces concurrent release attempts and marks the lease released only after success', async () => {
    const finished = deferred<void>(); const release = vi.fn(() => finished.promise);
    const result = {}; attachPluginFsLease(result, release);
    const first = releasePluginFsResult(result), second = releasePluginFsResult(result);
    await Promise.resolve(); expect(release).toHaveBeenCalledOnce();
    finished.resolve(); await Promise.all([first, second]);
    await releasePluginFsResult(result); expect(release).toHaveBeenCalledOnce();
  });
  it('bounds cleanup to two attempts, reports failure and still allows a later explicit retry', async () => {
    const release = vi.fn().mockRejectedValue(new Error('release unavailable'));
    const result = {}; attachPluginFsLease(result, release); const report = vi.fn();
    await releasePluginFsResultWithRetry(result, report);
    expect(release).toHaveBeenCalledTimes(2); expect(report).toHaveBeenCalledOnce();
    release.mockResolvedValue(undefined); await releasePluginFsResult(result);
    expect(release).toHaveBeenCalledTimes(3);
  });
  it('preserves operation failures while bounded cleanup fails and removes active request IDs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const context = new PluginFsContext('p', 'g', 1);
    vi.mocked(pluginFsService.readRanges).mockRejectedValueOnce(new Error('actual read failed'));
    vi.mocked(pluginFsService.release).mockRejectedValue(new Error('cleanup failed'));
    await expect(context.readRanges(requestId, [range], 'background')).rejects.toThrow('actual read failed');
    expect(pluginFsService.release).toHaveBeenCalledTimes(2); expect(warn).toHaveBeenCalledOnce();
    context.stop(); expect(pluginFsService.cancel).not.toHaveBeenCalled();
  });
  it('settles cancellation without awaiting an unfinished lazy open and prevents later native dispatch', async () => {
    const opening = deferred<string>(); vi.mocked(pluginFsService.openSession).mockReturnValueOnce(opening.promise);
    const context = new PluginFsContext('p', 'g', 1);
    const reading = context.readRanges(requestId, [range], 'background');
    const rejected = expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    await context.cancel(requestId);
    expect(pluginFsService.cancel).not.toHaveBeenCalled();
    expect(pluginFsService.readRanges).not.toHaveBeenCalled();
    opening.resolve(sessionId); await rejected;
    expect(pluginFsService.readRanges).not.toHaveBeenCalled(); context.stop();
  });
  it('retains directory page metadata lease until host delivery or discard releases it', async () => {
    const context = new PluginFsContext('p', 'g', 1);
    const result = await context.listDirectoryPage(requestId, { grantId: 'grant', priority: 'background' });
    expect(pluginFsService.release).not.toHaveBeenCalled();
    await releasePluginFsResult(result); await releasePluginFsResult(result);
    expect(pluginFsService.release).toHaveBeenCalledExactlyOnceWith('p', sessionId, requestId); context.stop();
  });
  it('releases a retired in-flight directory page without delivering it', async () => {
    const page = deferred<{ entries: []; nextCursor: null }>(); const started = deferred<void>();
    vi.mocked(pluginFsService.listDirectoryPage).mockImplementationOnce(() => { started.resolve(); return page.promise; });
    const context = new PluginFsContext('p', 'g', 1);
    const reading = context.listDirectoryPage(requestId, { grantId: 'grant', priority: 'background' });
    const rejected = expect(reading).rejects.toThrow('retired');
    await started.promise; context.stop(); expect(pluginFsService.release).not.toHaveBeenCalled();
    page.resolve({ entries: [], nextCursor: null }); await rejected;
    expect(pluginFsService.release).toHaveBeenCalledExactlyOnceWith('p', sessionId, requestId);
  });
  it('deduplicates transfer lists for batch subarrays sharing one payload', () => {
    const payload = new Uint8Array([1, 2, 3]);
    expect(pluginFsTransferables({ results: [{ rel: 'a', bytes: payload.subarray(0, 1) }, { rel: 'b', bytes: payload.subarray(1) }, { rel: 'c', error: 'missing' }] })).toEqual([payload.buffer]);
  });
});
