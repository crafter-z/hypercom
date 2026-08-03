/**
 * RxLineAssembler — 字节级行聚合器测试。
 *
 * 覆盖：LF/CR/CRLF（含跨 feed 的 CRLF 对）、连续分隔符空块、跨事件边界、
 * 强制发射（默认 4096 与自定义阈值）、takeTail/reset 生命周期。
 */
import { describe, expect, it } from 'vitest';
import { RxLineAssembler } from './rxAssembler';

/** ASCII 字符串 → 字节数组 */
const bytes = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));

describe('RxLineAssembler — basic separators', () => {
  it('returns no lines for an empty feed', () => {
    const asm = new RxLineAssembler();
    expect(asm.feed([])).toEqual([]);
    expect(asm.hasPending).toBe(false);
  });

  it('emits a line terminated by LF', () => {
    const asm = new RxLineAssembler();
    expect(asm.feed(bytes('hello\n'))).toEqual([bytes('hello')]);
    expect(asm.hasPending).toBe(false);
  });

  it('emits a line terminated by CR (classic Mac separator)', () => {
    const asm = new RxLineAssembler();
    expect(asm.feed(bytes('hello\r'))).toEqual([bytes('hello')]);
    expect(asm.hasPending).toBe(false);
  });

  it('keeps the line content free of separator bytes', () => {
    const asm = new RxLineAssembler();
    const [line] = asm.feed([0x41, 0x0a, 0x42, 0x0d]);
    expect(line).toEqual([0x41]);
    expect(line).not.toContain(0x0a);
  });

  it('handles full binary byte range including 0x00 and 0xff', () => {
    const asm = new RxLineAssembler();
    const input = [0x00, 0x7f, 0x80, 0xff, 0x0a];
    expect(asm.feed(input)).toEqual([[0x00, 0x7f, 0x80, 0xff]]);
  });

  it('accepts Uint8Array input (ArrayLike<number>)', () => {
    const asm = new RxLineAssembler();
    const result = asm.feed(new Uint8Array([0x68, 0x69, 0x0a]));
    expect(result).toEqual([bytes('hi')]);
  });
});

describe('RxLineAssembler — CRLF pair handling', () => {
  it('treats a CRLF pair within one feed as ONE separator', () => {
    const asm = new RxLineAssembler();
    expect(asm.feed(bytes('AB\r\nCD\n'))).toEqual([bytes('AB'), bytes('CD')]);
  });

  it('treats a CRLF pair split across two feeds as ONE separator', () => {
    const asm = new RxLineAssembler();
    expect(asm.feed(bytes('AB\r'))).toEqual([bytes('AB')]);
    // LF 是上一 feed CR 的后半：必须被静默吞掉，不能产生空行
    expect(asm.feed(bytes('\nCD\n'))).toEqual([bytes('CD')]);
  });

  it('does not swallow a non-LF byte following CR across feeds', () => {
    const asm = new RxLineAssembler();
    expect(asm.feed(bytes('X\r'))).toEqual([bytes('X')]);
    // 下一段以 'Y' 开头：pendingCR 被清除，Y 正常进入下一行
    expect(asm.feed(bytes('YZ\n'))).toEqual([bytes('YZ')]);
  });

  it('emits an empty line for a bare CRLF between text lines', () => {
    const asm = new RxLineAssembler();
    expect(asm.feed(bytes('a\r\n\r\nb\n'))).toEqual([bytes('a'), [], bytes('b')]);
  });

  it('clears pendingCR after any normal byte (no delayed consumption)', () => {
    const asm = new RxLineAssembler();
    asm.feed(bytes('a\r'));
    asm.feed(bytes('b'));
    // CR 后的字节已正常处理；此时到来的 LF 是**新的**分隔符
    expect(asm.feed(bytes('\n'))).toEqual([bytes('b')]);
  });
});

describe('RxLineAssembler — consecutive separators / empty lines', () => {
  it('emits one empty chunk per consecutive LF', () => {
    const asm = new RxLineAssembler();
    expect(asm.feed(bytes('\n\n\n'))).toEqual([[], [], []]);
  });

  it('emits one empty chunk per consecutive CR', () => {
    const asm = new RxLineAssembler();
    expect(asm.feed(bytes('\r\r'))).toEqual([[], []]);
  });

  it('emits one empty chunk per CRLF pair in a separator-only feed', () => {
    const asm = new RxLineAssembler();
    expect(asm.feed(bytes('\r\n\r\n'))).toEqual([[], []]);
  });

  it('handles interleaved CR / LF / CRLF separators', () => {
    const asm = new RxLineAssembler();
    expect(asm.feed(bytes('a\rb\nc\r\nd\n'))).toEqual([
      bytes('a'), bytes('b'), bytes('c'), bytes('d'),
    ]);
  });

  it('emits empty line when separator opens the feed', () => {
    const asm = new RxLineAssembler();
    expect(asm.feed(bytes('\nfirst\n'))).toEqual([[], bytes('first')]);
  });
});

