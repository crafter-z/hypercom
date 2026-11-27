import { describe, expect, it } from 'vitest';
import {
  formatSerialTabTitle,
  getPortCapabilities,
  isRemotePort,
  isRemotePortId,
  normalizeRemoteRole,
  parseRemotePortId,
} from './portCapabilities';
import type { SerialPort } from '../types';

const makePort = (overrides?: Partial<SerialPort>): SerialPort => ({
  id: 'COM3',
  name: 'COM3',
  status: 'disconnected',
  type: 'real',
  isHidden: false,
  ...overrides,
});

describe('portCapabilities', () => {
  it('identifies remote ports by type or remote:: prefix', () => {
    expect(isRemotePortId('remote::lab::COM5')).toBe(true);
    expect(isRemotePortId('COM5')).toBe(false);
    expect(isRemotePortId(null)).toBe(false);
    expect(isRemotePort(makePort({ id: 'COM1', type: 'real' }))).toBe(false);
    expect(isRemotePort(makePort({ id: 'remote::lab::COM1', type: 'remote' }))).toBe(true);
    expect(isRemotePort(makePort({ id: 'remote::lab::COM1', type: 'real' }))).toBe(true);
  });

  it('normalizes valid remote roles only', () => {
    expect(normalizeRemoteRole('observe')).toBe('observe');
    expect(normalizeRemoteRole('write')).toBe('write');
    expect(normalizeRemoteRole('control')).toBe('control');
    expect(normalizeRemoteRole('admin')).toBeUndefined();
    expect(normalizeRemoteRole(undefined)).toBeUndefined();
  });

  it('returns full capabilities for local ports and detects active loans', () => {
    const local = makePort();
    expect(getPortCapabilities(local)).toEqual({
      isRemote: false,
      canWrite: true,
      canControl: true,
      canLoan: true,
      canLocalTool: true,
      canLocalFileSend: true,
      isLoaned: false,
    });

    const loaned = makePort({
      loan: {
        leaseId: 'lease-1',
        holder: 'hypercomctl',
        acquiredAtMs: 1000,
        autoReopen: true,
        connectionBound: false,
      },
    });
    expect(getPortCapabilities(loaned).isLoaned).toBe(true);
    expect(getPortCapabilities(makePort({ pluginToolRunning: true })).isLoaned).toBe(true);
    expect(getPortCapabilities(makePort({ toolRunning: true })).isLoaned).toBe(true);
  });

  it('enforces observe / write / control capabilities on remote ports', () => {
    const observePort = makePort({
      id: 'remote::lab::COM5',
      type: 'remote',
      remoteRole: 'observe',
      remoteAllowLoan: true,
    });
    expect(getPortCapabilities(observePort)).toEqual({
      isRemote: true,
      canWrite: false,
      canControl: false,
      canLoan: false,
      canLocalTool: false,
      canLocalFileSend: false,
      isLoaned: false,
    });

    const writePort = makePort({
      id: 'remote::lab::COM5',
      type: 'remote',
      remoteRole: 'write',
      remoteAllowLoan: true,
    });
    expect(getPortCapabilities(writePort)).toEqual({
      isRemote: true,
      canWrite: true,
      canControl: false,
      canLoan: false,
      canLocalTool: false,
      canLocalFileSend: false,
      isLoaned: false,
    });

    const controlPort = makePort({
      id: 'remote::lab::COM5',
      type: 'remote',
      remoteRole: 'control',
      remoteAllowLoan: true,
    });
    expect(getPortCapabilities(controlPort)).toEqual({
      isRemote: true,
      canWrite: true,
      canControl: true,
      canLoan: true,
      canLocalTool: false,
      canLocalFileSend: false,
      isLoaned: false,
    });
  });

  it('returns disabled capabilities when port is absent', () => {
    expect(getPortCapabilities(undefined)).toEqual({
      isRemote: false,
      canWrite: false,
      canControl: false,
      canLoan: false,
      canLocalTool: false,
      canLocalFileSend: false,
      isLoaned: false,
    });
  });

  it('parses remote port IDs cleanly', () => {
    expect(parseRemotePortId('remote::lab-a::COM7')).toEqual({ hostId: 'lab-a', remotePortId: 'COM7' });
    expect(parseRemotePortId('remote::bench::/dev/ttyUSB0')).toEqual({ hostId: 'bench', remotePortId: '/dev/ttyUSB0' });
    expect(parseRemotePortId('COM3')).toBeNull();
    expect(parseRemotePortId('remote::incomplete')).toBeNull();
  });

  it('formats serial tab titles for local, remote, and fallback ports', () => {
    expect(formatSerialTabTitle(makePort({ id: 'COM3' }), 'COM3')).toBe('COM3');
    expect(formatSerialTabTitle(makePort({ id: 'COM3', alias: 'Lab PSU' }), 'COM3')).toBe('COM3 Lab PSU');

    const remoteWithHostLabel = makePort({
      id: 'remote::lab-a::COM7',
      name: 'COM7',
      type: 'remote',
      hostId: 'lab-a',
      hostLabel: 'Bench A',
      remotePortId: 'COM7',
    });
    expect(formatSerialTabTitle(remoteWithHostLabel, 'remote::lab-a::COM7')).toBe('Bench A / COM7');

    const remoteWithAlias = makePort({
      ...remoteWithHostLabel,
      alias: 'DUT',
    });
    expect(formatSerialTabTitle(remoteWithAlias, 'remote::lab-a::COM7')).toBe('Bench A / COM7 DUT');

    const remoteWithoutHostLabel = makePort({
      id: 'remote::lab-a::COM7',
      name: 'COM7',
      type: 'remote',
      hostId: 'lab-a',
      remotePortId: 'COM7',
    });
    expect(formatSerialTabTitle(remoteWithoutHostLabel, 'remote::lab-a::COM7')).toBe('lab-a / COM7');

    expect(formatSerialTabTitle(undefined, 'remote::lab-a::COM7')).toBe('lab-a / COM7');
    expect(formatSerialTabTitle(undefined, 'COM9')).toBe('COM9');
  });
});
