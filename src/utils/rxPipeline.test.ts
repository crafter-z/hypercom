/**
 * RxPipeline — 按端口 RX 批处理管线测试。
 *
 * 覆盖：rAF 批写合并、端口隔离、静默 flush（时间戳 = 最后事件时间）、
 * 4096 强制发射集成、flushNow 同步排空、flushAndReset / disconnect 生命周期、
 * ignoreEmptyChars 过滤、enqueueLines 与 feedBytes 的相对顺序、BOM 保留。
 *
 * 环境为 node（无 rAF / 无 DOM）：走 scheduleFlush 注入或 setTimeout 回退。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TerminalLine } from '../types';
import { RxPipeline } from './rxPipeline';
import type { RxPipelineOptions } from './rxPipeline';

const bytes = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));

interface RecordedAppend {
  portId: string;
  lines: TerminalLine[];
}

interface Harness {
  pipeline: RxPipeline;
  appended: RecordedAppend[];
  /** 手动调度模式下捕获的 tick 回调（未调度为 null） */
  pendingTick: (() => void) | null;
}

/** 构造受控管线：默认手动调度（tick 不自动触发），可按需覆盖 */
function makeHarness(overrides: Partial<RxPipelineOptions> = {}): Harness {
  const appended: RecordedAppend[] = [];
  const harness: Harness = { pipeline: null as unknown as RxPipeline, appended, pendingTick: null };
  harness.pipeline = new RxPipeline({
    appendLines: (portId, lines) => {
      appended.push({ portId, lines: [...lines] });
    },
    getEncodingLabel: () => 'utf-8',
    getIgnoreEmptyChars: () => false,
    scheduleFlush: (cb) => {
      harness.pendingTick = cb;
      return 1;
    },
    cancelFlush: () => {
      harness.pendingTick = null;
    },
    ...overrides,
  });
  return harness;
}

/** 断言并触发已调度的批写 tick */
function runTick(harness: Harness): void {
  const tick = harness.pendingTick;
  expect(tick, 'a flush tick must be scheduled').not.toBeNull();
  harness.pendingTick = null;
  tick!();
}

afterEach(() => {
  vi.useRealTimers();
});

describe('RxPipeline — batched writes', () => {
  it('batches multiple feeds into ONE appendLines call per port', () => {
    const h = makeHarness();
    h.pipeline.feedBytes('COM1', bytes('abc\n'), 1000);
    h.pipeline.feedBytes('COM1', bytes('def\n'), 1001);
    expect(h.appended).toHaveLength(0); // 批写前不落盘
    runTick(h);
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0]!.portId).toBe('COM1');
    expect(h.appended[0]!.lines.map((l) => l.content)).toEqual(['abc', 'def']);
  });

  it('drains every queued port exactly once in a single tick (per-port isolation)', () => {
    const h = makeHarness();
    h.pipeline.feedBytes('COM1', bytes('a\n'), 1);
    h.pipeline.feedBytes('COM2', bytes('b\n'), 2);
    runTick(h);
    expect(h.appended).toHaveLength(2);
    expect(h.appended.map((a) => a.portId)).toEqual(['COM1', 'COM2']);
    expect(h.appended[0]!.lines.map((l) => l.content)).toEqual(['a']);
    expect(h.appended[1]!.lines.map((l) => l.content)).toEqual(['b']);
  });

  it('builds TerminalLines with event timestamp, RX direction and raw chunk bytes', () => {
    const h = makeHarness();
    h.pipeline.feedBytes('COM1', bytes('hi\n'), 42);
    runTick(h);
    const line = h.appended[0]!.lines[0]!;
    expect(line.id).toMatch(/^line-\d+-/);
    expect(line.timestamp).toBe(42);
    expect(line.direction).toBe('RX');
    expect(line.rawData).toEqual(bytes('hi'));
    expect(line.isHex).toBe(false);
  });

  it('reassembles a CRLF-split line across events into one terminal line', () => {
    const h = makeHarness();
    h.pipeline.feedBytes('COM1', bytes('abc\r'), 1);
    h.pipeline.feedBytes('COM1', bytes('\ndef\n'), 2);
    runTick(h);
    expect(h.appended[0]!.lines.map((l) => l.content)).toEqual(['abc', 'def']);
  });

  it('does nothing for an empty feed (no line, no tick)', () => {
    const h = makeHarness();
    h.pipeline.feedBytes('COM1', [], 1);
    expect(h.pendingTick).toBeNull();
    expect(h.appended).toHaveLength(0);
  });

  it('scheduled tick is a no-op after flushNow already drained the queue', () => {
    const h = makeHarness();
    h.pipeline.feedBytes('COM1', bytes('x\n'), 1);
    h.pipeline.flushNow('COM1');
    expect(h.appended).toHaveLength(1);
    runTick(h); // 队列已空：不得重复写入
    expect(h.appended).toHaveLength(1);
  });
});

