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

  it('resets a stuck `error` status to disconnected when the port is re-enumerated (hot-plug refresh fix)', () => {
    // 打开失败后 status 停在 error；端口重新出现在枚举里（重插/恢复）→
    // 合并结果必须是 disconnected，否则刷新按钮永远救不回报错状态。
    const existing = [makePort('COM1', { status: 'error' })];
    const incoming = [makePort('COM1')];
    const merged = mergePorts(incoming, existing);
    expect(merged[0].status).toBe('disconnected');
  });

  it('still carries over connected/connecting status for re-enumerated ports', () => {
    const existing = [makePort('COM1', { status: 'connecting' })];
    const incoming = [makePort('COM1')];
    const merged = mergePorts(incoming, existing);
    expect(merged[0].status).toBe('connecting');
  });

  it('drops a ghost connected port after MAX_MISSING_POLLS consecutive misses (hot-plug ghost fix)', () => {
    // 拔出后端口消失、读线程空闲不报 disconnected，status 停在 connected：
    // union-back 不能永续保留幽灵端口，超过宽限轮数后必须消失。
    const ghost = makePort('COM9', { status: 'connected' });
    const incoming = [makePort('COM1')];
    // 模拟连续 4 次轮询 COM9 都不在枚举中
    let existing = [ghost, makePort('COM1')];
    for (let i = 0; i < 4; i++) {
      const merged = mergePorts(incoming, existing);
      // 前 MAX_MISSING_POLLS=3 轮保留，第 4 轮起丢弃
      const expected = i < 3;
      expect(merged.some(p => p.id === 'COM9')).toBe(expected);
      existing = merged;
    }
  });

  it('reappearing ghost port resets the missing counter', () => {
    const ghost = makePort('COM9', { status: 'connected' });
    let existing = [ghost, makePort('COM1')];
    // 2 次缺失 → 仍保留
    existing = mergePorts([makePort('COM1')], existing);
    existing = mergePorts([makePort('COM1')], existing);
    expect(existing.some(p => p.id === 'COM9')).toBe(true);
    // 端口重新出现 → 计数清零，后续缺失重新计时
    existing = mergePorts([makePort('COM9')], existing);
    existing = mergePorts([makePort('COM1')], existing);
    expect(existing.some(p => p.id === 'COM9')).toBe(true);
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
