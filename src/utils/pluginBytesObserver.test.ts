/**
 * pluginBytesObserver 测试（issue #17 能力补强）
 *
 * 覆盖：订阅接线（零订阅零开销——feedPluginBytes 早退）、字节批投递
 * （原始字节保真 + ts）、队列字节上限（超过丢最旧）、断流清队列。
 *
 * 投递调度在 node 下走 setTimeout 兜底（无 rAF）——用 vi fake timers 确定性驱动。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addPluginBytesObserver,
  resetPluginBytesObserverForTest,
  hasPluginBytesObservers,
  feedPluginBytes,
  notifyBytesPortDisconnected,
  MAX_BYTES_PER_DELIVERY,
  type ObservedRxBytes,
} from './pluginBytesObserver';

interface BytesSpy {
  batches: Array<{ portId: string; bytes: number[]; ts: number }>;
}

function makeObserver() {
  const spy: BytesSpy = { batches: [] };
  const obs = {
    onRxBytes: (batch: Array<{ portId: string; bytes: Uint8Array; ts: number }>) => {
      for (const b of batch) {
        spy.batches.push({ portId: b.portId, bytes: Array.from(b.bytes), ts: b.ts });
      }
    },
  };
  return { spy, obs };
}

/** 推进 fake timers 让 setTimeout 兜底投递触发（FALLBACK_TICK_MS=16）。 */
function flushDelivery(): void {
  vi.advanceTimersByTime(20);
}

beforeEach(() => {
  vi.useFakeTimers();
  resetPluginBytesObserverForTest();
});