describe('RxPipeline — silence flush', () => {
  it('flushes an unterminated tail after silenceFlushMs using the LAST EVENT timestamp', () => {
    vi.useFakeTimers();
    const eventTs = 1_700_000_000_000;
    vi.setSystemTime(eventTs);
    // 默认调度器（node 无 rAF → setTimeout 16ms）+ 真实静默定时器
    const h = makeHarness({ scheduleFlush: undefined, cancelFlush: undefined });
    h.pipeline.feedBytes('COM1', bytes('partial'), eventTs); // 无分隔符
    vi.advanceTimersByTime(16); // 批写 tick：队列里没有完成行
    expect(h.appended).toHaveLength(0);
    vi.advanceTimersByTime(250); // 静默 flush 到期
    expect(h.appended).toHaveLength(1);
    const line = h.appended[0]!.lines[0]!;
    expect(line.content).toBe('partial');
    // 关键断言：行时间戳 = 事件时间，而不是 flush 时刻（已过去 266ms）
    expect(line.timestamp).toBe(eventTs);
    expect(Date.now()).toBeGreaterThan(eventTs);
  });

  it('restarts the silence window on every new event', () => {
    vi.useFakeTimers();
    const h = makeHarness({ scheduleFlush: undefined, cancelFlush: undefined, silenceFlushMs: 100 });
    h.pipeline.feedBytes('COM1', bytes('abc'), 10);
    vi.advanceTimersByTime(80);
    h.pipeline.feedBytes('COM1', bytes('def'), 20); // 重置窗口
    vi.advanceTimersByTime(80); // 距首次 feed 160ms，但距上次只有 80ms
    expect(h.appended).toHaveLength(0);
    vi.advanceTimersByTime(20); // 距上次 feed 满 100ms
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0]!.lines[0]!.content).toBe('abcdef');
    expect(h.appended[0]!.lines[0]!.timestamp).toBe(20);
  });

  it('does not leave a stale silence timer once the tail gets terminated', () => {
    vi.useFakeTimers();
    const h = makeHarness({ scheduleFlush: undefined, cancelFlush: undefined, silenceFlushMs: 50 });
    h.pipeline.feedBytes('COM1', bytes('abc'), 1);
    h.pipeline.feedBytes('COM1', bytes('\n'), 2); // 尾部终结
    vi.advanceTimersByTime(16 + 50 + 50);
    // 只有批写 tick 的一次落盘；静默定时器已被取消，不会产生尾行
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0]!.lines.map((l) => l.content)).toEqual(['abc']);
  });
});

describe('RxPipeline — force flush via assembler', () => {
  it('force-flushes 4096 pending bytes without a separator (default threshold)', () => {
    const h = makeHarness();
    const bulk = Array.from({ length: 4096 }, () => 0x61);
    h.pipeline.feedBytes('COM1', bulk, 7);
    runTick(h);
    expect(h.appended).toHaveLength(1);
    const line = h.appended[0]!.lines[0]!;
    expect(line.content).toHaveLength(4096);
    expect(line.rawData).toHaveLength(4096);
    expect(h.pendingTick).toBeNull(); // 无未终结尾部 → 没有静默定时器残留
  });

  it('forwards a custom maxPendingBytes to the assembler', () => {
    const h = makeHarness({ maxPendingBytes: 4 });
    h.pipeline.feedBytes('COM1', [1, 2, 3, 4], 1);
    runTick(h);
    expect(h.appended[0]!.lines[0]!.rawData).toEqual([1, 2, 3, 4]);
  });
});

