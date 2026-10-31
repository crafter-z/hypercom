import { beforeEach, describe, it, expect } from 'vitest';
import { mergePorts, mapPortInfo } from './useSerialPorts';
import { useAppStore } from '../stores/useAppStore';
import type { SerialPort } from '../types';
import { resetStoresForTests } from '../stores/resetStores';

beforeEach(resetStoresForTests);

const makePort = (id: string, overrides?: Partial<SerialPort>): SerialPort => ({
  id,
  name: id,
  status: 'disconnected',
  type: 'real',
  isHidden: false,
  ...overrides,
});

describe('mergePorts', () => {
  it('follows fresh enumeration order by default while retaining state by port identity', () => {
    const existing = [
      makePort('COM10', { alias: '设备', status: 'connected', connectionGeneration: 7 }),
      makePort('COM2'),
      makePort('COM1', { status: 'error' }),
    ];
    const incoming = ['COM1', 'COM3', 'COM2', 'COM10'].map(id => makePort(id));
    const merged = mergePorts(incoming, existing);
    expect(merged.map(p => p.id)).toEqual(['COM1', 'COM3', 'COM2', 'COM10']);
    expect(merged[0].status).toBe('disconnected');
    expect(merged[3]).toMatchObject({ alias: '设备', status: 'connected', connectionGeneration: 7 });
  });

  it('preserves explicit numeric/drag order until the user switches back to added order', () => {
    const incoming = ['COM10', 'COM2', 'COM1', 'COM3'].map(id => makePort(id));
    useAppStore.getState().setPorts(incoming.slice(0, 3));
    const poll = () => {
      const state = useAppStore.getState();
      state.setPorts(mergePorts(incoming, state.ports, state.portOrder));
      return useAppStore.getState().ports.map(p => p.id);
    };
    useAppStore.getState().sortPortsByNumber();
    expect(poll()).toEqual(['COM1', 'COM2', 'COM10', 'COM3']);
    useAppStore.getState().setPortOrder('added');
    expect(poll()).toEqual(['COM10', 'COM2', 'COM1', 'COM3']);
    useAppStore.getState().reorderPorts(0, 2);
    expect(poll()).toEqual(['COM2', 'COM1', 'COM10', 'COM3']);
    useAppStore.getState().setPortOrder('added');
    expect(poll()).toEqual(['COM10', 'COM2', 'COM1', 'COM3']);
  });

  it('places temporarily missing live ports after the current enumeration without losing them', () => {
    const ghost = makePort('COM7', { status: 'connected' });
    const merged = mergePorts([makePort('COM2'), makePort('COM1')], [ghost, makePort('COM1')]);
    expect(merged.map(p => p.id)).toEqual(['COM2', 'COM1', 'COM7']);
    expect(merged[2]).toBe(ghost);
  });

  it('preserves the EXISTING order instead of resetting to enumeration order (issue #2-5)', () => {
    // 用户已把列表排成 COM2, COM1（拖拽或排序的结果）；
    // 轮询返回的枚举顺序是 COM1, COM2 —— 合并后顺序必须保持 COM2, COM1。
    const existing = [makePort('COM2'), makePort('COM1')];
    const incoming = [makePort('COM1'), makePort('COM2')];
    expect(mergePorts(incoming, existing, 'manual').map(p => p.id)).toEqual(['COM2', 'COM1']);
  });

  it('preserves manual order across a poll that also adds a new port (appended)', () => {
    const existing = [makePort('COM3'), makePort('COM1'), makePort('COM2')];
    const incoming = [makePort('COM1'), makePort('COM2'), makePort('COM3'), makePort('COM9')];
    expect(mergePorts(incoming, existing, 'manual').map(p => p.id)).toEqual(['COM3', 'COM1', 'COM2', 'COM9']);
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

  it('preserves explicit display preferences across enumeration polls', () => {
    const displayView = { pluginId: 'sensor', installGeneration: 'g1', viewId: 'table' };
    expect(mergePorts([makePort('COM1')], [makePort('COM1', { displayView })])[0].displayView).toEqual(displayView);
    expect(mergePorts([makePort('COM1')], [makePort('COM1', { displayView: null })])[0].displayView).toBeNull();
  });

  it('restores the preference of an offline port when it reappears', () => {
    const previous = useAppStore.getState().config.portMeta;
    const displayView = { pluginId: 'sensor', installGeneration: 'g1', viewId: 'table' };
    useAppStore.getState().setConfig({ portMeta: [{ portId: 'COM1', isHidden: false, displayView }] });
    try {
      expect(mergePorts([makePort('COM1')], [])[0].displayView).toEqual(displayView);
    } finally {
      useAppStore.getState().setConfig({ portMeta: previous });
    }
  });

  it('unions back a connected port that transiently vanished from enumeration', () => {
    const existing = [makePort('COM1'), makePort('COM2', { status: 'connected' })];
    const incoming = [makePort('COM1')];
    expect(mergePorts(incoming, existing).map(p => p.id)).toEqual(['COM1', 'COM2']);
  });

  it('clears the old missing-poll grace count when a port is removed after disconnect', () => {
    const id = 'COM-GRACE-RESET';
    const live = makePort(id, { status: 'connected' });
    expect(mergePorts([], [live])).toHaveLength(1);
    expect(mergePorts([], [live])).toHaveLength(1);
    expect(mergePorts([], [makePort(id)])).toEqual([]);
    // A later active session starts its full grace period, even if it was added
    // by a connection event rather than another successful enumeration.
    expect(mergePorts([], [live])).toHaveLength(1);
    expect(mergePorts([], [live])).toHaveLength(1);
    expect(mergePorts([], [live])).toHaveLength(1);
    expect(mergePorts([], [live])).toEqual([]);
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

  it('keeps a connected port for exactly 3 missing rounds and drops it on the 4th', () => {
    const ghost = makePort('COMG1', { status: 'connected' });
    let existing = [ghost, makePort('COM1')];
    for (let round = 1; round <= 4; round++) {
      existing = mergePorts([makePort('COM1')], existing);
      expect(existing.some(p => p.id === 'COMG1')).toBe(round <= 3);
      if (round <= 3) expect(existing.find(p => p.id === 'COMG1')).toMatchObject({ status: 'connected' });
    }
  });

  it('resets the counter on reappearance so a full grace period is available again', () => {
    let existing = [makePort('COMG3', { status: 'connected' }), makePort('COM1')];
    // 连续缺失 3 轮（宽限用满但仍保留）→ 计数为 3
    for (let i = 0; i < 3; i++) {
      existing = mergePorts([makePort('COM1')], existing);
      expect(existing.some(p => p.id === 'COMG3')).toBe(true);
    }
    // 端口重新出现 → 计数必须清零
    existing = mergePorts([makePort('COM1'), makePort('COMG3')], existing);
    expect(existing.some(p => p.id === 'COMG3')).toBe(true);
    // 再现后再次消失：完整 3 轮宽限重新生效（否则第 1 轮就会被丢）
    for (let i = 0; i < 3; i++) {
      existing = mergePorts([makePort('COM1')], existing);
      expect(existing.some(p => p.id === 'COMG3')).toBe(true);
    }
  });

  it('clears a stale missing counter when the port is backfilled as a new port', () => {
    // 1) connected 端口连续缺失 2 轮；随后断开并彻底离开列表，计数残留在模块 Map 中
    let existing = [makePort('COMG2', { status: 'connected' }), makePort('COM1')];
    existing = mergePorts([makePort('COM1')], existing);
    existing = mergePorts([makePort('COM1')], existing);
    expect(existing.some(p => p.id === 'COMG2')).toBe(true);
    existing = mergePorts([makePort('COM1')], [makePort('COMG2'), makePort('COM1')]);
    expect(existing.some(p => p.id === 'COMG2')).toBe(false);
    // 2) 端口重新枚举 → 以「新端口」身份回填；陈旧计数必须清零
    existing = mergePorts([makePort('COM1'), makePort('COMG2')], existing);
    existing = existing.map(p => (p.id === 'COMG2' ? { ...p, status: 'connected' as const } : p));
    // 3) 再拔出：3 轮缺失仍保留，第 4 轮才丢弃（陈旧计数会让第 2 轮就丢）
    for (let round = 1; round <= 4; round++) {
      existing = mergePorts([makePort('COM1')], existing);
      expect(existing.some(p => p.id === 'COMG2')).toBe(round <= 3);
    }
  });

  it('drops a vanished `error` port instead of ghost-retaining it', () => {
    const existing = [makePort('COM1'), makePort('COM6', { status: 'error' })];
    expect(mergePorts([makePort('COM1')], existing).map(p => p.id)).toEqual(['COM1']);
  });

  it('refreshes manufacturer/product from the latest enumeration', () => {
    const existing = [makePort('COM5', { status: 'connected', manufacturer: 'Old Vendor', product: 'Old Product' })];
    const fresh = mapPortInfo({
      id: 'COM5', name: 'COM5', port_type: 'real', manufacturer: 'New Vendor', product: 'New Product',
    });
    expect(mergePorts([fresh], existing)[0]).toMatchObject({
      status: 'connected',
      manufacturer: 'New Vendor',
      product: 'New Product',
    });
  });

  it('clears stale manufacturer/product when the fresh enumeration omits them', () => {
    const existing = [makePort('COM5', { manufacturer: 'Old Vendor', product: 'Old Product' })];
    const merged = mergePorts([makePort('COM5')], existing);
    expect(merged[0].manufacturer).toBeUndefined();
    expect(merged[0].product).toBeUndefined();
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

  it('keeps both simulation channels and their connection state independent', () => {
    const incoming = ['SIM:Loopback', 'SIM:Loopback2'].map(id => mapPortInfo({ id, name: id, port_type: 'sim' }));
    const merged = mergePorts(incoming, [
      { ...incoming[0], status: 'connected' },
      { ...incoming[1], status: 'disconnected', alias: 'Second channel' },
    ]);
    expect(merged.map(port => [port.id, port.type, port.status])).toEqual([
      ['SIM:Loopback', 'sim', 'connected'],
      ['SIM:Loopback2', 'sim', 'disconnected'],
    ]);
    expect(merged[0].alias).not.toBe('Second channel');
    expect(merged[1].alias).toBe('Second channel');
  });

  it('passes manufacturer/product through to SerialPort', () => {
    const mapped = mapPortInfo({
      id: 'COM3',
      name: 'COM3',
      port_type: 'real',
      manufacturer: 'Silicon Labs',
      product: 'CP2102 USB to UART Bridge',
    });
    expect(mapped.manufacturer).toBe('Silicon Labs');
    expect(mapped.product).toBe('CP2102 USB to UART Bridge');
  });

  it('leaves manufacturer/product undefined when the backend omits them', () => {
    const mapped = mapPortInfo({ id: 'COM4', name: 'COM4', port_type: 'real' });
    expect(mapped.manufacturer).toBeUndefined();
    expect(mapped.product).toBeUndefined();
  });
});
