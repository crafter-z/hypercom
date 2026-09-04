/**
 * pluginObserver 测试（issue #17，评审 v2 P1/P12）
 *
 * 覆盖：订阅接线（零订阅零开销）、行批投递（编码 label + seq 单调）、
 * TRX→TTY 断流通知 + 队列清空、tty→trx 恢复续投、超帧额度顺延续投。
 *
 * 依赖真实 RxPipeline 模块单例 + useAppStore。投递调度在 node 下走
 * setTimeout 兜底（无 rAF）——用 vi fake timers 确定性驱动，不用真实等待。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addPluginRxObserver,
  resetPluginObserverForTest,
  hasPluginRxObservers,
  MAX_LINES_PER_DELIVERY,
  notifyPortDisconnected,
} from './pluginObserver';
import { getRxPipeline } from './rxPipeline';
import { useAppStore } from '../stores/useAppStore';

/** 把字节喂进管线（经 feedBytes 走真实行组装 → onLineAssembled 多播）。 */
function feedLine(portId: string, text: string, ts = 1000): void {
  const pipeline = getRxPipeline();
  pipeline.feedBytes(portId, new TextEncoder().encode(`${text}\n`), ts);
}

interface ObserverSpy {
  lines: Array<{ portId: string; text: string; encoding: string; seq: number }>;
  detached: Array<{ portId: string; reason: string }>;
}

function makeObserver() {
  const spy: ObserverSpy = { lines: [], detached: [] };
  const obs = {
    onRxLines: (
      lines: Array<{ rawData: Uint8Array; portId: string; encoding: string; seq: number; ts: number }>,
    ) => {
      for (const l of lines) {
        spy.lines.push({
          portId: l.portId,
          text: new TextDecoder().decode(l.rawData),
          encoding: l.encoding,
          seq: l.seq,
        });
      }
    },
    onRxDetached: (e: { portId: string; reason: string }) => {
      spy.detached.push(e);
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
  resetPluginObserverForTest();
  useAppStore.setState({ ports: [] });
});

afterEach(() => {
  resetPluginObserverForTest();
  vi.useRealTimers();
});

describe('pluginObserver', () => {
  it('订阅后行经多播钩子批投递（含编码 label + 内容）', () => {
    const { spy, obs } = makeObserver();
    const unsub = addPluginRxObserver(obs);

    feedLine('COM1', 'hello');
    flushDelivery();

    expect(spy.lines).toEqual([
      { portId: 'COM1', text: 'hello', encoding: 'utf-8', seq: 0 },
    ]);
    unsub();
  });

  it('多个订阅者都收到同一批（多播并存，不覆盖）', () => {
    const a = makeObserver();
    const b = makeObserver();
    const u1 = addPluginRxObserver(a.obs);
    const u2 = addPluginRxObserver(b.obs);

    feedLine('COM1', 'x');
    feedLine('COM1', 'y');
    flushDelivery();

    expect(a.spy.lines.map((l) => l.text)).toEqual(['x', 'y']);
    expect(b.spy.lines.map((l) => l.text)).toEqual(['x', 'y']);
    u1();
    u2();
  });

  it('多端口独立排队：端口间不串行', () => {
    const { spy, obs } = makeObserver();
    const unsub = addPluginRxObserver(obs);

    feedLine('COM1', 'a');
    feedLine('COM2', 'b');
    flushDelivery();

    expect(spy.lines.map((l) => `${l.portId}:${l.text}`).sort()).toEqual([
      'COM1:a',
      'COM2:b',
    ]);
    unsub();
  });

  it('首见端口为 tty 时只记录不通知（无「切换」可言）', () => {
    // 端口已是 tty 才订阅——首见快照记 tty，不应发 detached。
    useAppStore.setState({
      ports: [{ id: 'COM1', status: 'connected', mode: 'tty' }] as never,
    });
    const { spy, obs } = makeObserver();
    const unsub = addPluginRxObserver(obs);
    expect(spy.detached).toEqual([]);
    // tty 行不产生；切回 trx 也无 detached（恢复态）。
    useAppStore.setState({
      ports: [{ id: 'COM1', status: 'connected', mode: 'trx' }] as never,
    });
    expect(spy.detached).toEqual([]);
    unsub();
  });

  it('无订阅者时 hasPluginRxObservers 为 false（零插件零开销）', () => {
    expect(hasPluginRxObservers()).toBe(false);
    const { obs } = makeObserver();
    const unsub = addPluginRxObserver(obs);
    expect(hasPluginRxObservers()).toBe(true);
    unsub();
    expect(hasPluginRxObservers()).toBe(false);
  });

  it('超单帧投递上限的行顺延续投（不丢，队列额度内全投完）', () => {
    // 单次投递上限 MAX_LINES_PER_DELIVERY——一次喂超量行，分批全投完
    //（首帧 MAX 条，剩余顺延；队列额度 10000 > 2010 不触发丢最旧）。
    const { spy, obs } = makeObserver();
    const unsub = addPluginRxObserver(obs);
    const total = MAX_LINES_PER_DELIVERY + 10;
    for (let i = 0; i < total; i++) {
      feedLine('COM1', `line${i}`, 2000 + i);
    }
    // 每帧投 MAX 条——推进两帧多一点覆盖全部。
    flushDelivery();
    flushDelivery();
    expect(spy.lines.length).toBe(total);
    // 顺序保持（seq 单调 = 队列 FIFO）。
    expect(spy.lines[0].text).toBe('line0');
    expect(spy.lines[total - 1].text).toBe(`line${total - 1}`);
    unsub();
  });
  it('notifyPortDisconnected：断流通知 + 队列清空（复审补强：断线场景）', () => {
    const { spy, obs } = makeObserver();
    const unsub = addPluginRxObserver(obs);
    // 喂 3 行（未投递——fake timers 未推进，队列里挂着）。
    feedLine('COM1', 'a');
    feedLine('COM1', 'b');
    feedLine('COM1', 'c');
    notifyPortDisconnected('COM1');
    // 断流通知立刻发出；队列已清，后续推进不再投递旧行。
    expect(spy.detached).toEqual([{ portId: 'COM1', reason: 'port-disconnected' }]);
    flushDelivery();
    expect(spy.lines).toEqual([]);
    // 重新连接后（同 id 新端口状态）行恢复投递、seq 从新会话重新计数。
    feedLine('COM1', 'after');
    flushDelivery();
    expect(spy.lines.map((l) => l.text)).toEqual(['after']);
    expect(spy.lines[0]?.seq).toBe(0);
    unsub();
  });
  it('notifyPortDisconnected 对未知端口也通知（订阅者拿到 detached）', () => {
    const { spy, obs } = makeObserver();
    const unsub = addPluginRxObserver(obs);
    notifyPortDisconnected('COM9');
    expect(spy.detached).toEqual([{ portId: 'COM9', reason: 'port-disconnected' }]);
    unsub();
  });
});
