/**
 * TerminalViewportManager — per-port terminal instance hub (方案B, issue #14).
 *
 * Owns the storage + rendering state for ONE port's TRX terminal:
 * - `TerminalBuffer` (ring buffer) — the single source of line truth
 * - `TerminalRenderer` (direct DOM) — attached on TerminalView mount
 * - filter (direction + keyword) and search state, maintained INCREMENTALLY:
 *   new lines are matched once at append time, not by rescanning the buffer
 *   every frame (the old per-batch `filterLines` O(n) scan is gone)
 * - pause (frozenSeq), selection, scroll-lock/gesture pass-through
 * - rAF-coalesced render scheduling (scroll/resize/data all funnel here)
 *
 * The module-level registry keeps instances alive across tab switches (the
 * buffer is the memory; the DOM layer can detach/attach as containers move).
 * Each webview (main window / popout) has its own module scope → its own
 * registry, preserving the existing isolation semantics.
 *
 * Trim semantics: the ring buffer's fixed capacity IS the per-port memory
 * budget. `appendLines` returns whether anything was dropped; the RxPipeline
 * wiring layer owns the user-facing "buffer trimmed" toast.
 */
import type { DisplayFormat, Encoding, TerminalLine } from '../../types';
import { useAppStore } from '../../stores/useAppStore';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { linePassesFilter, type DirectionFilter } from '../lineFilter';
import { getSearchableText } from '../../components/MainDisplay/terminalSearch';
import { MAX_BYTE_DRAIN_PER_BATCH, TerminalBuffer } from './TerminalBuffer';
import {
  TerminalRenderer,
  type RendererConfig,
  type TerminalViewState,
} from './TerminalRenderer';

/** Compact the lazy filter/search offset after this many logical drops. */
const COMPACT_THRESHOLD = 4096;

/** Config-derived line + byte budgets (mirror the old issue #6-2 defaults). */
export function computeBufferLimits(): { maxLines: number; maxBytes: number } {
  const cfg = useAppStore.getState().config;
  const budgetMb = cfg.memoryPerPortBudgetMb ?? 200;
  return {
    maxLines: Math.max(1000, Math.floor(budgetMb * 500)),
    maxBytes: budgetMb * 1024 * 1024,
  };
}

interface SortedList {
  /** Ascending seqs. `offset` entries at the head were trimmed from the buffer. */
  seqs: number[];
  offset: number;
}

export class TerminalViewportManager {
  readonly buffer: TerminalBuffer;
  private readonly portId: string;
  private renderer: TerminalRenderer | null = null;
  private renderRaf: number | null = null;
  private destroyed = false;
  /** Render-pass listeners (React shells refresh readouts like matchCount). */
  private listeners = new Set<() => void>();

  // Filter state (null seqs = identity mode).
  private filterDirection: DirectionFilter = 'all';
  private filterKeyword = '';
  private filtered: SortedList = { seqs: [], offset: 0 };
  private filterActive = false;

  // Search state.
  private searchOpen = false;
  private searchQuery = '';
  private searchCaseSensitive = false;
  private matches: SortedList = { seqs: [], offset: 0 };
  private currentMatch = 0;

  // Display pass-through.
  private frozenSeq: number | null = null;
  private selectedRange: { start: number; end: number } | null = null;
  private locked = true;
  private gestureActive = false;

  constructor(portId: string, limits: { maxLines: number; maxBytes: number }) {
    this.portId = portId;
    this.buffer = new TerminalBuffer(limits);
  }

  /** Port's current encoding (read live from the store — lazy-decode aware). */
  private getEncoding(): Encoding {
    return useTerminalStore.getState().terminals[this.portId]?.encoding ?? 'UTF-8';
  }

  private getDisplayFormat(): DisplayFormat {
    return useTerminalStore.getState().terminals[this.portId]?.displayFormat ?? 'string';
  }

  // ==================== Data ingestion ====================

