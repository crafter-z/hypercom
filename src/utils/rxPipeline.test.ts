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

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

/** RX 行不再带 content（方案B, issue #14）：按管线约定（ignoreBOM:true 保留
 *  行首 BOM）从 rawData 惰性解码出文本用于断言。 */
const decodeLine = (line: TerminalLine, encoding = 'utf-8'): string =>
  new TextDecoder(encoding, { fatal: false, ignoreBOM: true }).decode(line.rawData ?? new Uint8Array());
const lineTexts = (lines: TerminalLine[], encoding = 'utf-8'): string[] =>
  lines.map((l) => decodeLine(l, encoding));

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
    expect(lineTexts(h.appended[0]!.lines)).toEqual(['abc', 'def']);
  });

  it('drains every queued port exactly once in a single tick (per-port isolation)', () => {
    const h = makeHarness();
    h.pipeline.feedBytes('COM1', bytes('a\n'), 1);
    h.pipeline.feedBytes('COM2', bytes('b\n'), 2);
    runTick(h);
    expect(h.appended).toHaveLength(2);
    expect(h.appended.map((a) => a.portId)).toEqual(['COM1', 'COM2']);
    expect(lineTexts(h.appended[0]!.lines)).toEqual(['a']);
    expect(lineTexts(h.appended[1]!.lines)).toEqual(['b']);
  });

  it('builds TerminalLines with event timestamp, RX direction and raw chunk bytes', () => {
    const h = makeHarness();
    h.pipeline.feedBytes('COM1', bytes('hi\n'), 42);
    runTick(h);
    const line = h.appended[0]!.lines[0]!;
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
    expect(lineTexts(h.appended[0]!.lines)).toEqual(['abc', 'def']);
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
    expect(decodeLine(line)).toBe('partial');
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
    expect(decodeLine(h.appended[0]!.lines[0]!)).toBe('abcdef');
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
    expect(lineTexts(h.appended[0]!.lines)).toEqual(['abc']);
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
    expect(decodeLine(line)).toHaveLength(4096);
    expect(line.rawData).toHaveLength(4096);
    expect(h.pendingTick).toBeNull(); // 无未终结尾部 → 没有静默定时器残留
  });

  it('forwards a custom maxPendingBytes to the assembler', () => {
    const h = makeHarness({ maxPendingBytes: 4 });
    h.pipeline.feedBytes('COM1', [1, 2, 3, 4], 1);
    runTick(h);
    // issue #6-2：rawData 现为 Uint8Array
    expect(h.appended[0]!.lines[0]!.rawData).toEqual(new Uint8Array([1, 2, 3, 4]));
  });
});

describe('RxPipeline — flushNow / flushAndReset / disconnect', () => {
  it('flushNow drains the queue synchronously without waiting for the tick', () => {
    const h = makeHarness();
    h.pipeline.feedBytes('COM1', bytes('x\ny\n'), 5);
    expect(h.appended).toHaveLength(0);
    h.pipeline.flushNow('COM1');
    expect(h.appended).toHaveLength(1);
    expect(lineTexts(h.appended[0]!.lines)).toEqual(['x', 'y']);
  });

  it('flushAndReset emits the pending tail before resetting assembler state', () => {
    const h = makeHarness();
    h.pipeline.feedBytes('COM1', bytes('abc'), 7);
    h.pipeline.flushAndReset('COM1');
    expect(h.appended).toHaveLength(1);
    expect(lineTexts(h.appended[0]!.lines)).toEqual(['abc']);
    expect(h.appended[0]!.lines[0]!.timestamp).toBe(7);
    // 重置后新字节不再与旧尾部合并
    h.pipeline.feedBytes('COM1', bytes('def\n'), 8);
    runTick(h);
    expect(lineTexts(h.appended[1]!.lines)).toEqual(['def']);
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
    expect(decodeLine(h.appended[0]!.lines[0]!)).toBe('tail');
    expect(h.appended[0]!.lines[0]!.timestamp).toBe(100);
    // 静默定时器已随端口状态一起丢弃：不会二次 flush
    vi.advanceTimersByTime(1000);
    expect(h.appended).toHaveLength(1);
    // 重连从干净状态开始：新数据不与断线前尾部合并
    h.pipeline.feedBytes('COM1', bytes('fresh\n'), 200);
    vi.advanceTimersByTime(16);
    expect(h.appended).toHaveLength(2);
    expect(decodeLine(h.appended[1]!.lines[0]!)).toBe('fresh');
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
    expect(lineTexts(h.appended[0]!.lines)).toEqual(['keep', 'also']);
  });

  it('keeps whitespace-only lines when disabled', () => {
    const h = makeHarness({ getIgnoreEmptyChars: () => false });
    h.pipeline.feedBytes('COM1', bytes('a\n \nb\n'), 1);
    runTick(h);
    expect(lineTexts(h.appended[0]!.lines)).toEqual(['a', ' ', 'b']);
  });

  it('reads the flag live per feed (not cached at construction)', () => {
    let ignore = false;
    const h = makeHarness({ getIgnoreEmptyChars: () => ignore });
    h.pipeline.feedBytes('COM1', bytes(' \n'), 1);
    ignore = true;
    h.pipeline.feedBytes('COM1', bytes('  \nok\n'), 2);
    runTick(h);
    expect(lineTexts(h.appended[0]!.lines)).toEqual([' ', 'ok']);
  });
});

