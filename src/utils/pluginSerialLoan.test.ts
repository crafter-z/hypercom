import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../stores/useAppStore';
import type { PluginManifestView } from '../types';
import { executeHostApi } from './pluginHostApi';
import { checkOpAllowed, OP_PERMISSIONS } from './pluginRpc';
import { hasNoRpcDeadline, PLUGIN_RPC_TIMEOUT_MS, wrapPluginCode } from './pluginBridge';
import { pluginService as realPluginService } from '../services/plugin';

const invokeMock = vi.hoisted(() => vi.fn());
const loanAcquireMock = vi.hoisted(() => vi.fn());
const loanHeartbeatMock = vi.hoisted(() => vi.fn());
const loanReleaseMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class {},
  invoke: invokeMock,
}));

vi.mock('../services/tauri', () => ({
  serialService: {},
  fileService: {},
  pluginService: {
    pluginSerialLoanAcquire: loanAcquireMock,
    pluginSerialLoanHeartbeat: loanHeartbeatMock,
    pluginSerialLoanRelease: loanReleaseMock,
  },
}));

const PLUGIN_ID = 'loan.plugin';
const GENERATION = 'gen-loan-1';

const allowedManifest = (): PluginManifestView => ({
  id: PLUGIN_ID,
  name: 'Loan Plugin',
  version: '1.0.0',
  description: '',
  apiVersion: '1',
  permissions: ['serial:control'],
  serial: { portWhitelist: ['COM3'] },
});

function setPluginConfig(overrides?: {
  enabled?: boolean;
  installGeneration?: string;
  grantedPermissions?: string[];
}) {
  useAppStore.getState().setConfig({
    pluginConfigs: [
      {
        id: PLUGIN_ID,
        enabled: overrides?.enabled ?? true,
        installGeneration: overrides?.installGeneration ?? GENERATION,
        grantedPermissions: overrides?.grantedPermissions ?? ['serial:control'],
      },
    ],
  });
}

describe('serial.loan service wrappers', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('forwards exact Tauri command names and camelCase args', async () => {
    invokeMock.mockResolvedValue({ ok: true });
    await realPluginService.pluginSerialLoanAcquire(PLUGIN_ID, GENERATION, {
      portId: 'COM3',
      expectedConnectionGeneration: 4,
      reason: 'firmware flash',
      ttlMs: 30_000,
      autoReopen: true,
    });
    expect(invokeMock).toHaveBeenLastCalledWith('plugin_serial_loan_acquire', {
      pluginId: PLUGIN_ID,
      expectedGeneration: GENERATION,
      portId: 'COM3',
      expectedConnectionGeneration: 4,
      reason: 'firmware flash',
      ttlMs: 30_000,
      autoReopen: true,
    });

    await realPluginService.pluginSerialLoanHeartbeat(PLUGIN_ID, GENERATION, {
      leaseId: 'lease-1',
      extendTtlMs: 15_000,
    });
    expect(invokeMock).toHaveBeenLastCalledWith('plugin_serial_loan_heartbeat', {
      pluginId: PLUGIN_ID,
      expectedGeneration: GENERATION,
      leaseId: 'lease-1',
      extendTtlMs: 15_000,
    });

    await realPluginService.pluginSerialLoanRelease(PLUGIN_ID, GENERATION, {
      leaseId: 'lease-1',
      reopenOverride: false,
    });
    expect(invokeMock).toHaveBeenLastCalledWith('plugin_serial_loan_release', {
      pluginId: PLUGIN_ID,
      expectedGeneration: GENERATION,
      leaseId: 'lease-1',
      reopenOverride: false,
    });
  });
});

describe('serial.loan permissions, host.info, and RPC deadline', () => {
  it('exposes portLease alongside serialLoan in host.info', async () => {
    const info = await executeHostApi(PLUGIN_ID, 'host.info', null);
    expect(info).toMatchObject({
      apiVersion: 1,
      features: { serialLoan: true, portLease: true },
    });
  });

  it('gates all serial.loan ops behind serial:control and excludes them from generic RPC timeout', () => {
    for (const op of ['serial.loan.acquire', 'serial.loan.heartbeat', 'serial.loan.release']) {
      expect(OP_PERMISSIONS[op]).toBe('serial:control');
      expect(checkOpAllowed(op, ['serial:send'])).toContain('serial:control');
      expect(checkOpAllowed(op, [])).toContain('serial:control');
      expect(checkOpAllowed(op, ['serial:control'])).toBeNull();
      expect(hasNoRpcDeadline(op)).toBe(true);
    }
  });
});