  /** Append lines (RX batches / TX echo / tool output / replay). Returns true
   *  when the buffer dropped oldest lines (memory-budget trim). */
  appendLines(lines: TerminalLine[]): boolean {
    if (this.destroyed) return false;
    let trimmed = false;
    const encoding = this.getEncoding();
    const displayFormat = this.getDisplayFormat();
    for (const line of lines) {
      const beforeFirst = this.buffer.firstSeq;
      // issue #10：字节预算 drain 限幅——一帧一批至多裁 MAX_BYTE_DRAIN_PER_BATCH
      // 行，剩余留待后续帧，避免单帧 firstSeq 前移数十万行引发视口抖动。
      const r = this.buffer.append(line, MAX_BYTE_DRAIN_PER_BATCH);
      if (r.trimmed) trimmed = true;
      // Incremental filter/search: match the new line once, extend the lists.
      if (this.filterActive) {
        if (linePassesFilter(line, this.filterDirection, this.filterKeyword, encoding)) {
          this.filtered.seqs.push(r.seq);
        }
      }
      if (this.searchOpen && this.searchQuery) {
        if (this.lineMatchesSearch(line, displayFormat, encoding)) {
          this.matches.seqs.push(r.seq);
        }
      }
      // The buffer may have dropped any number of oldest lines (capacity
      // overwrite or byte-budget drain) — drop each from the sorted lists.
      for (let s = beforeFirst; s < this.buffer.firstSeq; s++) {
        this.dropTrimmedSeq(s);
      }
    }
    this.requestRender();
    return trimmed;
  }

  appendLine(line: TerminalLine): void {
    this.appendLines([line]);
  }

  /** Replace the whole buffer (popout snapshot). Recomputes filter/search. */
  replaceAll(lines: TerminalLine[]): void {
    this.buffer.replaceAll(lines);
    this.recomputeFilter();
    this.recomputeSearch();
    this.renderer?.invalidate();
    this.requestRender();
  }

  /** Ctrl+L / mode-switch clear. */
  clear(): void {
    this.buffer.clear();
    this.frozenSeq = null;
    this.selectedRange = null;
    this.filtered = { seqs: [], offset: 0 };
    this.matches = { seqs: [], offset: 0 };
    this.currentMatch = 0;
    this.renderer?.clear();
  }

  /** Live buffer-limit change (config edited while streaming). */
  applyLimits(limits: { maxLines: number; maxBytes: number }): void {
    this.buffer.setLimits(limits);
    this.pruneTrimmed();
    this.requestRender();
  }

  /**
   * 软兜底裁剪（issue #14）：应用级 JS 堆超 memoryLimitMb 时，由模块级
   * `evaluateSoftBackstop` 对每个候选端口调用——drop 缓冲到半，同步裁掉
   * 过滤/搜索列表中已不可达的 seq，并重渲染。调用方负责双闸（候选判定 +
   * 冷却）与 toast。返回是否实际裁剪。
   */
  softTrim(): boolean {
    if (this.destroyed) return false;
    const trimmed = this.buffer.trimToHalf();
    if (trimmed) {
      this.pruneTrimmed();
      this.requestRender();
    }
    return trimmed;
  }

  // ==================== Filter ====================

  /** Set direction/keyword filter (debounced by the caller). */
  setFilter(direction: DirectionFilter, keyword: string): void {
    this.filterDirection = direction;
    this.filterKeyword = keyword;
    this.recomputeFilter();
    this.renderer?.bumpFilterVersion();
    this.requestRender();
  }

  /** Visible line count for the FilterBar readout (respects pause). */
  getVisibleCount(): number {
    const frozen =
      this.frozenSeq !== null ? Math.min(this.frozenSeq, this.buffer.lastSeq) : this.buffer.lastSeq;
    if (!this.filterActive) {
      return Math.max(0, frozen - this.buffer.firstSeq + 1);
    }
    let n = 0;
    for (let i = this.filtered.offset; i < this.filtered.seqs.length; i++) {
      if (this.filtered.seqs[i] > frozen) break;
      n++;
    }
    return n;
  }

  setPaused(paused: boolean): void {
    this.frozenSeq = paused ? this.buffer.lastSeq : null;
    this.requestRender();
  }

  // ==================== Search ====================

  setSearch(open: boolean, query: string, caseSensitive: boolean): void {
    this.searchOpen = open;
    this.searchQuery = query;
    this.searchCaseSensitive = caseSensitive;
    this.recomputeSearch();
    this.renderer?.bumpFilterVersion();
    this.requestRender();
  }

  getMatchCount(): number {
    return this.matches.seqs.length - this.matches.offset;
  }

  getCurrentMatchIndex(): number {
    return this.currentMatch;
  }

