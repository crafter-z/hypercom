import { describe, it, expect } from 'vitest';
import { mergePorts, mapPortInfo } from './useSerialPorts';
import type { SerialPort } from '../types';

const makePort = (id: string, overrides?: Partial<SerialPort>): SerialPort => ({
  id,
  name: id,
  status: 'disconnected',
  type: 'real',
  isHidden: false,
  ...overrides,
});

describe('mergePorts', () => {
  it('preserves the EXISTING order instead of resetting to enumeration order (issue #2-5)', () => {
    // 用户已把列表排成 COM2, COM1（拖拽或排序的结果）；
    // 轮询返回的枚举顺序是 COM1, COM2 —— 合并后顺序必须保持 COM2, COM1。
    const existing = [makePort('COM2'), makePort('COM1')];
    const incoming = [makePort('COM1'), makePort('COM2')];
    expect(mergePorts(incoming, existing).map(p => p.id)).toEqual(['COM2', 'COM1']);
  });

  it('preserves manual order across a poll that also adds a new port (appended)', () => {
    const existing = [makePort('COM3'), makePort('COM1'), makePort('COM2')];
    const incoming = [makePort('COM1'), makePort('COM2'), makePort('COM3'), makePort('COM9')];
    expect(mergePorts(incoming, existing).map(p => p.id)).toEqual(['COM3', 'COM1', 'COM2', 'COM9']);
  });

  it('keeps runtime state (status/alias/group/baud) of surviving ports', () => {
    const existing = [
      makePort('COM1', { status: 'connected', alias: '主控', groupId: 'g1', baudRate: 9600, dataBits: 7 }),
    ];
    const incoming = [makePort('COM1')];
    const merged = mergePorts(incoming, existing);
    expect(merged[0]).toMatchObject({
      id: 'COM1',
      status: 'connected',
      alias: '主控',
      groupId: 'g1',
      baudRate: 9600,
      dataBits: 7,
    });
  });

  it('unions back a connected port that transiently vanished from enumeration', () => {
    const existing = [makePort('COM1'), makePort('COM2', { status: 'connected' })];
    const incoming = [makePort('COM1')];
    expect(mergePorts(incoming, existing).map(p => p.id)).toEqual(['COM1', 'COM2']);
  });

  it('drops a disconnected port that vanished from enumeration', () => {
    const existing = [makePort('COM1'), makePort('COM2')];
    const incoming = [makePort('COM1')];
    expect(mergePorts(incoming, existing).map(p => p.id)).toEqual(['COM1']);
  });

  it('returns incoming ports as-is when nothing exists yet', () => {
    const incoming = [makePort('COM1'), makePort('COM2')];
    expect(mergePorts(incoming, []).map(p => p.id)).toEqual(['COM1', 'COM2']);
  });
});

describe('mapPortInfo', () => {
  it('maps backend port info with disconnected default status', () => {
    const mapped = mapPortInfo({ id: 'COM3', name: 'COM3', port_type: 'real' });
    expect(mapped).toMatchObject({ id: 'COM3', status: 'disconnected', type: 'real', isHidden: false });
  });

  it('maps the sim port type', () => {
    const mapped = mapPortInfo({ id: 'SIM:Loopback', name: 'SIM', port_type: 'sim' });
    expect(mapped.type).toBe('sim');
  });
});
