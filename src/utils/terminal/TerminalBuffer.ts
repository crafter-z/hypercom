/**
 * TerminalBuffer — ring buffer for the serial terminal line stream
 * (方案B storage layer, issue #14).
 *
 * Replaces the store's plain array + Immer produce + trimIfOverBudget:
 * - O(1) append: head pointer advances, no array shifting
 * - O(1) trim: overwrites the oldest slot once `maxLines` is reached; when
 *   the byte budget (`maxBytes`) is exceeded, drops oldest lines until the
 *   buffer holds at most half the budget (preserves the issue #6-2 "trim to
 *   50%" semantics as an amortized O(1) drain instead of one O(n) splice)
 * - Stable sequence numbers: `append` assigns monotonically increasing seqs;
 *   trimming only moves the [firstSeq, lastSeq] window — the seqs of
 *   surviving lines never change, so a renderer can skip redrawing rows it
 *   already drew (stable keys)
 * - Bounded memory: maxLines (hard line cap) + maxBytes (byte cap) make the
 *   upper bound deterministic with no O(n) recount
 *
 * Pure logic: no React/store/DOM dependencies, unit-testable under node.
 */
import type { TerminalLine } from '../../types';
import { lineBytes } from '../lineText';

export interface TerminalBufferOptions {
  /** Hard line capacity. Trimmed lines are overwritten from the head. */
  maxLines: number;
  /** Byte budget for the buffered payload. Exceeding it drops oldest lines
   *   until totalBytes ≤ maxBytes / 2 (50% trim semantics). 0 disables. */
  maxBytes: number;
}

/** Result of a single append. `trimmed` = any oldest line was dropped. */
export interface AppendResult {
  /** Monotonic sequence number assigned to the appended line. */
  seq: number;
  /** True when an existing line was dropped (capacity overwrite or byte trim). */
  trimmed: boolean;
}

export class TerminalBuffer {
  private slots: (TerminalLine | null)[];
  private head = 0;
  private count = 0;
  /** Next seq to assign. Monotonic across clear() — seqs never collide. */
  private nextSeq = 0;
  private totalBytes = 0;
  private maxLinesValue: number;
  private maxBytesValue: number;

  constructor(opts: TerminalBufferOptions) {
    this.maxLinesValue = Math.max(1, Math.floor(opts.maxLines));
    this.maxBytesValue = Math.max(0, opts.maxBytes);
    this.slots = new Array<TerminalLine | null>(this.maxLinesValue).fill(null);
  }

  /** Append one line; returns its assigned seq + whether a trim occurred. */
  append(line: TerminalLine): AppendResult {
    let trimmed = false;
    const seq = this.nextSeq++;
    const added = lineBytes(line);
    if (this.count < this.maxLinesValue) {
      const idx = (this.head + this.count) % this.maxLinesValue;
      this.slots[idx] = line;
      this.count++;
    } else {
      // Overwrite the oldest slot — account its bytes out.
      const old = this.slots[this.head];
      if (old) this.totalBytes -= lineBytes(old);
      this.slots[this.head] = line;
      this.head = (this.head + 1) % this.maxLinesValue;
      trimmed = true;
    }
    this.totalBytes += added;
    // Byte budget: drain oldest until ≤ half the budget.
    if (this.maxBytesValue > 0 && this.totalBytes > this.maxBytesValue) {
      while (this.count > 0 && this.totalBytes > this.maxBytesValue / 2) {
        this.dropHead();
        trimmed = true;
      }
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
    this.totalBytes = 0;
  }

  /** Replace the whole buffer (popout snapshot / replay reset). */
  replaceAll(lines: TerminalLine[]): void {
    this.clear();
    for (const line of lines) this.append(line);
  }

  /**
   * Adjust the limits live (config change). Shrinking maxLines drops the
   * oldest lines; the byte budget is then re-applied. Keeps the newest lines.
   *
   * issue #14：无论 count 是否超过 newMax，只要 maxLines 变化就重建 slots 数组
   * 到新尺寸——否则收缩时旧槽位（newMax..oldSize）残留对已不可达行的引用，
   * 既不归还内存又干扰后续 modulo 运算的语义清晰性。
   */
  setLimits(opts: Partial<TerminalBufferOptions>): void {
    if (opts.maxLines !== undefined) {
      const newMax = Math.max(1, Math.floor(opts.maxLines));
      if (newMax !== this.maxLinesValue) {
        // 用**当前**几何（旧 maxLinesValue 的 modulo）提取要保留的最新行。
        const keep = Math.min(this.count, newMax);
        const kept: TerminalLine[] = [];
        for (let i = this.count - keep; i < this.count; i++) {
          const line = this.getBySeq(this.firstSeq + i);
          if (line) kept.push(line);
        }
        this.totalBytes = 0;
        this.slots = new Array<TerminalLine | null>(newMax).fill(null);
        for (let i = 0; i < kept.length; i++) {
          this.slots[i] = kept[i];
          this.totalBytes += lineBytes(kept[i]);
        }
        this.head = 0;
        this.count = kept.length;
        this.maxLinesValue = newMax;
      }
    }
    if (opts.maxBytes !== undefined) {
      this.maxBytesValue = Math.max(0, opts.maxBytes);
    }
    // Re-apply the byte budget after any limit change.
    if (this.maxBytesValue > 0) {
      while (this.count > 0 && this.totalBytes > this.maxBytesValue / 2) {
        this.dropHead();
      }
    }
  }

  /**
   * 软兜底裁剪（issue #14）：drop 最旧行直到 count 减半。与硬约束的 byte-budget
   * drain 不同——这是应用级总内存超限时的主动收缩，由 viewportManager 接线层
   * 在 `performance.memory.usedJSHeapSize > memoryLimitMb` 时按端口触发（双闸：
   * 只裁 `bytes > maxBytes/2` 的端口 + 10s 冷却）。返回是否实际裁剪。
   */
  trimToHalf(): boolean {
    if (this.count <= 1) return false;
    const target = Math.max(1, Math.floor(this.count / 2));
    let trimmed = false;
    while (this.count > target) {
      this.dropHead();
      trimmed = true;
    }
    return trimmed;
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

  get bytes(): number {
    return this.totalBytes;
  }

  /** Hard line capacity (adjustable via setLimits). */
  get maxLines(): number {
    return this.maxLinesValue;
  }

  /** Byte budget (adjustable via setLimits). */
  get maxBytes(): number {
    return this.maxBytesValue;
  }

  private dropHead(): void {
    const old = this.slots[this.head];
    if (old) this.totalBytes -= lineBytes(old);
    this.slots[this.head] = null;
    this.head = (this.head + 1) % this.maxLinesValue;
    this.count--;
  }
}