  /** Move to the next/prev match (wraps); scrolls it into view. */
  jumpToMatch(idx: number): boolean {
    const count = this.getMatchCount();
    if (count === 0) return false;
    this.currentMatch = ((idx % count) + count) % count;
    const targetSeq = this.matches.seqs[this.matches.offset + this.currentMatch];
    this.requestRender();
    this.scrollToSeq(targetSeq, 'center');
    return true;
  }

  // ==================== Selection / lock / gesture ====================

  setSelectedRange(range: { start: number; end: number } | null): void {
    this.selectedRange = range;
    this.requestRender();
  }

  /** Forward drag-selection guard to the renderer (freezes row DOM mid-drag
   *  so the native cross-row selection survives; release triggers a full
   *  redraw). */
  setSelecting(active: boolean): void {
    this.renderer?.setSelecting(active);
    if (!active) this.requestRender();
  }

  setLocked(locked: boolean): void {
    this.locked = locked;
    this.requestRender();
  }

  beginGesture(): void {
    this.gestureActive = true;
    this.requestRender();
  }

  endGesture(): void {
    this.gestureActive = false;
    this.requestRender();
  }

  // ==================== Scroll / config ====================

  scrollToSeq(seq: number, align: 'start' | 'center' | 'end'): void {
    if (this.renderer) this.renderer.scrollToSeq(seq, align, this.buffer, this.buildView());
  }

  scrollToBottom(): void {
    if (this.renderer && this.buffer.length > 0) {
      this.renderer.scrollToSeq(this.buffer.lastSeq, 'end', this.buffer, this.buildView());
    }
  }

  updateConfig(patch: Partial<RendererConfig>): void {
    this.renderer?.updateConfig(patch);
    this.requestRender();
  }

  // ==================== Renderer lifecycle ====================

  /** Attach (or re-attach) the renderer to a container; applies config. */
  attachRenderer(container: HTMLDivElement, config: RendererConfig): void {
    if (!this.renderer) {
      this.renderer = new TerminalRenderer(config);
    } else {
      this.renderer.updateConfig(config);
    }
    this.renderer.attachToContainer(container);
    this.renderer.onRenderNeeded = () => this.requestRender();
    this.requestRender();
  }

  detachRenderer(): void {
    this.renderer?.detach();
  }

  /** Tab close / mode switch: destroy the instance. */
  dispose(): void {
    this.destroyed = true;
    if (this.renderRaf !== null) cancelAnimationFrame(this.renderRaf);
    this.renderRaf = null;
    this.renderer?.dispose();
    this.renderer = null;
    this.listeners.clear();
  }

  // ==================== Internals ====================

  /** Subscribe to render passes (data/config/filter changes). Returns an
   *  unsubscribe fn. Used by React shells to refresh lightweight readouts
   *  (FilterBar match count, search index) without polling. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private requestRender(): void {
    if (this.renderRaf !== null || !this.renderer || this.destroyed) return;
    this.renderRaf = requestAnimationFrame(() => {
      this.renderRaf = null;
      this.renderer?.render(this.buffer, this.buildView());
      for (const fn of this.listeners) fn();
    });
  }

  private buildView(): TerminalViewState {
    const searchActive = this.searchOpen && this.searchQuery.length > 0;
    return {
      visibleSeqs: this.filterActive ? this.filtered.seqs : null,
      visibleSeqsOffset: this.filterActive ? this.filtered.offset : 0,
      frozenSeq: this.frozenSeq,
      matchSet: searchActive ? new Set(this.matches.seqs.slice(this.matches.offset)) : null,
      currentMatchSeq: searchActive ? this.matches.seqs[this.matches.offset + this.currentMatch] ?? -1 : -1,
      searchQuery: this.searchOpen ? this.searchQuery : '',
      searchCaseSensitive: this.searchCaseSensitive,
      selectedRange: this.selectedRange,
      locked: this.locked,
      gestureActive: this.gestureActive,
      followEnabled: this.locked && !this.searchOpen,
    };
  }

  private recomputeFilter(): void {
    const active = this.filterDirection !== 'all' || this.filterKeyword.trim().length > 0;
    this.filterActive = active;
    this.filtered = { seqs: [], offset: 0 };
    if (!active) return;
    const encoding = this.getEncoding();
    for (let seq = this.buffer.firstSeq; seq <= this.buffer.lastSeq; seq++) {
      const line = this.buffer.getBySeq(seq);
      if (line && linePassesFilter(line, this.filterDirection, this.filterKeyword, encoding)) {
        this.filtered.seqs.push(seq);
      }
    }
  }

  private recomputeSearch(): void {
    this.matches = { seqs: [], offset: 0 };
    this.currentMatch = 0;
    if (!this.searchOpen || !this.searchQuery) return;
    const encoding = this.getEncoding();
    const displayFormat = this.getDisplayFormat();
    for (let seq = this.buffer.firstSeq; seq <= this.buffer.lastSeq; seq++) {
      const line = this.buffer.getBySeq(seq);
      if (line && this.lineMatchesSearch(line, displayFormat, encoding)) {
        this.matches.seqs.push(seq);
      }
    }
  }

  /** Drop one trimmed seq from the sorted lists (O(1) offset bump). */
  private dropTrimmedSeq(seq: number): void {
    if (this.filterActive && this.filtered.seqs[this.filtered.offset] === seq) {
      this.filtered.offset++;
      this.compact(this.filtered);
    }
    if (this.matches.seqs.length > this.matches.offset && this.matches.seqs[this.matches.offset] === seq) {
      this.matches.offset++;
      this.compact(this.matches);
    }
  }

