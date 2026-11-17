import { beforeEach, describe, expect, it, vi } from 'vitest';
import { serialService } from './serial';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
beforeEach(() => { invoke.mockReset(); });

describe('plugin serial native service contracts', () => {
  it('uses top-level installation identity and camelCase serial params for open', async () => {
    const port = { id: 'COM1', name: 'COM1', status: 'connected', type: 'real', mode: 'trx', baudRate: 9600, connectionGeneration: 21 };
    const result = { port, result: 'opened', connectionGeneration: 21 };
    invoke.mockResolvedValueOnce(result);
    const params = { baudRate: 9600, dataBits: 8, parity: 'None', stopBits: 'One', handshake: 'None', dtr: true, rts: false, cols: 80, rows: 24 };
    await expect(serialService.pluginSerialOpen('plugin-id', 'install-a', { portId: 'COM1', params })).resolves.toEqual(result);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('plugin_serial_open', { pluginId: 'plugin-id', expectedGeneration: 'install-a', portId: 'COM1', params });
  });

  it('binds close to the exact observed native connection generation', async () => {
    invoke.mockResolvedValueOnce({ port: {}, result: 'closed' });
    await serialService.pluginSerialClose('plugin-id', 'install-a', { portId: 'COM1', expectedConnectionGeneration: 21 });
    expect(invoke).toHaveBeenCalledExactlyOnceWith('plugin_serial_close', {
      pluginId: 'plugin-id', expectedGeneration: 'install-a', portId: 'COM1', expectedConnectionGeneration: 21,
    });
  });

  it('preserves null for unknown status and passes identity to read-only listing', async () => {
    invoke.mockResolvedValueOnce(null).mockResolvedValueOnce([]);
    await expect(serialService.pluginSerialStatus('plugin-id', 'install-a', 'missing')).resolves.toBeNull();
    await expect(serialService.pluginSerialList('plugin-id', 'install-a')).resolves.toEqual([]);
    expect(invoke).toHaveBeenNthCalledWith(1, 'plugin_serial_status', { pluginId: 'plugin-id', expectedGeneration: 'install-a', portId: 'missing' });
    expect(invoke).toHaveBeenNthCalledWith(2, 'plugin_serial_list', { pluginId: 'plugin-id', expectedGeneration: 'install-a' });
  });

  it('does not convert backend errors into a successful lifecycle result', async () => {
    const failure = new Error('stale connection generation');
    invoke.mockRejectedValue(failure);
    await expect(serialService.pluginSerialOpen('p', 'i', { portId: 'COM1' })).rejects.toBe(failure);
    await expect(serialService.pluginSerialClose('p', 'i', { portId: 'COM1', expectedConnectionGeneration: 21 })).rejects.toBe(failure);
  });
});
