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
} from './pluginObserver';
import { getRxPipeline } from './rxPipeline';
import { useAppStore } from '../stores/useAppStore';

/** 把字节喂进管线（经 feedBytes 走真实行组装 → onLineAssembled 多播）。 */
function feedLine(portId: string, text: string, ts = 1000): void {
  const pipeline = getRxPipeline();
  pipeline.feedBytes(portId, new TextEncoder().encode(`${text}\n`), ts);
}

interface ObserverSpy {
  lines: Array<{ portId: string; text: string; encoding: string }>;
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
      { portId: 'COM1', text: 'hello', encoding: 'utf-8' },
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

  it('TRX→TTY 切换发断流通知；tty→trx 恢复续投', () => {
    // 先置 trx 端口 + 订阅（初始快照 lastMode=trx）。
    useAppStore.setState({
      ports: [{ id: 'COM1', status: 'connected', mode: 'trx' }] as never,
    });
    const { spy, obs } = makeObserver();
    const unsub = addPluginRxObserver(obs);

    // TRX → TTY：应发 detached（store 订阅同步触发）。
    useAppStore.setState({
      ports: [{ id: 'COM1', status: 'connected', mode: 'tty' }] as never,
    });
    expect(spy.detached).toEqual([{ portId: 'COM1', reason: 'mode-tty' }]);

    // 切回 trx：无新增 detached。
    useAppStore.setState({
      ports: [{ id: 'COM1', status: 'connected', mode: 'trx' }] as never,
    });
    expect(spy.detached.length).toBe(1);

    // 恢复后行正常投递。
    feedLine('COM1', 'after-restore');
    flushDelivery();
    expect(spy.lines.map((l) => l.text)).toEqual(['after-restore']);
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
});
