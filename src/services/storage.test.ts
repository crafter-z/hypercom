import { describe, expect, it, vi } from 'vitest';
import type { PortPreset } from '../types';
import { enqueueConfigWrite } from '../utils/configWriteQueue';
import { storageService } from './storage';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

const preset: PortPreset = {
  id: 'preset-1', name: '9600-8N1', baudRate: 9600, dataBits: 8,
  parity: 'None', stopBits: 'One', handshake: 'None', dtr: false, rts: false,
};

describe('storageService immediate preset writes', () => {
  it('serializes a preset write with the shared config write queue', async () => {
    let release!: (value: string) => void;
    const order: string[] = [];
    invoke.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));

    const saving = storageService.savePortPreset(preset);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    const next = enqueueConfigWrite(async () => { order.push('full-config'); });
    expect(order).toEqual([]);

    release('preset-1');
    await expect(saving).resolves.toBe('preset-1');
    await next;
    expect(order).toEqual(['full-config']);
    expect(invoke).toHaveBeenCalledWith('save_port_preset', { args: preset });
  });
});
