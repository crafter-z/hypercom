/**
 * trafficStats — 流量统计 1s 聚合器测试（性能修复 P1-1）。
 *
 * 覆盖：RX/TX 字节先本地累计、每秒统一写一次 store；总量语义不变（全部累计、
 * 一次不少）；多端口隔离；flush 后窗口重启；flushNow 即时写；非正字节忽略。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useSystemStore } from '../stores/useSystemStore';
import { trafficStats, TRAFFIC_AGGREGATE_MS } from './trafficStats';

describe('trafficStats — 1s 聚合', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    trafficStats.reset();
    useSystemStore.setState({ trafficStats: {} });
  });

  it('accumulates RX locally and writes the store once per second', () => {
    trafficStats.addRx('COM1', 10);
    trafficStats.addRx('COM1', 20);
    // 窗口未到：store 不更新（消除每事件 Zustand 更新/重渲染的关键）
    expect(useSystemStore.getState().trafficStats.COM1).toBeUndefined();
    vi.advanceTimersByTime(TRAFFIC_AGGREGATE_MS);
    const stats = useSystemStore.getState().trafficStats.COM1;
    expect(stats?.rxTotal).toBe(30);
    expect(stats?.txTotal).toBe(0);
  });

  it('accumulates TX', () => {
    trafficStats.addTx('COM1', 5);
    trafficStats.addTx('COM1', 7);
    vi.advanceTimersByTime(TRAFFIC_AGGREGATE_MS);
    const stats = useSystemStore.getState().trafficStats.COM1;
    expect(stats?.txTotal).toBe(12);
    expect(stats?.rxTotal).toBe(0);
  });

  it('merges RX and TX for the same port', () => {
    trafficStats.addRx('COM1', 100);
    trafficStats.addTx('COM1', 3);
    vi.advanceTimersByTime(TRAFFIC_AGGREGATE_MS);
    const stats = useSystemStore.getState().trafficStats.COM1;
    expect(stats?.rxTotal).toBe(100);
    expect(stats?.txTotal).toBe(3);
  });

  it('keeps ports separate', () => {
    trafficStats.addRx('COM1', 10);
    trafficStats.addRx('COM2', 20);
    vi.advanceTimersByTime(TRAFFIC_AGGREGATE_MS);
    expect(useSystemStore.getState().trafficStats.COM1?.rxTotal).toBe(10);
    expect(useSystemStore.getState().trafficStats.COM2?.rxTotal).toBe(20);
  });

  it('accumulates onto the existing store totals (no double count)', () => {
    useSystemStore.getState().setTrafficStats('COM1', { rxTotal: 50, txTotal: 0 });
    trafficStats.addRx('COM1', 10);
    vi.advanceTimersByTime(TRAFFIC_AGGREGATE_MS);
    expect(useSystemStore.getState().trafficStats.COM1?.rxTotal).toBe(60);
  });

  it('restarts the window after a flush (totals stay exact)', () => {
    trafficStats.addRx('COM1', 10);
    vi.advanceTimersByTime(TRAFFIC_AGGREGATE_MS);
    expect(useSystemStore.getState().trafficStats.COM1?.rxTotal).toBe(10);
    trafficStats.addRx('COM1', 15);
    // 新一轮窗口未到期：store 保持上一轮值
    expect(useSystemStore.getState().trafficStats.COM1?.rxTotal).toBe(10);
    vi.advanceTimersByTime(TRAFFIC_AGGREGATE_MS);
    expect(useSystemStore.getState().trafficStats.COM1?.rxTotal).toBe(25);
  });

  it('flushNow writes pending bytes immediately', () => {
    trafficStats.addRx('COM1', 42);
    trafficStats.flushNow();
    expect(useSystemStore.getState().trafficStats.COM1?.rxTotal).toBe(42);
    // flush 后累计清空，再次 flush 不重复写
    trafficStats.flushNow();
    expect(useSystemStore.getState().trafficStats.COM1?.rxTotal).toBe(42);
  });

  it('ignores non-positive byte counts (no timer, no store write)', () => {
    trafficStats.addRx('COM1', 0);
    trafficStats.addTx('COM1', -1);
    vi.advanceTimersByTime(TRAFFIC_AGGREGATE_MS * 2);
    expect(useSystemStore.getState().trafficStats.COM1).toBeUndefined();
  });

  it('release drops the store entry AND the pending accumulation', () => {
    trafficStats.addRx('COM1', 30);
    trafficStats.flushNow();
    expect(useSystemStore.getState().trafficStats.COM1?.rxTotal).toBe(30);

    trafficStats.addRx('COM1', 10); // 窗口未到，仍在本地累计
    trafficStats.release('COM1');
    expect(useSystemStore.getState().trafficStats.COM1).toBeUndefined();

    // pending 必须被丢弃而不是留给下一次 flush——否则刚清理的幽灵条目会复活
    vi.advanceTimersByTime(TRAFFIC_AGGREGATE_MS);
    expect(useSystemStore.getState().trafficStats.COM1).toBeUndefined();
  });
});
