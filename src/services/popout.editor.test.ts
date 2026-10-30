import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emit, listen } from '@tauri-apps/api/event';
import type { Event } from '@tauri-apps/api/event';
import { COMMAND_EDITOR_TIMEOUT_MS, popoutEventService } from './popout';
import type { CommandEditorClientResult, CommandEditorResult } from './popout';

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
  it('binds client leave ACKs to the targeted client, host session and observed sequence', async () => {
    const stop = vi.fn();
    let receive!: (event: Event<CommandEditorClientResult>) => void;
    vi.mocked(listen).mockImplementationOnce((_name, callback) => { receive = callback; return Promise.resolve(stop); });
    const identity = { clientId: 'current-panel', sessionId: 'host', sequence: 4 };
    const pending = popoutEventService.requestCommandEditorClientLeave('save', identity);
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(emit).toHaveBeenCalledWith('command-editor:client-leave', expect.objectContaining({ action: 'save', ...identity }));
    const requestId = (vi.mocked(emit).mock.calls[0][1] as { requestId: string }).requestId;
    const ack = { requestId, success: true, error: null, unresolved: false, ...identity };
    for (const payload of [
      { ...ack, clientId: 'retired-panel' }, { ...ack, sessionId: 'retired-host' },
      { ...ack, sequence: 3 }, { requestId, success: true, error: null },
    ]) receive({ event: 'command-editor:client-result', id: 1, payload });
    await Promise.resolve();
    expect(settled).toBe(false);
    receive({ event: 'command-editor:client-result', id: 1, payload: { ...ack, sequence: 5 } });
    await expect(pending).resolves.toMatchObject({ clientId: 'current-panel', sequence: 5 });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('keeps the unbound legacy client ACK transport compatible', async () => {
    let receive!: (event: Event<CommandEditorClientResult>) => void;
    vi.mocked(listen).mockImplementationOnce((_name, callback) => { receive = callback; return Promise.resolve(() => {}); });
    const pending = popoutEventService.requestCommandEditorClientLeave('discard');
    await Promise.resolve();
    const requestId = (vi.mocked(emit).mock.calls[0][1] as { requestId: string }).requestId;
    receive({ event: 'command-editor:client-result', id: 1, payload: { requestId, success: true, error: null } });
    await expect(pending).resolves.toEqual({ requestId, success: true, error: null });
  });

  it('preserves structured client-state and sync identity on the wire', async () => {
    const identity = { clientId: 'panel', sessionId: 'host', sequence: 12 };
    await popoutEventService.emitRequestSync(identity);
    await popoutEventService.emitCommandEditorClientState({ ...identity, sequence: 13, unresolved: true });
    expect(emit).toHaveBeenCalledWith('popout:request-sync', identity);
    expect(emit).toHaveBeenCalledWith('command-editor:client-state', { ...identity, sequence: 13, unresolved: true });
  });
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
