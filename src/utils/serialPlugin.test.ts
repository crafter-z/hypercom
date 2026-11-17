import { beforeEach, describe, expect, it, vi } from 'vitest';
import { serialService } from '../services/tauri';
import type { PluginSerialOpenResult } from '../services/serial';
import { useAppStore } from '../stores/useAppStore';
import { useOperationStore } from '../stores/useOperationStore';
import { resetStoresForTests } from '../stores/resetStores';
import { userClosingPortIds } from '../hooks/disconnectTracking';
import { openTabForConnectedPort } from '../hooks/useSerialReceive';
import { acceptSerialStatus, closeSerialConnection, openSerialConnection } from './serialConnectionRuntime';
import {
  executePluginSerialClose,
  executePluginSerialOpen,
  parsePluginSerialCloseRequest,
  parsePluginSerialOpenRequest,
} from './serialPlugin';

vi.mock('../services/tauri', () => ({
  serialService: { pluginSerialOpen: vi.fn(), pluginSerialClose: vi.fn(), openSerialPort: vi.fn(), closeSerialPort: vi.fn() },
  eventService: {}, gitBashSimService: {},
}));

const plugin = { id: 'com.example.serial', installGeneration: 'install-a', enabled: true, grantedPermissions: ['serial:control'] };
let sequence = 0;
let id: string;
let opened: PluginSerialOpenResult;
beforeEach(() => {
  vi.resetAllMocks();
  resetStoresForTests();
  userClosingPortIds.clear();
  id = `PLUGIN:${++sequence}`;
  useAppStore.setState({ ports: [{ id, name: id, status: 'disconnected', type: 'real', isHidden: false }] });
  useAppStore.getState().setConfig({ pluginConfigs: [{ ...plugin }] });
  opened = { port: { id, name: id, type: 'real', status: 'connected', mode: 'trx', baudRate: 57600, connectionGeneration: 42 }, result: 'opened', connectionGeneration: 42 };
  vi.mocked(serialService.pluginSerialOpen).mockResolvedValue(opened);
  vi.mocked(serialService.closeSerialPort).mockResolvedValue(undefined);
});

describe('plugin serial strict request contract', () => {
  it('preserves partial parameters and requires a generation for close', () => {
    expect(parsePluginSerialOpenRequest({ portId: 'COM1', params: { baudRate: 230400, dataBits: 7, parity: 'Even', stopBits: 'Two', handshake: 'XonXoff', dtr: true, rts: false, cols: 80, rows: 24 } }))
      .toEqual({ portId: 'COM1', params: { baudRate: 230400, dataBits: 7, parity: 'Even', stopBits: 'Two', handshake: 'XonXoff', dtr: true, rts: false, cols: 80, rows: 24 } });
    expect(parsePluginSerialOpenRequest({ portId: 'COM1' })).toEqual({ portId: 'COM1' });
    expect(parsePluginSerialCloseRequest({ portId: 'COM1', expectedConnectionGeneration: 0 })).toEqual({ portId: 'COM1', expectedConnectionGeneration: 0 });
  });

  it.each([
    null, [], 'COM1', {}, { portId: '' }, { portId: ' ' }, { portId: 'C\0M' }, { portId: 1 },
    { portId: 'COM1', extra: true }, { portId: 'COM1', params: null }, { portId: 'COM1', params: [] },
    ...[
      { unknown: 1 }, { baudRate: 0 }, { baudRate: -1 }, { baudRate: 1.5 }, { baudRate: Infinity },
      { baudRate: NaN }, { baudRate: 0x1_0000_0000 }, { baudRate: '9600' }, { dataBits: 9 },
      { dataBits: '8' }, { parity: 'Mark' }, { stopBits: '1' }, { handshake: 'RTS' },
      { dtr: 1 }, { rts: null }, { cols: 0 }, { cols: 65536 }, { rows: 2.1 },
    ].map(params => ({ portId: 'COM1', params })),
  ])('rejects invalid open input instead of ignoring or clamping it: %j', input => {
    expect(() => parsePluginSerialOpenRequest(input)).toThrow();
  });

  it.each([undefined, null, -1, 1.5, Infinity, NaN, '1', Number.MAX_SAFE_INTEGER + 1])('rejects invalid or omitted close identity %j', generation => {
    expect(() => parsePluginSerialCloseRequest({ portId: 'COM1', expectedConnectionGeneration: generation })).toThrow(/expectedConnectionGeneration/);
  });
});

