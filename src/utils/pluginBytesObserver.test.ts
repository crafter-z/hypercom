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
