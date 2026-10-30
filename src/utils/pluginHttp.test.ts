import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../stores/useAppStore';
import { cancelPluginHttp, executePluginHttp, STREAM_IDLE_TIMEOUT_MS } from './pluginHttp';

const open = vi.fn();
const read = vi.fn();
const cancel = vi.fn();

vi.mock('../services/tauri', () => ({
  pluginService: {
    pluginHttpOpen: (...args: unknown[]) => open(...args),
    pluginHttpRead: (...args: unknown[]) => read(...args),
    pluginHttpCancel: (...args: unknown[]) => cancel(...args),
  },
}));

const pluginId = 'com.example.http';
const entry = {
  id: pluginId,
  installGeneration: 'install-a',
  enabled: true,
  grantedPermissions: ['http:request'],
};

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  open.mockReset();
  read.mockReset();
  cancel.mockReset();
  cancel.mockResolvedValue(undefined);
  useAppStore.getState().setConfig({ revision: 0, pluginConfigs: [entry] });
  open.mockResolvedValue({ requestId: '', status: 200, headers: {}, url: 'https://example.com/' });
});

afterEach(() => {
  cancelPluginHttp(pluginId);
  cancelPluginHttp('com.example.other');
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('full HTTP request accumulation', () => {
  it('pulls every chunk and appends the final non-empty done chunk', async () => {
    open.mockResolvedValue({ status: 201, headers: { 'x-test': 'yes' }, url: 'https://example.com/final' });
    read
      .mockResolvedValueOnce({ base64: base64(new TextEncoder().encode('hello ')), done: false })
      .mockResolvedValueOnce({ base64: base64(new TextEncoder().encode('world')), done: true });
    const result = await executePluginHttp(pluginId, 'http.request', {
      method: 'POST',
      url: 'https://example.com/',
      headers: { 'content-type': 'text/plain' },
      body: 'payload',
    }) as { status: number; headers: Record<string, string>; url: string; body: string };
    expect(result).toEqual({
      status: 201,
      headers: { 'x-test': 'yes' },
      url: 'https://example.com/final',
      body: 'hello world',
    });
    const [, generation, requestId, wire] = open.mock.calls[0];
    expect(generation).toBe('install-a');
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(wire).toMatchObject({ method: 'POST', url: 'https://example.com/', body: 'payload', headers: { 'content-type': 'text/plain' } });
    expect(wire).not.toHaveProperty('responseType');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('preserves a binary body larger than 1 MiB byte-for-byte', async () => {
    const first = new Uint8Array(700_000);
    const second = new Uint8Array(600_000);
    for (let index = 0; index < first.length; index++) first[index] = index % 251;
    for (let index = 0; index < second.length; index++) second[index] = (index + 7) % 241;
    read
      .mockResolvedValueOnce({ base64: base64(first), done: false })
      .mockResolvedValueOnce({ base64: base64(second), done: true });
    const result = await executePluginHttp(pluginId, 'http.request', {
      url: 'https://example.com/large',
      responseType: 'binary',
    }) as { body: Uint8Array };
    expect(result.body).toHaveLength(first.length + second.length);
    expect(Array.from(result.body.subarray(0, 8))).toEqual(Array.from(first.subarray(0, 8)));
    expect(result.body[first.length]).toBe(second[0]);
    expect(result.body[result.body.length - 1]).toBe(second[second.length - 1]);
  });

  it('encodes binary request bodies as exclusive bodyBase64', async () => {
    read.mockResolvedValue({ base64: '', done: true });
    await executePluginHttp(pluginId, 'http.request', {
      url: 'https://example.com/echo',
      body: new Uint8Array([1, 2, 3]),
    });
    const wire = open.mock.calls[0][3];
    expect(wire.bodyBase64).toBe(base64(new Uint8Array([1, 2, 3])));
    expect(wire).not.toHaveProperty('body');
  });

  it('rejects a negative or non-finite timeout before any native request', async () => {
    await expect(executePluginHttp(pluginId, 'http.request', { url: 'https://example.com/', timeout: -1 }))
      .rejects.toThrow('timeout');
    await expect(executePluginHttp(pluginId, 'http.request', { url: 'https://example.com/', timeout: Number.POSITIVE_INFINITY }))
      .rejects.toThrow('timeout');
    expect(open).not.toHaveBeenCalled();
  });

  it('rejects an unsupported redirect mode before any native request', async () => {
    await expect(executePluginHttp(pluginId, 'http.request', { url: 'https://example.com/', redirect: 'other' }))
      .rejects.toThrow('redirect');
    expect(open).not.toHaveBeenCalled();
  });
});

describe('pull primitives and cancellation', () => {
  it('reclaims an open stream only while no caller is consuming it', async () => {
    vi.useFakeTimers();
    const head = await executePluginHttp(pluginId, 'http.open', { url: 'https://example.com/' }) as { requestId: string };
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS);
    expect(cancel).toHaveBeenCalledWith(pluginId, 'install-a', head.requestId);
    await expect(executePluginHttp(pluginId, 'http.read', { requestId: head.requestId }))
      .rejects.toThrow('idle');
  });

  it('does not impose an idle deadline on a pending read and rearms only after data returns', async () => {
    vi.useFakeTimers();
    const head = await executePluginHttp(pluginId, 'http.open', { url: 'https://example.com/sse' }) as { requestId: string };
    const pending = deferred<{ base64: string; done: boolean }>();
    read.mockReturnValueOnce(pending.promise);
    const reading = executePluginHttp(pluginId, 'http.read', { requestId: head.requestId });
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS * 3);
    expect(cancel).not.toHaveBeenCalled();
    pending.resolve({ base64: base64(new Uint8Array([7])), done: false });
    await expect(reading).resolves.toEqual({ bytes: new Uint8Array([7]), done: false });
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS - 1);
    expect(cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(cancel).toHaveBeenCalledWith(pluginId, 'install-a', head.requestId);
  });

  it('does not rearm idle expiry while another concurrent native read is still pending', async () => {
    vi.useFakeTimers();
    const head = await executePluginHttp(pluginId, 'http.open', { url: 'https://example.com/sse' }) as { requestId: string };
    const first = deferred<{ base64: string; done: boolean }>();
    const second = deferred<{ base64: string; done: boolean }>();
    read.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const readingFirst = executePluginHttp(pluginId, 'http.read', { requestId: head.requestId });
    const readingSecond = executePluginHttp(pluginId, 'http.read', { requestId: head.requestId });
    first.resolve({ base64: '', done: false });
    await readingFirst;
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS * 2);
    expect(cancel).not.toHaveBeenCalled();
    second.resolve({ base64: '', done: true });
    await expect(readingSecond).resolves.toMatchObject({ done: true });
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('keeps the stream registered after open and unregisters at done', async () => {
    const chunk = new Uint8Array([7, 8]);
    read
      .mockResolvedValueOnce({ base64: base64(chunk), done: false })
      .mockResolvedValueOnce({ base64: '', done: true });
    const head = await executePluginHttp(pluginId, 'http.open', { url: 'https://example.com/' }) as {
      requestId: string; status: number; headers: Record<string, string>; url: string;
    };
    expect(head.status).toBe(200);
    const first = await executePluginHttp(pluginId, 'http.read', { requestId: head.requestId }) as {
      bytes: Uint8Array; done: boolean;
    };
    expect(first).toEqual({ bytes: chunk, done: false });
    const last = await executePluginHttp(pluginId, 'http.read', { requestId: head.requestId }) as {
      bytes: Uint8Array; done: boolean;
    };
    expect(last).toEqual({ bytes: new Uint8Array(0), done: true });
    await expect(executePluginHttp(pluginId, 'http.read', { requestId: head.requestId }))
      .rejects.toThrow('不存在或已结束');
  });

  it('cancels a pending open and rejects the accumulated request with AbortError', async () => {
    const pending = deferred<{ status: number; headers: Record<string, string>; url: string }>();
    open.mockReturnValue(pending.promise);
    const request = executePluginHttp(pluginId, 'http.request', { url: 'https://example.com/' });
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    const requestId = open.mock.calls[0][2];
    await executePluginHttp(pluginId, 'http.cancel', { requestId });
    expect(cancel).toHaveBeenCalledWith(pluginId, 'install-a', requestId);
    pending.resolve({ status: 200, headers: {}, url: 'https://example.com/' });
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(read).not.toHaveBeenCalled();
  });

  it('deduplicates repeated unknown-id cancels and bounds the reserved cancel budget', async () => {
    const gate = deferred<void>();
    cancel.mockReturnValue(gate.promise);
    const duplicateA = executePluginHttp(pluginId, 'http.cancel', { requestId: 'duplicate-id' });
    const duplicateB = executePluginHttp(pluginId, 'http.cancel', { requestId: 'duplicate-id' });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    const flood = Array.from({ length: 32 }, (_, index) =>
      executePluginHttp(pluginId, 'http.cancel', { requestId: `flood-${index}` }),
    );
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(32));
    await expect(executePluginHttp(pluginId, 'http.cancel', { requestId: 'flood-overflow' })).resolves.toBeNull();
    expect(cancel).toHaveBeenCalledTimes(32);
    gate.resolve();
    await Promise.all([duplicateA, duplicateB, ...flood]);
  });

  it('refuses an open whose request was cancelled before it was registered', async () => {
    await executePluginHttp(pluginId, 'http.cancel', { requestId: 'before-open' });
    await expect(executePluginHttp(pluginId, 'http.open', {
      url: 'https://example.com/', requestId: 'before-open',
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(open).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith(pluginId, 'install-a', 'before-open');
  });

  it('rechecks authority after a native read and cancels on revocation', async () => {
    read.mockResolvedValue({ base64: base64(new Uint8Array([1])), done: false });
    const head = await executePluginHttp(pluginId, 'http.open', { url: 'https://example.com/' }) as { requestId: string };
    const beforeSend = vi.fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => { throw new Error('plugin disabled'); });
    await expect(executePluginHttp(pluginId, 'http.read', { requestId: head.requestId }, beforeSend))
      .rejects.toThrow('plugin disabled');
    expect(cancel).toHaveBeenCalledWith(pluginId, 'install-a', head.requestId);
  });

  it('only cancels requests owned by the stopped plugin', async () => {
    const first = deferred<{ status: number; headers: Record<string, string>; url: string }>();
    const second = deferred<{ status: number; headers: Record<string, string>; url: string }>();
    useAppStore.getState().setConfig({
      revision: 0,
      pluginConfigs: [entry, { ...entry, id: 'com.example.other' }],
    });
    open.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const firstRequest = executePluginHttp(pluginId, 'http.open', { url: 'https://example.com/a' });
    const secondRequest = executePluginHttp('com.example.other', 'http.open', { url: 'https://example.com/b' });
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    const firstId = open.mock.calls[0][2];
    const secondId = open.mock.calls[1][2];
    cancelPluginHttp(pluginId);
    expect(cancel).toHaveBeenCalledWith(pluginId, 'install-a', firstId);
    expect(cancel).not.toHaveBeenCalledWith('com.example.other', expect.anything(), secondId);
    first.resolve({ status: 200, headers: {}, url: 'https://example.com/a' });
    await expect(firstRequest).rejects.toMatchObject({ name: 'AbortError' });
    second.resolve({ status: 200, headers: {}, url: 'https://example.com/b' });
    await expect(secondRequest).resolves.toMatchObject({ status: 200 });
    cancelPluginHttp('com.example.other');
  });
});
