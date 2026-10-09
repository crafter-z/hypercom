import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listen } from '@tauri-apps/api/event';
import type { Event } from '@tauri-apps/api/event';
import { updateService } from './update';
import type { UpdateProgressPayload } from '../types';

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

beforeEach(() => { vi.clearAllMocks(); });

describe('update progress listener lifetime', () => {
  it('releases a listener that finishes registration after disposal and ignores late events', async () => {
    // Tauri registers asynchronously; ES2020 libs do not provide Promise.withResolvers.
    let registered!: (stop: () => void) => void;
    let callback!: (event: Event<UpdateProgressPayload>) => void;
    vi.mocked(listen).mockImplementation((_, handler) => {
      callback = handler as typeof callback;
      return new Promise((resolve) => { registered = resolve; });
    });
    const onProgress = vi.fn();
    const stop = vi.fn();
    const dispose = updateService.onProgress(onProgress);
    dispose();
    callback({ event: 'update:progress', id: 1, payload: { downloaded: 50, total: 100, phase: 'download' } });
    registered(stop);
    await Promise.resolve();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('handles rejected registration even when the consumer immediately disposes', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.mocked(listen).mockRejectedValueOnce(new Error('listen failed'));
    updateService.onProgress(vi.fn())();
    await Promise.resolve();
    await Promise.resolve();
    expect(debug).toHaveBeenCalledWith('[update] progress listener failed:', expect.any(Error));
    debug.mockRestore();
  });
});