  /** Amortized compaction: splice when the offset grows past the threshold. */
  private compact(list: SortedList): void {
    if (list.offset >= COMPACT_THRESHOLD) {
      list.seqs.splice(0, list.offset);
      list.offset = 0;
    }
  }

  /** After setLimits trims, drop every list entry below the new firstSeq. */
  private pruneTrimmed(): void {
    const first = this.buffer.firstSeq;
    while (
      this.filtered.offset < this.filtered.seqs.length &&
      this.filtered.seqs[this.filtered.offset] < first
    ) {
      this.filtered.offset++;
    }
    while (
      this.matches.offset < this.matches.seqs.length &&
      this.matches.seqs[this.matches.offset] < first
    ) {
      this.matches.offset++;
    }
    this.compact(this.filtered);
    this.compact(this.matches);
  }

  private lineMatchesSearch(line: TerminalLine, displayFormat: DisplayFormat, encoding: Encoding): boolean {
    const text = getSearchableText(line, displayFormat, encoding);
    if (!text) return false;
    return this.searchCaseSensitive
      ? text.includes(this.searchQuery)
      : text.toLowerCase().includes(this.searchQuery.toLowerCase());
  }
}

// ==================== Module-level per-port registry ====================

const managers = new Map<string, TerminalViewportManager>();

/** Get (creating if needed) the manager for a port. Never throws. */
export function getViewportManager(portId: string): TerminalViewportManager {
  let vm = managers.get(portId);
  if (!vm) {
    vm = new TerminalViewportManager(portId, computeBufferLimits());
    managers.set(portId, vm);
  }
  return vm;
}

export function hasViewportManager(portId: string): boolean {
  return managers.has(portId);
}

/** Port ids with live managers (config-limit sync / tests). */
export function getManagerPortIds(): string[] {
  return Array.from(managers.keys());
}

/** Destroy the manager (tab close / TRX→TTY mode switch). */
export function releaseViewportManager(portId: string): void {
  const vm = managers.get(portId);
  if (vm) {
    vm.dispose();
    managers.delete(portId);
  }
  lastSoftTrimAt.delete(portId);
  lastSoftTrimHeap.delete(portId);
}

// ==================== App-level soft backstop (issue #14) ====================

/** 软兜底每端口冷却：RSS/JS 堆超限会持续满足，无冷却则每个 append 批都裁半，
 *  高频接收下用户视野里"刚加载的半页又被前半页顶掉"。与 toast 节流同量级。 */
const SOFT_TRIM_COOLDOWN_MS = 10_000;
const lastSoftTrimAt = new Map<string, number>();
/** 软兜底裁剪时的 JS 堆占用基线（issue #10）：冷却期满后若堆仍未回升到该基线
 *  以上（裁掉的内存还没被重新分配回来，或 GC 未回落），不再重复裁——否则
 *  10s 冷却期满、堆仍超限时形成固定节律的周期抖动（每次软裁都让视口跳一次）。 */
const lastSoftTrimHeap = new Map<string, number>();

/** 前端 V8 JS 堆占用（字节）。Chromium/WebView2 专属 `performance.memory` —
 *  量的是软件逻辑真实持有（缓冲/行对象/字符串），清屏/GC 后会回落，比进程
 *  RSS 更能反映"我们控的内存"。不存在时返回 0（降级为只有硬约束）。 */
