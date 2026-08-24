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
import { TerminalBuffer } from './TerminalBuffer';
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
      const r = this.buffer.append(line);
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
