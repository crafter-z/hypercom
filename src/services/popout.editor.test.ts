import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emit, listen } from '@tauri-apps/api/event';
import type { Event } from '@tauri-apps/api/event';
import { COMMAND_EDITOR_TIMEOUT_MS, popoutEventService } from './popout';
import type { CommandEditorResult } from './popout';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(), listen: vi.fn() }));
const snapshot: CommandEditorResult['snapshot'] = { items: [], sessionId: 'host', version: 4, dirty: false, dirtyIds: [], saving: false, error: null };
function deferred<T>() {
  // The application supports ES2020 WebViews, before Promise.withResolvers.
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(emit).mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); });

describe('command editor request/ACK transport', () => {
  it('registers before emit and waits for its matching persistence ACK', async () => {
    const registration = deferred<() => void>();
    const stop = vi.fn();
    let receive!: (event: Event<CommandEditorResult>) => void;
    vi.mocked(listen).mockImplementationOnce((_name, callback) => { receive = callback; return registration.promise; });
    const result = popoutEventService.requestCommandEditor({ action: 'save', version: 3, sessionId: 'host' });
    let settled = false;
    void result.then(() => { settled = true; });
    expect(emit).not.toHaveBeenCalled();
    registration.resolve(stop);
    await Promise.resolve();
    expect(emit).toHaveBeenCalledWith('popout:command-editor-request', expect.objectContaining({ action: 'save', version: 3, requestId: expect.any(String) }));
    const request = vi.mocked(emit).mock.calls[0][1] as { requestId: string };
    receive({ event: 'command-editor:result', id: 1, payload: { requestId: 'unrelated', success: true, error: null, snapshot } });
    await Promise.resolve();
    expect(settled).toBe(false);
    receive({ event: 'command-editor:result', id: 1, payload: { requestId: request.requestId, success: false, error: 'disk full', snapshot } });
    await expect(result).resolves.toMatchObject({ success: false, error: 'disk full', snapshot });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('times out even during registration, retiring a late listener without emitting', async () => {
    vi.useFakeTimers();
    const registration = deferred<() => void>();
    const stop = vi.fn();
    vi.mocked(listen).mockReturnValueOnce(registration.promise);
    const result = popoutEventService.requestCommandEditor({ action: 'discard', version: 4, sessionId: 'host' });
    const rejected = expect(result).rejects.toThrow('editor.saveFailed');
    await vi.advanceTimersByTimeAsync(COMMAND_EDITOR_TIMEOUT_MS);
    await rejected;
    registration.resolve(stop);
    await Promise.resolve();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(emit).not.toHaveBeenCalled();
  });

  it('retires an installed result listener when emit fails', async () => {
    const stop = vi.fn();
    vi.mocked(listen).mockResolvedValueOnce(stop);
    vi.mocked(emit).mockRejectedValueOnce(new Error('transport unavailable'));
    await expect(popoutEventService.requestCommandEditor({ action: 'replace', items: [], version: 2, sessionId: 'host' })).rejects.toThrow('transport unavailable');
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