describe('RxPipeline — flushNow / flushAndReset / disconnect', () => {
  it('flushNow drains the queue synchronously without waiting for the tick', () => {
    const h = makeHarness();
    h.pipeline.feedBytes('COM1', bytes('x\ny\n'), 5);
    expect(h.appended).toHaveLength(0);
    h.pipeline.flushNow('COM1');
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0]!.lines.map((l) => l.content)).toEqual(['x', 'y']);
  });

  it('flushAndReset emits the pending tail before resetting assembler state', () => {
    const h = makeHarness();
    h.pipeline.feedBytes('COM1', bytes('abc'), 7);
    h.pipeline.flushAndReset('COM1');
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0]!.lines.map((l) => l.content)).toEqual(['abc']);
    expect(h.appended[0]!.lines[0]!.timestamp).toBe(7);
    // 重置后新字节不再与旧尾部合并
    h.pipeline.feedBytes('COM1', bytes('def\n'), 8);
    runTick(h);
    expect(h.appended[1]!.lines.map((l) => l.content)).toEqual(['def']);
  });

  it('flushAndReset cancels the pending silence timer', () => {
    vi.useFakeTimers();
    const h = makeHarness({ scheduleFlush: undefined, cancelFlush: undefined, silenceFlushMs: 50 });
    h.pipeline.feedBytes('COM1', bytes('abc'), 1);
    h.pipeline.flushAndReset('COM1');
    const flushed = h.appended.length;
    expect(flushed).toBeGreaterThan(0);
    vi.advanceTimersByTime(1000);
    expect(h.appended).toHaveLength(flushed); // 无二次 flush
  });

  it('disconnect flushes the tail synchronously then discards all per-port state', () => {
    vi.useFakeTimers();
    const h = makeHarness({ scheduleFlush: undefined, cancelFlush: undefined });
    h.pipeline.feedBytes('COM1', bytes('tail'), 100);
    h.pipeline.disconnect('COM1');
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0]!.lines[0]!.content).toBe('tail');
    expect(h.appended[0]!.lines[0]!.timestamp).toBe(100);
    // 静默定时器已随端口状态一起丢弃：不会二次 flush
    vi.advanceTimersByTime(1000);
    expect(h.appended).toHaveLength(1);
    // 重连从干净状态开始：新数据不与断线前尾部合并
    h.pipeline.feedBytes('COM1', bytes('fresh\n'), 200);
    vi.advanceTimersByTime(16);
    expect(h.appended).toHaveLength(2);
    expect(h.appended[1]!.lines[0]!.content).toBe('fresh');
  });

  it('flushNow / flushTail / disconnect are no-ops for unknown ports', () => {
    const h = makeHarness();
    expect(() => {
      h.pipeline.flushNow('GHOST');
      h.pipeline.flushTail('GHOST');
      h.pipeline.flushAndReset('GHOST');
      h.pipeline.disconnect('GHOST');
    }).not.toThrow();
    expect(h.appended).toHaveLength(0);
  });
});

describe('RxPipeline — ignoreEmptyChars', () => {
  it('drops whitespace-only lines when enabled', () => {
    const h = makeHarness({ getIgnoreEmptyChars: () => true });
    h.pipeline.feedBytes('COM1', bytes('keep\n   \n\t\nalso\n'), 1);
    runTick(h);
    expect(h.appended[0]!.lines.map((l) => l.content)).toEqual(['keep', 'also']);
  });

  it('keeps whitespace-only lines when disabled', () => {
    const h = makeHarness({ getIgnoreEmptyChars: () => false });
    h.pipeline.feedBytes('COM1', bytes('a\n \nb\n'), 1);
    runTick(h);
    expect(h.appended[0]!.lines.map((l) => l.content)).toEqual(['a', ' ', 'b']);
  });

  it('reads the flag live per feed (not cached at construction)', () => {
    let ignore = false;
    const h = makeHarness({ getIgnoreEmptyChars: () => ignore });
    h.pipeline.feedBytes('COM1', bytes(' \n'), 1);
    ignore = true;
    h.pipeline.feedBytes('COM1', bytes('  \nok\n'), 2);
    runTick(h);
    expect(h.appended[0]!.lines.map((l) => l.content)).toEqual([' ', 'ok']);
  });
});