describe('RxPipeline — enqueueLines ordering', () => {
  const frameLine = (id: string): TerminalLine => ({
    timestamp: 1,
    direction: 'RX',
    rawData: bytes(`FRAME-${id}`),
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
    expect(lineTexts(h.appended[0]!.lines)).toEqual(['FRAME-proto-1', 'abcdef', 'ghi']);
  });

  it('keeps multiple enqueued lines in insertion order', () => {
    const h = makeHarness();
    h.pipeline.enqueueLines('COM1', [frameLine('p1'), frameLine('p2')]);
    runTick(h);
    expect(lineTexts(h.appended[0]!.lines)).toEqual(['FRAME-p1', 'FRAME-p2']);
  });

  it('does not filter enqueued lines through ignoreEmptyChars (protocol frames bypass)', () => {
    const h = makeHarness({ getIgnoreEmptyChars: () => true });
    const blank: TerminalLine = {
      timestamp: 1, direction: 'RX', rawData: new Uint8Array([0x20]), isHex: false,
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
    expect(decodeLine(h.appended[0]!.lines[0]!)).toBe('\uFEFFA');
  });

  it('decodes multibyte chars kept whole by byte-level line splitting', () => {
    const h = makeHarness();
    // '你' UTF-8 = E4 BD A0；行边界不会切断它
    h.pipeline.feedBytes('COM1', [0xe4, 0xbd, 0xa0, 0x0a], 1);
    runTick(h);
    expect(decodeLine(h.appended[0]!.lines[0]!)).toBe('你');
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
    expect(lineTexts(h.appended[0]!.lines, 'iso-8859-1')).toEqual(['en', 'é']);
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

// ==================== issue #6-2：写量限制 ====================

describe('RxPipeline — maxLinesPerTick write limit (issue #6-2)', () => {
  it('appends at most maxLinesPerTick lines per tick and defers the rest', () => {
    const h = makeHarness({ maxLinesPerTick: 2 });
    // 5 行入队
    h.pipeline.feedBytes('COM1', bytes('a\nb\nc\nd\ne\n'), 1);
    runTick(h);
    // 首 tick 只写 2 行，剩余 3 行留在队列并重新调度
    expect(h.appended).toHaveLength(1);
    expect(lineTexts(h.appended[0]!.lines)).toEqual(['a', 'b']);
    expect(h.pendingTick).not.toBeNull();

    runTick(h);
    expect(lineTexts(h.appended[1]!.lines)).toEqual(['c', 'd']);
    expect(h.pendingTick).not.toBeNull();

    runTick(h);
    expect(lineTexts(h.appended[2]!.lines)).toEqual(['e']);
    expect(h.pendingTick).toBeNull(); // 队列已空
  });

  it('flushNow synchronously drains at most maxLinesPerTick and defers the rest', () => {
    const h = makeHarness({ maxLinesPerTick: 3 });
    h.pipeline.feedBytes('COM1', bytes('a\nb\nc\nd\ne\nf\ng\n'), 1);
    // 尚未 tick：直接 flushNow（同步）
    h.pipeline.flushNow('COM1');
    expect(lineTexts(h.appended[0]!.lines)).toEqual(['a', 'b', 'c']);
    // 剩余 4 行由 rAF 续写
    expect(h.pendingTick).not.toBeNull();
    runTick(h);
    expect(lineTexts(h.appended[1]!.lines)).toEqual(['d', 'e', 'f']);
    runTick(h);
    expect(lineTexts(h.appended[2]!.lines)).toEqual(['g']);
    expect(h.pendingTick).toBeNull();
  });

  it('per-port limits are independent (each port capped separately per tick)', () => {
    const h = makeHarness({ maxLinesPerTick: 2 });
    h.pipeline.feedBytes('COM1', bytes('a\nb\nc\n'), 1);
    h.pipeline.feedBytes('COM2', bytes('x\ny\nz\n'), 2);
    runTick(h);
    // 同一 tick 内两端口各写 2 行
    expect(h.appended.map((a) => a.portId)).toEqual(['COM1', 'COM2']);
    expect(lineTexts(h.appended[0]!.lines)).toEqual(['a', 'b']);
    expect(lineTexts(h.appended[1]!.lines)).toEqual(['x', 'y']);
    // 两端口都还有剩余 → 下一 tick 续写
    expect(h.pendingTick).not.toBeNull();
  });
});

// ==================== issue #6-10 方案3：队列上限 + visibility-aware 排空 ====================

describe('RxPipeline — maxQueuedLines queue cap (issue #6-10)', () => {
  const frameLine = (id: string): TerminalLine => ({
    timestamp: 1,
    direction: 'RX',
    rawData: bytes(`FRAME-${id}`),
    isHex: true,
    parsedFields: [],
  });

  it('drops the OLDEST lines when the queue exceeds maxQueuedLines', () => {
    const h = makeHarness({ maxQueuedLines: 3 });
    h.pipeline.feedBytes('COM1', bytes('a\nb\nc\nd\ne\n'), 1);
    runTick(h);
    // 5 行入队超 3 行上限：丢弃最旧的 a、b，保留 c、d、e
    expect(lineTexts(h.appended[0]!.lines)).toEqual(['c', 'd', 'e']);
  });

  it('enqueueLines also respects the queue cap', () => {
    const h = makeHarness({ maxQueuedLines: 2 });
    h.pipeline.enqueueLines('COM1', [frameLine('f1'), frameLine('f2'), frameLine('f3')]);
    runTick(h);
    expect(lineTexts(h.appended[0]!.lines)).toEqual(['FRAME-f2', 'FRAME-f3']);
  });

  it('does not drop anything when under the cap', () => {
    const h = makeHarness({ maxQueuedLines: 5 });
    h.pipeline.feedBytes('COM1', bytes('a\nb\nc\n'), 1);
    runTick(h);
    expect(lineTexts(h.appended[0]!.lines)).toEqual(['a', 'b', 'c']);
  });

  it('enforces the cap on the shared queue across feedBytes + enqueueLines', () => {
    const h = makeHarness({ maxQueuedLines: 3 });
    h.pipeline.feedBytes('COM1', bytes('a\nb\nc\n'), 1);
    h.pipeline.enqueueLines('COM1', [frameLine('f1'), frameLine('f2')]);
    runTick(h);
    // 队列 = [a,b,c] + [f1,f2] = 5 行超 3：丢最旧 a、b，保留 c,f1,f2
    expect(lineTexts(h.appended[0]!.lines)).toEqual(['c', 'FRAME-f1', 'FRAME-f2']);
  });
});

describe('RxPipeline — visibility-aware drain (issue #6-10)', () => {
  // 保存原全局，供 afterEach 恢复（node 环境默认无 document/rAF）
  const originalDoc = globalThis.document;
  const originalRaf = globalThis.requestAnimationFrame;
  const originalCaf = globalThis.cancelAnimationFrame;

  /** 构造可切换可见性的 document stub + rAF/cancelAnimationFrame stub */
  function stubVisibilityGlobals(initial: 'visible' | 'hidden') {
    const docListeners: Record<string, Array<() => void>> = {};
    let rafCallback: (() => void) | null = null;
    let rafCalls = 0;
    const doc = {
      visibilityState: initial,
      addEventListener: (ev: string, cb: () => void) => {
        (docListeners[ev] ??= []).push(cb);
      },
      removeEventListener: () => {},
    };
    (globalThis as any).document = doc;
    (globalThis as any).requestAnimationFrame = (cb: () => void): number => {
      rafCallback = cb;
      return ++rafCalls;
    };
    const cancelSpy = vi.fn(() => {
      // 取消 rAF id 即放弃当前挂起的 rAF 回调（对 setTimeout id 的误调不影响，
      // 此时 rafCallback 本就为 null）
      rafCallback = null;
    });
    (globalThis as any).cancelAnimationFrame = cancelSpy;
    return {
      docListeners,
      raf: () => rafCallback, // 未触发则 null
      cancelSpy,
      setVisibility: (v: 'visible' | 'hidden') => {
        doc.visibilityState = v;
        docListeners['visibilitychange']?.forEach((cb) => cb());
      },
    };
  }

  afterEach(() => {
    vi.useRealTimers();
    const g = globalThis as any;
    if (originalDoc === undefined) delete g.document;
    else g.document = originalDoc;
    if (originalRaf === undefined) delete g.requestAnimationFrame;
    else g.requestAnimationFrame = originalRaf;
    if (originalCaf === undefined) delete g.cancelAnimationFrame;
    else g.cancelAnimationFrame = originalCaf;
  });

  it('falls back to setTimeout when the document is hidden (rAF must not be used)', () => {
    vi.useFakeTimers();
    const stub = stubVisibilityGlobals('hidden');
    const h = makeHarness({ scheduleFlush: undefined, cancelFlush: undefined });
    h.pipeline.feedBytes('COM1', bytes('line\n'), 1);
    expect(stub.raf()).toBeNull(); // 隐藏时绝不走 rAF
    expect(h.appended).toHaveLength(0);
    vi.advanceTimersByTime(16); // setTimeout 兜底排空
    expect(h.appended).toHaveLength(1);
    expect(decodeLine(h.appended[0]!.lines[0]!)).toBe('line');
  });

  it('uses rAF when visible and drains on the rAF tick', () => {
    vi.useFakeTimers();
    const stub = stubVisibilityGlobals('visible');
    const h = makeHarness({ scheduleFlush: undefined, cancelFlush: undefined });
    h.pipeline.feedBytes('COM1', bytes('abc\n'), 1);
    expect(stub.raf()).not.toBeNull(); // 可见时走 rAF
    expect(h.appended).toHaveLength(0);
    stub.raf()!(); // 触发 rAF tick
    expect(h.appended).toHaveLength(1);
    expect(decodeLine(h.appended[0]!.lines[0]!)).toBe('abc');
  });

  it('re-arms a pending rAF tick as setTimeout when visibility flips to hidden', () => {
    vi.useFakeTimers();
    const stub = stubVisibilityGlobals('visible');
    const h = makeHarness({ scheduleFlush: undefined, cancelFlush: undefined });
    h.pipeline.feedBytes('COM1', bytes('a\n'), 1);
    expect(stub.raf()).not.toBeNull(); // 可见：rAF tick 挂起未触发
    expect(stub.cancelSpy).not.toHaveBeenCalled();

    // 切到隐藏：visibilitychange → 取消未触发 rAF tick + 按当前可见性重排（setTimeout）
    stub.setVisibility('hidden');
    expect(stub.cancelSpy).toHaveBeenCalled();
    expect(stub.raf()).toBeNull(); // 旧 rAF 回调已被取消放弃

    vi.advanceTimersByTime(16);
    expect(h.appended).toHaveLength(1); // setTimeout 兜底排空
    expect(decodeLine(h.appended[0]!.lines[0]!)).toBe('a');
  });

  it('re-arms a pending setTimeout tick back to rAF when visibility flips to visible', () => {
    vi.useFakeTimers();
    const stub = stubVisibilityGlobals('hidden');
    const h = makeHarness({ scheduleFlush: undefined, cancelFlush: undefined });
    h.pipeline.feedBytes('COM1', bytes('b\n'), 1);
    expect(stub.raf()).toBeNull(); // 隐藏：setTimeout tick 挂起

    stub.setVisibility('visible'); // visibilitychange → 重排回 rAF
    expect(stub.raf()).not.toBeNull();
    // 让旧 setTimeout tick 到期也不该二次排空（已被取消；若取消失败会重复 append）
    vi.advanceTimersByTime(16);
    expect(h.appended).toHaveLength(0); // 新 tick 是 rAF，尚未触发
    stub.raf()!();
    expect(h.appended).toHaveLength(1);
    expect(decodeLine(h.appended[0]!.lines[0]!)).toBe('b');
  });
});