describe('serial.loan host API validation and authority', () => {
  beforeEach(() => {
    loanAcquireMock.mockReset();
    loanHeartbeatMock.mockReset();
    loanReleaseMock.mockReset();
    setPluginConfig();
  });

  it('acquires, heartbeats, and releases with valid parameters and live authority', async () => {
    const loanInfo = {
      leaseId: 'lease-42',
      portId: 'COM3',
      holder: `plugin:${PLUGIN_ID}`,
      reason: 'bootloader',
      acquiredAtMs: 1_700_000_000_000,
      expiresAtMs: 1_700_000_030_000,
      generation: 9,
      autoReopen: false,
      connectionBound: true,
    };
    const extendedInfo = { ...loanInfo, expiresAtMs: 1_700_000_060_000 };
    const releaseResult = { state: 'reopened' };
    loanAcquireMock.mockResolvedValueOnce(loanInfo);
    loanHeartbeatMock.mockResolvedValueOnce(extendedInfo);
    loanReleaseMock.mockResolvedValueOnce(releaseResult);

    const manifest = allowedManifest();
    await expect(
      executeHostApi(
        PLUGIN_ID,
        'serial.loan.acquire',
        {
          portId: 'COM3',
          expectedConnectionGeneration: 0,
          reason: 'bootloader',
          ttlMs: 30_000,
          autoReopen: false,
        },
        manifest,
      ),
    ).resolves.toEqual(loanInfo);
    expect(loanAcquireMock).toHaveBeenCalledExactlyOnceWith(PLUGIN_ID, GENERATION, {
      portId: 'COM3',
      expectedConnectionGeneration: 0,
      reason: 'bootloader',
      ttlMs: 30_000,
      autoReopen: false,
    });

    await expect(
      executeHostApi(
        PLUGIN_ID,
        'serial.loan.heartbeat',
        { leaseId: 'lease-42', extendTtlMs: 30_000 },
        manifest,
      ),
    ).resolves.toEqual(extendedInfo);
    expect(loanHeartbeatMock).toHaveBeenCalledExactlyOnceWith(PLUGIN_ID, GENERATION, {
      leaseId: 'lease-42',
      extendTtlMs: 30_000,
    });

    await expect(
      executeHostApi(
        PLUGIN_ID,
        'serial.loan.release',
        { leaseId: 'lease-42', reopenOverride: true },
        manifest,
      ),
    ).resolves.toEqual(releaseResult);
    expect(loanReleaseMock).toHaveBeenCalledExactlyOnceWith(PLUGIN_ID, GENERATION, {
      leaseId: 'lease-42',
      reopenOverride: true,
    });
  });

  it('rejects invalid acquire arguments before invoking native command', async () => {
    const manifest: PluginManifestView = {
      id: PLUGIN_ID,
      name: 'Loan Plugin',
      version: '1.0.0',
      description: '',
      apiVersion: '1',
      permissions: ['serial:control'],
    };
    const invalidCases: unknown[] = [
      null,
      [],
      {},
      { portId: '' },
      { portId: '   ' },
      { portId: 'COM3\0' },
      { portId: 'remote::lab::COM3' },
      { portId: ' remote::lab::COM3' },
      { portId: 'COM3', expectedConnectionGeneration: -1 },
      { portId: 'COM3', expectedConnectionGeneration: 1.5 },
      { portId: 'COM3', expectedConnectionGeneration: Number.MAX_SAFE_INTEGER + 1 },
      { portId: 'COM3', expectedConnectionGeneration: '3' },
      { portId: 'COM3', reason: 123 },
      { portId: 'COM3', reason: 'x'.repeat(257) },
      { portId: 'COM3', ttlMs: 0 },
      { portId: 'COM3', ttlMs: -100 },
      { portId: 'COM3', ttlMs: 1.2 },
      { portId: 'COM3', ttlMs: Infinity },
      { portId: 'COM3', autoReopen: 'true' },
      { portId: 'COM3', extraField: true },
    ];
    for (const args of invalidCases) {
      await expect(executeHostApi(PLUGIN_ID, 'serial.loan.acquire', args, manifest)).rejects.toThrow();
    }
    expect(loanAcquireMock).not.toHaveBeenCalled();

    // Boundary values that must pass: 256-char reason, 0 expectedConnectionGeneration, ttlMs 1.
    loanAcquireMock.mockResolvedValueOnce({ leaseId: 'ok' });
    await expect(
      executeHostApi(
        PLUGIN_ID,
        'serial.loan.acquire',
        { portId: 'COM3', expectedConnectionGeneration: 0, reason: 'a'.repeat(256), ttlMs: 1, autoReopen: true },
        manifest,
      ),
    ).resolves.toEqual({ leaseId: 'ok' });
  });

  it('rejects invalid heartbeat and release arguments before invoking native command', async () => {
    const manifest = allowedManifest();
    const invalidHeartbeat: unknown[] = [
      null,
      [],
      {},
      { leaseId: '' },
      { leaseId: '   ' },
      { leaseId: 'lease\0id' },
      { leaseId: 'lease-1', extendTtlMs: 0 },
      { leaseId: 'lease-1', extendTtlMs: -1 },
      { leaseId: 'lease-1', extendTtlMs: 2.5 },
      { leaseId: 'lease-1', extendTtlMs: Number.POSITIVE_INFINITY },
      { leaseId: 'lease-1', extendTtlMs: '1000' },
      { leaseId: 'lease-1', unknown: 1 },
    ];
    for (const args of invalidHeartbeat) {
      await expect(executeHostApi(PLUGIN_ID, 'serial.loan.heartbeat', args, manifest)).rejects.toThrow();
    }
    expect(loanHeartbeatMock).not.toHaveBeenCalled();

    const invalidRelease: unknown[] = [
      null,
      [],
      {},
      { leaseId: '' },
      { leaseId: '   ' },
      { leaseId: 'lease\0id' },
      { leaseId: 'lease-1', reopenOverride: 'false' },
      { leaseId: 'lease-1', reopenOverride: 1 },
      { leaseId: 'lease-1', unknown: true },
    ];
    for (const args of invalidRelease) {
      await expect(executeHostApi(PLUGIN_ID, 'serial.loan.release', args, manifest)).rejects.toThrow();
    }
    expect(loanReleaseMock).not.toHaveBeenCalled();
  });

  it('enforces manifest portWhitelist, serial:control, enabled state, and post-await revocation', async () => {
    const manifest = allowedManifest();
    await expect(
      executeHostApi(PLUGIN_ID, 'serial.loan.acquire', { portId: 'COM3' }, null),
    ).rejects.toThrow('manifest');
    await expect(
      executeHostApi(PLUGIN_ID, 'serial.loan.acquire', { portId: 'COM9' }, manifest),
    ).rejects.toThrow('portWhitelist');

    setPluginConfig({ grantedPermissions: ['serial:send'] });
    await expect(
      executeHostApi(PLUGIN_ID, 'serial.loan.acquire', { portId: 'COM3' }, manifest),
    ).rejects.toThrow('serial:control');
    await expect(
      executeHostApi(PLUGIN_ID, 'serial.loan.heartbeat', { leaseId: 'lease-1' }, manifest),
    ).rejects.toThrow('serial:control');
    await expect(
      executeHostApi(PLUGIN_ID, 'serial.loan.release', { leaseId: 'lease-1' }, manifest),
    ).rejects.toThrow('serial:control');
    expect(loanAcquireMock).not.toHaveBeenCalled();
    expect(loanHeartbeatMock).not.toHaveBeenCalled();
    expect(loanReleaseMock).not.toHaveBeenCalled();

    // Revoking permission while native call is in flight must reject before returning result.
    setPluginConfig({ grantedPermissions: ['serial:control'] });
    loanAcquireMock.mockImplementationOnce(async () => {
      setPluginConfig({ grantedPermissions: [] });
      return { leaseId: 'lease-revoked' };
    });
    await expect(
      executeHostApi(PLUGIN_ID, 'serial.loan.acquire', { portId: 'COM3' }, manifest),
    ).rejects.toThrow('权限或安装代次已变化');

    setPluginConfig({ grantedPermissions: ['serial:control'] });
    loanHeartbeatMock.mockImplementationOnce(async () => {
      setPluginConfig({ enabled: false });
      return { leaseId: 'lease-revoked' };
    });
    await expect(
      executeHostApi(PLUGIN_ID, 'serial.loan.heartbeat', { leaseId: 'lease-1' }, manifest),
    ).rejects.toThrow('权限或安装代次已变化');

    setPluginConfig({ grantedPermissions: ['serial:control'] });
    loanReleaseMock.mockImplementationOnce(async () => {
      setPluginConfig({ installGeneration: 'gen-loan-2' });
      return { state: 'released' };
    });
    await expect(
      executeHostApi(PLUGIN_ID, 'serial.loan.release', { leaseId: 'lease-1' }, manifest),
    ).rejects.toThrow('权限或安装代次已变化');
  });
});

