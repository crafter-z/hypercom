/**
 * TerminalBuffer — ring buffer for the serial terminal line stream
 * (方案B storage layer, issue #14).
 *
 * Replaces the store's plain array + Immer produce + trimIfOverBudget:
 * - O(1) append: head pointer advances, no array shifting
 * - Line-capacity eviction (issue #16 redesign): the terminal is bounded by
 *   `maxLines` (user-configurable 最大显示行数) alone. Once full, each new
 *   line overwrites the oldest — a plain rolling window, no byte budgets,
 *   no half-trims, no memory toasts.
 * - Stable sequence numbers: `append` assigns monotonically increasing seqs;
 *   trimming only moves the [firstSeq, lastSeq] window — the seqs of
 *   surviving lines never change, so a renderer can skip redrawing rows it
 *   already drew (stable keys)
 * - Bounded memory: maxLines makes the line-count upper bound deterministic;
 *   byte memory is bounded only per-line (not tracked here)
 *
 * Pure logic: no React/store/DOM dependencies, unit-testable under node.
 */
import type { TerminalLine } from '../../types';

export interface TerminalBufferOptions {
  /** Hard line capacity. Overflow evicts the oldest line (rolling window). */
  maxLines: number;
}

/** Result of a single append. `trimmed` = the oldest line was evicted. */
export interface AppendResult {
  /** Monotonic sequence number assigned to the appended line. */
  seq: number;
  /** True when an existing line was dropped (capacity eviction). */
  trimmed: boolean;
}

export class TerminalBuffer {
  private slots: (TerminalLine | null)[];
  private head = 0;
  private count = 0;
  /** Next seq to assign. Monotonic across clear() — seqs never collide. */
  private nextSeq = 0;
  private maxLinesValue: number;

  constructor(opts: TerminalBufferOptions) {
    this.maxLinesValue = Math.max(1, Math.floor(opts.maxLines));
    this.slots = new Array<TerminalLine | null>(this.maxLinesValue).fill(null);
  }

  /** Append one line; returns its assigned seq + whether the oldest was evicted. */
  append(line: TerminalLine): AppendResult {
    let trimmed = false;
    const seq = this.nextSeq++;
    if (this.count < this.maxLinesValue) {
      const idx = (this.head + this.count) % this.maxLinesValue;
      this.slots[idx] = line;
      this.count++;
    } else {
      // Rolling window: overwrite the oldest slot, advance the head.
      this.slots[this.head] = line;
      this.head = (this.head + 1) % this.maxLinesValue;
      trimmed = true;
    }
    return { seq, trimmed };
  }

  /** Line at an absolute seq, or null when outside the live window. */
  getBySeq(seq: number): TerminalLine | null {
    if (seq < this.firstSeq || seq > this.lastSeq) return null;
    const offset = seq - this.firstSeq;
    return this.slots[(this.head + offset) % this.maxLinesValue];
  }

  /**
   * Snapshot the live window as an array in stream order.
   * Ranges are clamped to [firstSeq, lastSeq]; defaults = whole window.
   * Allocates — only for copy/export/snapshot paths, never the hot path.
   */
  snapshot(fromSeq?: number, toSeq?: number): TerminalLine[] {
    const start = Math.max(fromSeq ?? this.firstSeq, this.firstSeq);
    const end = Math.min(toSeq ?? this.lastSeq, this.lastSeq);
    const result: TerminalLine[] = [];
    for (let seq = start; seq <= end; seq++) {
      const line = this.getBySeq(seq);
      if (line) result.push(line);
    }
    return result;
  }

  /** Drop all lines. nextSeq keeps increasing (no seq reuse). */
  clear(): void {
    this.slots.fill(null);
    this.head = 0;
    this.count = 0;
  }

  /** Replace the whole buffer (popout snapshot / replay reset). */
  replaceAll(lines: TerminalLine[]): void {
    this.clear();
    for (const line of lines) this.append(line);
  }

  /**
   * Adjust the limit live (config change). Shrinking maxLines drops the
   * oldest lines; keeps the newest lines.
   *
   * issue #14：无论 count 是否超过 newMax，只要 maxLines 变化就重建 slots 数组
   * 到新尺寸——否则收缩时旧槽位（newMax..oldSize）残留对已不可达行的引用，
   * 既不归还内存又干扰后续 modulo 运算的语义清晰性。
   */
  setLimits(opts: Partial<TerminalBufferOptions>): void {
    if (opts.maxLines === undefined) return;
    const newMax = Math.max(1, Math.floor(opts.maxLines));
    if (newMax === this.maxLinesValue) return;
    // 用**当前**几何（旧 maxLinesValue 的 modulo）提取要保留的最新行。
    const keep = Math.min(this.count, newMax);
    const kept: TerminalLine[] = [];
    for (let i = this.count - keep; i < this.count; i++) {
      const line = this.getBySeq(this.firstSeq + i);
      if (line) kept.push(line);
    }
    this.slots = new Array<TerminalLine | null>(newMax).fill(null);
    for (let i = 0; i < kept.length; i++) {
      this.slots[i] = kept[i];
    }
    this.head = 0;
    this.count = kept.length;
    this.maxLinesValue = newMax;
  }

  /** Oldest live seq (inclusive); equals nextSeq when empty. */
  get firstSeq(): number {
    return this.nextSeq - this.count;
  }

  /** Newest live seq (inclusive); nextSeq - 1 when non-empty. */
  get lastSeq(): number {
    return this.nextSeq - 1;
  }

  get length(): number {
    return this.count;
  }

  /** Hard line capacity (adjustable via setLimits). */
  get maxLines(): number {
    return this.maxLinesValue;
  }
}