afterEach(() => {
  resetPluginBytesObserverForTest();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('pluginBytesObserver', () => {
  it('零订阅者：feedPluginBytes O(1) 早退（无任何状态/调度副作用）', () => {
    expect(hasPluginBytesObservers()).toBe(false);
    feedPluginBytes('COM1', [1, 2, 3], 1000);
    expect(hasPluginBytesObservers()).toBe(false);
  });

  it('注册观察者后：批投递原始字节（保真 + ts）', () => {
    const { spy, obs } = makeObserver();
    const unsub = addPluginBytesObserver(obs);
    expect(hasPluginBytesObservers()).toBe(true);

    feedPluginBytes('COM1', [0x41, 0x42, 0x43], 1000);
    feedPluginBytes('COM1', [0x44], 1001);
    flushDelivery();

    // 同端口两个事件按流顺序合批投递。
    expect(spy.batches).toEqual([
      { portId: 'COM1', bytes: [0x41, 0x42, 0x43], ts: 1000 },
      { portId: 'COM1', bytes: [0x44], ts: 1001 },
    ]);

    unsub();
    expect(hasPluginBytesObservers()).toBe(false);
  });

  it('reschedules pending rAF on hide and pending timers on visibility restoration', () => {
    const page = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    const removeListener = vi.spyOn(page, 'removeEventListener');
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.stubGlobal('document', page);
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    }));
    const cancelFrame = vi.fn((id: number) => { frames.delete(id); });
    vi.stubGlobal('cancelAnimationFrame', cancelFrame);
    const { spy, obs } = makeObserver();
    const unsub = addPluginBytesObserver(obs);

    feedPluginBytes('COM1', [1], 100);
    expect(frames.size).toBe(1);
    page.visibilityState = 'hidden';
    page.dispatchEvent(new Event('visibilitychange'));
    expect(cancelFrame).toHaveBeenCalledWith(1);
    expect(frames.size).toBe(0);
    vi.advanceTimersByTime(16);
    expect(spy.batches).toEqual([{ portId: 'COM1', bytes: [1], ts: 100 }]);

    feedPluginBytes('COM1', [2], 200);
    page.visibilityState = 'visible';
    page.dispatchEvent(new Event('visibilitychange'));
    expect(vi.getTimerCount()).toBe(0);
    expect(frames.size).toBe(1);
    vi.advanceTimersByTime(16);
    expect(spy.batches).toHaveLength(1);
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback(0);
    expect(spy.batches[1]).toEqual({ portId: 'COM1', bytes: [2], ts: 200 });

    feedPluginBytes('COM1', [3], 300);
    unsub();
    expect(frames.size).toBe(0);
    expect(removeListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    page.visibilityState = 'hidden';
    page.dispatchEvent(new Event('visibilitychange'));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('last unsubscribe cancels timers and discards queued bytes and loss from the old lifecycle', () => {
    const oldDelivery = vi.fn();
    const oldUnsub = addPluginBytesObserver({ onRxBytes: oldDelivery });
    feedPluginBytes('COM1', new Uint8Array(2 * 1024 * 1024), 1);
    expect(vi.getTimerCount()).toBe(1);
    oldUnsub();
    expect(vi.getTimerCount()).toBe(0);
    expect(hasPluginBytesObservers()).toBe(false);

    const onRxBytes = vi.fn();
    const onRxDropped = vi.fn();
    const unsub = addPluginBytesObserver({ onRxBytes, onRxDropped });
    flushDelivery();
    expect(oldDelivery).not.toHaveBeenCalled();
    expect(onRxBytes).not.toHaveBeenCalled();
    feedPluginBytes('COM1', [9], 2);
    flushDelivery();
    expect(onRxBytes).toHaveBeenCalledExactlyOnceWith([{ portId: 'COM1', bytes: new Uint8Array([9]), ts: 2 }]);
    expect(onRxDropped).not.toHaveBeenCalled();
    unsub();
  });

  it('keeps a pending delivery when another subscriber remains', () => {
    const first = makeObserver();
    const second = makeObserver();
    const unsub = addPluginBytesObserver(first.obs);
    addPluginBytesObserver(second.obs);
    feedPluginBytes('COM1', [8], 1);
    unsub();
    flushDelivery();
    expect(first.spy.batches).toEqual([]);
    expect(second.spy.batches).toEqual([{ portId: 'COM1', bytes: [8], ts: 1 }]);
  });

  it('delivers independent exact-length buffers for input views and split chunks in timestamp order', () => {
    const delivered: ObservedRxBytes[] = [];
    addPluginBytesObserver({ onRxBytes: (batch) => { delivered.push(...batch); } });
    const backing = new Uint8Array([90, 1, 2, 91]);
    const large = new Uint8Array(MAX_BYTES_PER_DELIVERY + 3).fill(7);
    large.set([8, 9, 10], MAX_BYTES_PER_DELIVERY);
    feedPluginBytes('COM1', backing.subarray(1, 3), 10);
    flushDelivery();
    feedPluginBytes('COM1', large, 20);
    vi.advanceTimersByTime(32);

    expect(delivered.map((part) => [part.portId, part.bytes.length, part.ts])).toEqual([
      ['COM1', 2, 10], ['COM1', MAX_BYTES_PER_DELIVERY, 20], ['COM1', 3, 20],
    ]);
    expect(Array.from(delivered[0].bytes)).toEqual([1, 2]);
    expect(delivered[1].bytes.every((value) => value === 7)).toBe(true);
    expect(Array.from(delivered[2].bytes)).toEqual([8, 9, 10]);
    for (const part of delivered) {
      expect(part.bytes.byteOffset).toBe(0);
      expect(part.bytes.buffer.byteLength).toBe(part.bytes.byteLength);
      expect(part.bytes.buffer).not.toBe(backing.buffer);
      expect(part.bytes.buffer).not.toBe(large.buffer);
      const cloned = structuredClone(part.bytes);
      expect(cloned.buffer.byteLength).toBe(part.bytes.byteLength);
    }
    expect(delivered[1].bytes.buffer).not.toBe(delivered[2].bytes.buffer);
  });

  it('队列字节超限：丢最旧（保留最新）', () => {
    const { spy, obs } = makeObserver();
    addPluginBytesObserver(obs);

    // 每个 chunk 模拟一次 serial:data 事件（OS 读缓冲尺度），远小于每帧字节上限；
    // 聚合超过队列上限（1MB）时丢最旧。7 × 200KB = 1.4MB → 裁剪到 ≤1MB。
    const chunk = 200 * 1024;
    for (let i = 0; i < 7; i++) {
      feedPluginBytes('COM1', new Uint8Array(chunk).fill(i), i + 1);
    }
    flushDelivery();

    const totalDelivered = spy.batches.reduce((acc, b) => acc + b.bytes.length, 0);
    // 裁剪后交付总量 < 原始 1.4MB（丢了几块最旧的）。
    expect(totalDelivered).toBeLessThan(7 * chunk);
    expect(totalDelivered).toBeGreaterThan(0);

    // 每帧批投递不超字节上限（MAX_BYTES_PER_DELIVERY 是**批聚合**守卫，非块切分）；
    // 单事件 chunk（serial:data 一次 read ≤ 1024B）始终原子整块投递——数据保真的
    // 正确选择（切块需子块 ts + 丢尾部风险）。测试用的 200KB chunk 远小于 256KB 上限，
    // 每批 ≤ 上限恒成立。
    for (const b of spy.batches) {
      expect(b.bytes.length).toBeLessThanOrEqual(MAX_BYTES_PER_DELIVERY);
    }

    // 保留的是最新数据：最后一批的字节值是最大的 i（7 块里 i=6 保真在尾部）。
    const last = spy.batches[spy.batches.length - 1];
    expect(last.bytes[0]).toBe(Math.max(...spy.batches.map((x) => x.bytes[0])));
  });

  it('single oversized read is trimmed to last queue cap and split into strictly bounded deliveries', () => {
    const batches: number[] = [];
    const contents: number[] = [];
    addPluginBytesObserver({ onRxBytes: (batch) => {
      batches.push(batch.reduce((sum, part) => sum + part.bytes.length, 0));
      for (const part of batch) contents.push(part.bytes[0]);
    } });
    const bytes = new Uint8Array(2 * 1024 * 1024);
    bytes.fill(7, 1024 * 1024);
    feedPluginBytes('COM1', bytes, 1);
    vi.advanceTimersByTime(100);
    expect(batches.reduce((sum, size) => sum + size, 0)).toBe(1024 * 1024);
    expect(batches.every((size) => size <= MAX_BYTES_PER_DELIVERY)).toBe(true);
    expect(contents.every((value) => value === 7)).toBe(true);
  });
  it('reports trimmed byte count to a bytes-only observer', () => {
    const dropped = vi.fn();
    addPluginBytesObserver({ onRxBytes: () => {}, onRxDropped: dropped });
    feedPluginBytes('COM1', new Uint8Array(2 * 1024 * 1024), 1);
    flushDelivery();
    expect(dropped).toHaveBeenCalledWith({ portId: 'COM1', reason: 'queue-overflow', count: 1024 * 1024 });
  });
  it('notifies bytes-only subscriber when the port disconnects', () => {
    const detached = vi.fn();
    addPluginBytesObserver({ onRxBytes: () => {}, onRxDetached: detached });
    notifyBytesPortDisconnected('COM9');
    expect(detached).toHaveBeenCalledWith({ portId: 'COM9', reason: 'port-disconnected' });
  });
  it('断流清队列：notifyBytesPortDisconnected 后该端口残留字节丢弃', () => {
    const { spy, obs } = makeObserver();
    addPluginBytesObserver(obs);

    feedPluginBytes('COM1', [1, 2], 1);
    notifyBytesPortDisconnected('COM1');
    flushDelivery();

    expect(spy.batches).toEqual([]);
  });

  it('多订阅者：一批投递给全部（互不干扰）', () => {
    const a = makeObserver();
    const b = makeObserver();
    addPluginBytesObserver(a.obs);
    addPluginBytesObserver(b.obs);

    feedPluginBytes('COM1', [9], 5);
    flushDelivery();

    expect(a.spy.batches).toHaveLength(1);
    expect(b.spy.batches).toHaveLength(1);
    expect(a.spy.batches[0].bytes).toEqual([9]);
    expect(b.spy.batches[0].bytes).toEqual([9]);
  });
});