describe('RxLineAssembler — feed boundaries', () => {
  it('keeps an unterminated tail pending until the next separator', () => {
    const asm = new RxLineAssembler();
    expect(asm.feed(bytes('hel'))).toEqual([]);
    expect(asm.hasPending).toBe(true);
    expect(asm.feed(bytes('lo\n'))).toEqual([bytes('hello')]);
    expect(asm.hasPending).toBe(false);
  });

  it('byte-by-byte feeding matches a single whole feed', () => {
    const stream = 'hello\r\nworld\rend\nlast\n';
    const whole = new RxLineAssembler();
    const expected = whole.feed(bytes(stream));

    const stepwise = new RxLineAssembler();
    const collected: number[][] = [];
    for (const c of bytes(stream)) collected.push(...stepwise.feed([c]));

    expect(collected).toEqual(expected);
    expect(collected).toEqual([bytes('hello'), bytes('world'), bytes('end'), bytes('last')]);
  });

  it('handles split exactly at every byte of an LF-terminated stream', () => {
    const stream = bytes('ab\ncd\n');
    for (let splitAt = 0; splitAt <= stream.length; splitAt++) {
      const asm = new RxLineAssembler();
      const out: number[][] = [];
      out.push(...asm.feed(stream.slice(0, splitAt)));
      out.push(...asm.feed(stream.slice(splitAt)));
      expect(out, `split at ${splitAt}`).toEqual([bytes('ab'), bytes('cd')]);
    }
  });

  it('handles split exactly at every byte of a CRLF-terminated stream', () => {
    const stream = bytes('ab\r\ncd\r\n');
    for (let splitAt = 0; splitAt <= stream.length; splitAt++) {
      const asm = new RxLineAssembler();
      const out: number[][] = [];
      out.push(...asm.feed(stream.slice(0, splitAt)));
      out.push(...asm.feed(stream.slice(splitAt)));
      expect(out, `split at ${splitAt}`).toEqual([bytes('ab'), bytes('cd')]);
    }
  });

  it('does not mutate or alias the caller input array', () => {
    const asm = new RxLineAssembler();
    const input = bytes('ab\ncd\n');
    const snapshot = [...input];
    const [first, second] = asm.feed(input);
    expect(input).toEqual(snapshot);
    // 返回块是独立数组，互不影响
    first!.push(0x99);
    expect(second).toEqual(bytes('cd'));
  });
});

describe('RxLineAssembler — force flush', () => {
  it('force-flushes at a custom maxPendingBytes without a separator', () => {
    const asm = new RxLineAssembler({ maxPendingBytes: 4 });
    expect(asm.feed([1, 2, 3, 4])).toEqual([[1, 2, 3, 4]]);
    expect(asm.hasPending).toBe(false);
  });

  it('emits multiple force-flush chunks on a long separator-less stream', () => {
    const asm = new RxLineAssembler({ maxPendingBytes: 4 });
    // 注意避开 10 (0x0A=LF) / 13 (0x0D=CR)——它们是分隔符
    expect(asm.feed([1, 2, 3, 4, 5, 6, 7, 8, 9, 11])).toEqual([
      [1, 2, 3, 4], [5, 6, 7, 8],
    ]);
    expect(asm.takeTail()).toEqual([9, 11]);
  });

  it('continues scanning after a mid-feed force flush', () => {
    const asm = new RxLineAssembler({ maxPendingBytes: 4 });
    // 4 字节强制发射，随后 5|LF、6 7|CRLF 正常按行切
    const out = asm.feed([1, 2, 3, 4, 5, 0x0a, 6, 7, 0x0d, 0x0a]);
    expect(out).toEqual([[1, 2, 3, 4], [5], [6, 7]]);
    expect(asm.hasPending).toBe(false);
  });

  it('resumes normal line accumulation right after a force flush', () => {
    const asm = new RxLineAssembler({ maxPendingBytes: 3 });
    expect(asm.feed([1, 2, 3, 4, 0x0a])).toEqual([[1, 2, 3], [4]]);
  });

  it('uses the default 4096-byte threshold', () => {
    const asm = new RxLineAssembler();
    const bulk = Array.from({ length: 4096 }, () => 0x61);
    expect(asm.feed(bulk)).toEqual([Array.from({ length: 4096 }, () => 0x61)]);
    // 再多 1 字节不会触发第二次发射（未达阈值），留在 pending
    expect(asm.feed([0x62])).toEqual([]);
    expect(asm.takeTail()).toEqual([0x62]);
  });
});

describe('RxLineAssembler — takeTail / reset', () => {
  it('takeTail returns pending bytes', () => {
    const asm = new RxLineAssembler();
    asm.feed(bytes('partial'));
    expect(asm.takeTail()).toEqual(bytes('partial'));
    expect(asm.hasPending).toBe(false);
  });

  it('takeTail returns [] when nothing is pending', () => {
    const asm = new RxLineAssembler();
    asm.feed(bytes('done\n'));
    expect(asm.takeTail()).toEqual([]);
  });

  it('takeTail resets state so the next feed starts a fresh line', () => {
    const asm = new RxLineAssembler();
    asm.feed(bytes('old'));
    asm.takeTail();
    expect(asm.feed(bytes('new\n'))).toEqual([bytes('new')]);
  });

  it('takeTail clears pendingCR so a following LF becomes a real separator', () => {
    const asm = new RxLineAssembler();
    expect(asm.feed(bytes('a\r'))).toEqual([bytes('a')]);
    asm.takeTail(); // 清除 pendingCR
    // LF 不再是「CRLF 后半」，而是新行的分隔符 → 发射空行
    expect(asm.feed(bytes('\n'))).toEqual([[]]);
  });

  it('hasPending reflects the buffer state across feeds', () => {
    const asm = new RxLineAssembler();
    expect(asm.hasPending).toBe(false);
    asm.feed(bytes('x'));
    expect(asm.hasPending).toBe(true);
    asm.feed(bytes('\n'));
    expect(asm.hasPending).toBe(false);
  });

  it('reset discards pending bytes and the pendingCR flag', () => {
    const asm = new RxLineAssembler();
    asm.feed(bytes('junk\r'));
    asm.reset();
    expect(asm.hasPending).toBe(false);
    expect(asm.takeTail()).toEqual([]);
    // reset 后到来的 LF 是真正的分隔符（pendingCR 已清）
    expect(asm.feed(bytes('\nfirst\n'))).toEqual([[], bytes('first')]);
  });
});