function readJsHeapBytes(): number {
  const perf = performance as Performance & { memory?: { usedJSHeapSize?: number } };
  return perf.memory?.usedJSHeapSize ?? 0;
}

/**
 * 应用级软兜底评估（issue #14）：前端 JS 堆超过 `memoryLimitMb` 时，对每个
 * 「缓冲已可观（bytes > maxBytes/2）」且「冷却窗口外」的端口执行 `softTrim`
 * （裁半 + 同步过滤/搜索列表 + 重渲染）。返回被裁的 portId 列表——调用方
 * （RxPipeline 接线层）据此弹 toast。
 *
 * 双闸照搬旧设计（commit 9f6d56a，方案B重构时丢失、此处恢复）：
 *  1. 只裁 bytes > maxBytes/2 的端口——小缓冲不是超限元凶，裁它只会让用户
 *     看到"半页就被刷掉"。
 *  2. 每端口 10s 冷却——RSS/堆采样超限后持续满足，无冷却则每批裁半。
 *
 * 与每端口硬约束（TerminalBuffer.append 内 maxBytes/maxLines）互补：硬约束
 * 无条件立即裁、管单端口上限；软兜底有冷却、管应用级总上限。
 */
export function evaluateSoftBackstop(): string[] {
  const limitMb = useAppStore.getState().config.memoryLimitMb;
  if (limitMb <= 0) return [];
  const heapBytes = readJsHeapBytes();
  if (heapBytes <= 0 || heapBytes <= limitMb * 1024 * 1024) return [];

  const now = Date.now();
  const trimmed: string[] = [];
  for (const [portId, vm] of managers) {
    // 候选闸：只裁缓冲已可观的端口
    if (vm.buffer.bytes <= vm.buffer.maxBytes / 2) continue;
    // 冷却闸
    if (now - (lastSoftTrimAt.get(portId) ?? 0) < SOFT_TRIM_COOLDOWN_MS) continue;
    // 回升闸（issue #10）：上次裁剪时的堆占用作为本次评估基线——堆未回升到
    // 基线以上说明裁掉的内存还没被重新分配（或 GC 未回落），再裁只会制造
    // 周期抖动；只有堆真正重新涨上去才继续裁。
    const baseline = lastSoftTrimHeap.get(portId) ?? 0;
    if (baseline > 0 && heapBytes <= baseline) continue;
    if (vm.softTrim()) {
      lastSoftTrimAt.set(portId, now);
      lastSoftTrimHeap.set(portId, heapBytes);
      trimmed.push(portId);
    }
  }
  return trimmed;
}

// ==================== Adapter surface (non-React callers) ====================

/** Append lines to a port's buffer (RxPipeline appendLines target). */
export function appendTerminalLines(portId: string, lines: TerminalLine[]): boolean {
  // issue #11：标签页关闭（releaseViewportManager）后端口仍可能保持连接、RX
  // 数据继续到达——此时**不得复活** manager：关闭期间的数据会积压进新缓冲，
  // 重新打开标签页时被 replay，违反「重新开始新一轮输出」的语义。仅在标签页
  // 存在（manager 活着）时写入；无显示目标时静默丢弃（后端 RX 日志由
  // LogManager 独立落盘，不受影响）。
  const vm = managers.get(portId);
  if (!vm) return false;
  return vm.appendLines(lines);
}

/** Append one line (TX echo / tool output / log replay). */
export function appendTerminalLine(portId: string, line: TerminalLine): void {
  const vm = managers.get(portId);
  if (!vm) return;
  vm.appendLines([line]);
}

/** Snapshot up to `cap` of the newest lines (popout history replay). */
export function snapshotTerminalLines(portId: string, cap = Number.MAX_SAFE_INTEGER): TerminalLine[] {
  const vm = managers.get(portId);
  if (!vm) return [];
  const start = Math.max(vm.buffer.firstSeq, vm.buffer.lastSeq - cap + 1);
  return vm.buffer.snapshot(start);
}

/** Replace the whole buffer (popout snapshot receive / test reset). */
export function replaceTerminalLines(portId: string, lines: TerminalLine[]): void {
  const vm = managers.get(portId);
  if (!vm) return;
  vm.replaceAll(lines);
}

/** Clear a port's terminal (Ctrl+L / operation panel / mode switch). */
export function clearTerminal(portId: string): void {
  const vm = managers.get(portId);
  if (vm) vm.clear();
}