describe('pluginBridge self.plugin.serial.loan facade', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function createBridgeWorker(source: string) {
    const sent: Array<{ seq: number; op: string; args: unknown }> = [];
    const scope: {
      postMessage: (message: { seq: number; op: string; args: unknown }) => void;
      addEventListener: () => void;
      onmessage?: (event: { data: { seq: number; ok: boolean; result?: unknown; error?: string } }) => void;
      plugin?: {
        serial: {
          sendBytes: unknown;
          sendFile: unknown;
          loan: {
            acquire: (options?: unknown) => Promise<Record<string, unknown> & {
              leaseId: string;
              heartbeat: (extendTtlMs?: number) => Promise<unknown>;
              release: (reopenOverride?: boolean) => Promise<unknown>;
            }>;
            heartbeat: (options?: unknown) => Promise<unknown>;
            release: (options?: unknown) => Promise<unknown>;
          };
        };
      };
      resultPromise?: Promise<unknown>;
    } = {
      postMessage: (msg) => sent.push(msg),
      addEventListener: () => {},
    };
    new Function('self', wrapPluginCode(source))(scope);
    const reply = (seq: number, ok: boolean, result?: unknown, error?: string) =>
      scope.onmessage?.({ data: { seq, ok, result, error } });
    const rpcMessages = () => sent.filter((msg) => typeof msg.seq === 'number');
    return { scope, sent, rpcMessages, reply };
  }

  it('provides ergonomic acquire/heartbeat/release without breaking existing serial task methods', async () => {
    vi.useFakeTimers();
    const worker = createBridgeWorker('');
    const serial = worker.scope.plugin!.serial;
    expect(Object.isFrozen(serial)).toBe(true);
    expect(Object.isFrozen(serial.loan)).toBe(true);
    expect(typeof serial.sendBytes).toBe('function');
    expect(typeof serial.sendFile).toBe('function');

    const settled = vi.fn();
    const acquirePromise = serial.loan.acquire({ portId: 'COM3', reason: 'flash', ttlMs: 10_000 });
    void acquirePromise.then(settled, settled);
    await vi.advanceTimersByTimeAsync(PLUGIN_RPC_TIMEOUT_MS + 5_000);
    expect(settled).not.toHaveBeenCalled();
    expect(worker.rpcMessages()[0]).toEqual({
      seq: 1,
      op: 'serial.loan.acquire',
      args: { portId: 'COM3', reason: 'flash', ttlMs: 10_000 },
    });

    const loanDto = {
      leaseId: 'lease-99',
      portId: 'COM3',
      holder: 'plugin:loan.plugin',
      reason: 'flash',
      acquiredAtMs: 1000,
      expiresAtMs: 11000,
      generation: 5,
      autoReopen: true,
      connectionBound: true,
    };
    worker.reply(1, true, loanDto);
    const handle = await acquirePromise;
    expect(handle).toMatchObject(loanDto);

    const hbDefault = handle.heartbeat();
    expect(worker.rpcMessages()[1]).toEqual({
      seq: 2,
      op: 'serial.loan.heartbeat',
      args: { leaseId: 'lease-99' },
    });
    worker.reply(2, true, { ...loanDto, expiresAtMs: 21000 });
    await expect(hbDefault).resolves.toEqual({ ...loanDto, expiresAtMs: 21000 });

    const hbExtended = handle.heartbeat(25_000);
    expect(worker.rpcMessages()[2]).toEqual({
      seq: 3,
      op: 'serial.loan.heartbeat',
      args: { leaseId: 'lease-99', extendTtlMs: 25_000 },
    });
    worker.reply(3, true, { ...loanDto, expiresAtMs: 36000 });
    await expect(hbExtended).resolves.toEqual({ ...loanDto, expiresAtMs: 36000 });

    const relDefault = handle.release();
    expect(worker.rpcMessages()[3]).toEqual({
      seq: 4,
      op: 'serial.loan.release',
      args: { leaseId: 'lease-99' },
    });
    worker.reply(4, true, { state: 'reopened' });
    await expect(relDefault).resolves.toEqual({ state: 'reopened' });

    const relOverride = handle.release(false);
    expect(worker.rpcMessages()[4]).toEqual({
      seq: 5,
      op: 'serial.loan.release',
      args: { leaseId: 'lease-99', reopenOverride: false },
    });
    worker.reply(5, true, { state: 'kept-closed' });
    await expect(relOverride).resolves.toEqual({ state: 'kept-closed' });

    const directHb = serial.loan.heartbeat({ leaseId: 'lease-100', extendTtlMs: 5000 });
    expect(worker.rpcMessages()[5]).toEqual({
      seq: 6,
      op: 'serial.loan.heartbeat',
      args: { leaseId: 'lease-100', extendTtlMs: 5000 },
    });
    worker.reply(6, true, { ...loanDto, leaseId: 'lease-100' });
    await expect(directHb).resolves.toEqual({ ...loanDto, leaseId: 'lease-100' });

    const directRelease = serial.loan.release({ leaseId: 'lease-100', reopenOverride: true });
    expect(worker.rpcMessages()[6]).toEqual({
      seq: 7,
      op: 'serial.loan.release',
      args: { leaseId: 'lease-100', reopenOverride: true },
    });
    worker.reply(7, true, { state: 'reopened' });
    await expect(directRelease).resolves.toEqual({ state: 'reopened' });
  });
});