describe('RxPipeline — enqueueLines ordering', () => {
  const frameLine = (id: string): TerminalLine => ({
    id,
    timestamp: 1,
    direction: 'RX',
    content: 'FRAME',
    rawData: [0xaa],
    isHex: true,
    parsedFields: [],
  });

  it('preserves order relative to feedBytes output on the shared queue', () => {
    const h = makeHarness();
    h.pipeline.feedBytes('COM1', bytes('abc'), 1); // 仅进组装器 pending，未成行
    h.pipeline.enqueueLines('COM1', [frameLine('proto-1')]); // 协议帧先行入队
    h.pipeline.feedBytes('COM1', bytes('def\n'), 2); // 'abcdef' 成行排在帧之后
    h.pipeline.feedBytes('COM1', bytes('ghi\n'), 3);
    runTick(h);
    expect(h.appended[0]!.lines.map((l) => l.content)).toEqual(['FRAME', 'abcdef', 'ghi']);
  });

  it('keeps multiple enqueued lines in insertion order', () => {
    const h = makeHarness();
    h.pipeline.enqueueLines('COM1', [frameLine('p1'), frameLine('p2')]);
    runTick(h);
    expect(h.appended[0]!.lines.map((l) => l.id)).toEqual(['p1', 'p2']);
  });

  it('does not filter enqueued lines through ignoreEmptyChars (protocol frames bypass)', () => {
    const h = makeHarness({ getIgnoreEmptyChars: () => true });
    const blank: TerminalLine = {
      id: 'p-blank', timestamp: 1, direction: 'RX', content: '   ', rawData: [0x20], isHex: false,
    };
    h.pipeline.enqueueLines('COM1', [blank]);
    runTick(h);
    expect(h.appended[0]!.lines).toHaveLength(1); // enqueueLines 不做空白过滤
  });
});

describe('RxPipeline — decoding', () => {
  it('preserves a leading UTF-8 BOM in decoded content (ignoreBOM: true)', () => {
    const h = makeHarness();
    h.pipeline.feedBytes('COM1', [0xef, 0xbb, 0xbf, 0x41, 0x0a], 1);
    runTick(h);
    expect(h.appended[0]!.lines[0]!.content).toBe('\uFEFFA');
  });

  it('decodes multibyte chars kept whole by byte-level line splitting', () => {
    const h = makeHarness();
    // '你' UTF-8 = E4 BD A0；行边界不会切断它
    h.pipeline.feedBytes('COM1', [0xe4, 0xbd, 0xa0, 0x0a], 1);
    runTick(h);
    expect(h.appended[0]!.lines[0]!.content).toBe('你');
  });

  it('decodeText decodes under the port-specific current label (GBK example)', () => {
    const labels = new Map([['COM1', 'gbk']]);
    const h = makeHarness({ getEncodingLabel: (p) => labels.get(p) ?? 'utf-8' });
    // GBK: C4E3 BAC3 = 你好
    expect(h.pipeline.decodeText('COM1', [0xc4, 0xe3, 0xba, 0xc3])).toBe('你好');
    // 未配置 label 的端口回落 utf-8
    expect(h.pipeline.decodeText('COM2', [0x41])).toBe('A');
  });

  it('switches decoders when the label changes mid-stream', () => {
    let label = 'utf-8';
    const h = makeHarness({ getEncodingLabel: () => label });
    h.pipeline.feedBytes('COM1', bytes('en\n'), 1);
    label = 'iso-8859-1';
    h.pipeline.feedBytes('COM1', [0xe9, 0x0a], 2); // é in ISO-8859-1
    runTick(h);
    expect(h.appended[0]!.lines.map((l) => l.content)).toEqual(['en', 'é']);
  });
});

describe('RxPipeline — dispose', () => {
  it('cancels the scheduled flush tick and all silence timers', () => {
    vi.useFakeTimers();
    const h = makeHarness({ scheduleFlush: undefined, cancelFlush: undefined });
    h.pipeline.feedBytes('COM1', bytes('abc\n'), 1);
    h.pipeline.feedBytes('COM2', bytes('partial'), 2);
    h.pipeline.dispose();
    vi.advanceTimersByTime(1000);
    expect(h.appended).toHaveLength(0);
  });

  it('cancels a manually scheduled tick via cancelFlush', () => {
    const h = makeHarness();
    h.pipeline.feedBytes('COM1', bytes('abc\n'), 1);
    expect(h.pendingTick).not.toBeNull();
    h.pipeline.dispose();
    expect(h.pendingTick).toBeNull();
  });
});