describe('plugin serial lifecycle facade', () => {
  it('opens a natively discovered port before frontend polling and adopts its summary without navigation', async () => {
    useAppStore.setState({ ports: [] });
    vi.mocked(serialService.pluginSerialOpen).mockImplementation(async () => {
      acceptSerialStatus(id, 'connected');
      openTabForConnectedPort(id);
      return opened;
    });
    await expect(executePluginSerialOpen(plugin.id, { portId: id })).resolves.toEqual(opened);
    expect(useAppStore.getState().ports).toEqual([expect.objectContaining({ id, status: 'connected', connectionGeneration: 42, baudRate: 57600 })]);
    expect(useAppStore.getState().tabs).toHaveLength(0);
  });

  it('allows native CAS close of a historical port omitted from the frontend list', async () => {
    useAppStore.setState({ ports: [] });
    const closed = { port: { ...opened.port, status: 'disconnected' }, result: 'already-closed' as const };
    vi.mocked(serialService.pluginSerialClose).mockResolvedValue(closed);
    await expect(executePluginSerialClose(plugin.id, { portId: id, expectedConnectionGeneration: 42 })).resolves.toEqual(closed);
    expect(serialService.pluginSerialClose).toHaveBeenCalledExactlyOnceWith(plugin.id, 'install-a', { portId: id, expectedConnectionGeneration: 42 });
    expect(useAppStore.getState().ports[0]).toMatchObject({ id, status: 'disconnected' });
  });

  it('does not invent a port when native discovery/open fails', async () => {
    useAppStore.setState({ ports: [] });
    vi.mocked(serialService.pluginSerialOpen).mockRejectedValue(new Error('native port not found'));
    await expect(executePluginSerialOpen(plugin.id, { portId: id })).rejects.toThrow('native port not found');
    expect(useAppStore.getState().ports).toEqual([]);
  });

  it('does not activate an existing UI session during a plugin idempotent open', async () => {
    useAppStore.getState().updatePort(id, { status: 'connected', connectionGeneration: 42 });
    useAppStore.getState().openTab(id);
    useAppStore.getState().openTab('OTHER');
    const active = useAppStore.getState().activeTabId;
    vi.mocked(serialService.pluginSerialOpen).mockImplementation(async () => {
      openTabForConnectedPort(id);
      return { ...opened, result: 'already-open' };
    });
    await executePluginSerialOpen(plugin.id, { portId: id });
    expect(useAppStore.getState().activeTabId).toBe(active);
  });

  it('rejects a late native open response instead of rolling back a newer status generation', async () => {
    vi.mocked(serialService.pluginSerialOpen).mockImplementation(async () => {
      acceptSerialStatus(id, 'connected');
      useAppStore.getState().updatePort(id, { status: 'connected', connectionGeneration: 43 });
      return opened;
    });
    await expect(executePluginSerialOpen(plugin.id, { portId: id })).rejects.toMatchObject({ code: 'superseded' });
    expect(useAppStore.getState().ports[0]).toMatchObject({ status: 'connected', connectionGeneration: 43 });
  });

  it('preserves the host display mode while keeping native lifecycle status and generation authoritative', async () => {
    useAppStore.getState().updatePort(id, { mode: 'tty' });
    await expect(executePluginSerialOpen(plugin.id, { portId: id })).resolves.toMatchObject({
      port: { mode: 'tty', status: 'connected', connectionGeneration: 42 }, connectionGeneration: 42,
    });
    vi.mocked(serialService.pluginSerialClose).mockResolvedValue({ port: { ...opened.port, status: 'disconnected' }, result: 'closed' });
    await expect(executePluginSerialClose(plugin.id, { portId: id, expectedConnectionGeneration: 42 })).resolves.toMatchObject({
      port: { mode: 'tty', status: 'disconnected', connectionGeneration: 42 },
    });
  });

  it('uses shared per-port defaults, applies explicit overrides, and records native generation', async () => {
    useOperationStore.getState().setOpState({ baudRate: 9600, dtr: true });
    useAppStore.getState().updatePort(id, { baudRate: 38400, parity: 'Odd' });
    const authority = vi.fn();
    await expect(executePluginSerialOpen(plugin.id, { portId: id, params: { baudRate: 57600, rts: true } }, authority)).resolves.toEqual(opened);
    expect(serialService.pluginSerialOpen).toHaveBeenCalledExactlyOnceWith(plugin.id, 'install-a', {
      portId: id, params: { baudRate: 57600, dataBits: 8, parity: 'Odd', stopBits: 'One', handshake: 'None', dtr: true, rts: true },
    });
    expect(useAppStore.getState().ports[0]).toMatchObject({ status: 'connected', baudRate: 57600, connectionGeneration: 42 });
    expect(authority.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('does not create or activate tabs when connected arrives before native open resolves', async () => {
    useAppStore.getState().openTab('OTHER');
    const active = useAppStore.getState().activeTabId;
    vi.mocked(serialService.pluginSerialOpen).mockImplementation(async () => {
      expect(acceptSerialStatus(id, 'connected')).toBe(true);
      openTabForConnectedPort(id);
      return opened;
    });
    await executePluginSerialOpen(plugin.id, { portId: id });
    expect(useAppStore.getState().tabs).toHaveLength(1);
    expect(useAppStore.getState().activeTabId).toBe(active);
    // The session policy also covers a subsequent reader/reconnect event.
    openTabForConnectedPort(id);
    expect(useAppStore.getState().tabs).toHaveLength(1);
  });

  it('keeps an already open raw tab in the background rather than activating it', async () => {
    useAppStore.getState().openTab(id);
    useAppStore.getState().openTab('OTHER');
    const active = useAppStore.getState().activeTabId;
    vi.mocked(serialService.pluginSerialOpen).mockImplementation(async () => {
      openTabForConnectedPort(id);
      return opened;
    });
    await executePluginSerialOpen(plugin.id, { portId: id });
    expect(useAppStore.getState().activeTabId).toBe(active);
  });

  it('still invokes an already connected session for backend authorization/idempotency and does not pretend params changed', async () => {
    useAppStore.getState().updatePort(id, { status: 'connected', baudRate: 38400, connectionGeneration: 30 });
    const already = { ...opened, result: 'already-open' as const, connectionGeneration: 30, port: { ...opened.port, baudRate: 38400, connectionGeneration: 30 } };
    vi.mocked(serialService.pluginSerialOpen).mockResolvedValue(already);
    await expect(executePluginSerialOpen(plugin.id, { portId: id, params: { baudRate: 57600 } })).resolves.toEqual(already);
    expect(serialService.pluginSerialOpen).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().ports[0]).toMatchObject({ baudRate: 38400, connectionGeneration: 30 });
  });

  it('forwards explicit close CAS and returns the exact backend outcome', async () => {
    useAppStore.getState().updatePort(id, { status: 'connected', connectionGeneration: 42 });
    const closed = { port: { ...opened.port, status: 'disconnected' }, result: 'closed' as const };
    vi.mocked(serialService.pluginSerialClose).mockResolvedValue(closed);
    await expect(executePluginSerialClose(plugin.id, { portId: id, expectedConnectionGeneration: 42 })).resolves.toEqual(closed);
    expect(serialService.pluginSerialClose).toHaveBeenCalledExactlyOnceWith(plugin.id, 'install-a', { portId: id, expectedConnectionGeneration: 42 });
    expect(useAppStore.getState().ports[0].status).toBe('disconnected');
  });

  it('preserves stale-generation close failure and keeps the newer reader alive', async () => {
    useAppStore.getState().updatePort(id, { status: 'connected', connectionGeneration: 43 });
    const failure = new Error('stale connection generation');
    vi.mocked(serialService.pluginSerialClose).mockRejectedValue(failure);
    await expect(executePluginSerialClose(plugin.id, { portId: id, expectedConnectionGeneration: 42 })).rejects.toBe(failure);
    expect(useAppStore.getState().ports[0]).toMatchObject({ status: 'connected', connectionGeneration: 43 });
    expect(userClosingPortIds.has(id)).toBe(false);
  });

  it('rejects known tool conflicts before native work', async () => {
    useAppStore.getState().updatePort(id, { toolRunning: true });
    await expect(executePluginSerialOpen(plugin.id, { portId: id })).rejects.toMatchObject({ code: 'tool-running' });
    await expect(executePluginSerialClose(plugin.id, { portId: id, expectedConnectionGeneration: 42 })).rejects.toMatchObject({ code: 'tool-running' });
    expect(serialService.pluginSerialOpen).not.toHaveBeenCalled();
    expect(serialService.pluginSerialClose).not.toHaveBeenCalled();
  });

  it.each([
    { ...plugin, enabled: false }, { ...plugin, installGeneration: '' }, { ...plugin, grantedPermissions: ['serial:send'] },
  ])('rejects disabled, unidentified or control-ungranted plugins', async config => {
    useAppStore.getState().setConfig({ pluginConfigs: [config] });
    await expect(executePluginSerialOpen(plugin.id, { portId: id })).rejects.toThrow(/serial:control/);
    expect(serialService.pluginSerialOpen).not.toHaveBeenCalled();
  });

  it('rechecks authority after queuing and never invokes a revoked installation', async () => {
    const operation = executePluginSerialOpen(plugin.id, { portId: id });
    useAppStore.getState().setConfig({ pluginConfigs: [{ ...plugin, installGeneration: 'install-b' }] });
    await expect(operation).rejects.toThrow(/已变化/);
    expect(serialService.pluginSerialOpen).not.toHaveBeenCalled();
  });

  it('checks Worker liveness before invocation and before delivering results', async () => {
    let alive = true;
    vi.mocked(serialService.pluginSerialOpen).mockImplementation(async () => { alive = false; return opened; });
    await expect(executePluginSerialOpen(plugin.id, { portId: id }, () => {
      if (!alive) throw new Error('Worker retired');
    })).rejects.toThrow('Worker retired');
  });

  it('does not deliver results after control permission is revoked during native work', async () => {
    vi.mocked(serialService.pluginSerialOpen).mockImplementation(async () => {
      useAppStore.getState().setConfig({ pluginConfigs: [{ ...plugin, grantedPermissions: [] }] });
      return opened;
    });
    await expect(executePluginSerialOpen(plugin.id, { portId: id })).rejects.toThrow(/已变化/);
  });

  it('shares UI intent ordering and rejects a plugin open superseded by UI close', async () => {
    const operation = executePluginSerialOpen(plugin.id, { portId: id });
    const rejected = expect(operation).rejects.toMatchObject({ code: 'superseded' });
    await closeSerialConnection(id);
    await rejected;
    expect(serialService.pluginSerialOpen).not.toHaveBeenCalled();
    expect(serialService.closeSerialPort).toHaveBeenCalledTimes(1);
  });

  it('propagates backend failures instead of returning a success-shaped result', async () => {
    const failure = new Error('native access denied');
    vi.mocked(serialService.pluginSerialOpen).mockRejectedValue(failure);
    await expect(executePluginSerialOpen(plugin.id, { portId: id })).rejects.toBe(failure);
    expect(useAppStore.getState().ports[0].status).toBe('error');
  });

  it('lets an explicit later UI open restore normal connected-tab activation', async () => {
    await executePluginSerialOpen(plugin.id, { portId: id });
    await closeSerialConnection(id);
    vi.mocked(serialService.openSerialPort).mockResolvedValue(undefined);
    await openSerialConnection(id);
    openTabForConnectedPort(id);
    expect(useAppStore.getState().tabs).toHaveLength(1);
  });
});
