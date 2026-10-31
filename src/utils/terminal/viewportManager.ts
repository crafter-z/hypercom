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
 * Trim semantics (issue #16 redesign): the ring buffer is bounded by the
 * user-configured 最大显示行数 (`maxDisplayLines` → `maxLines`) alone.
 * Overflow evicts the oldest line — a plain rolling window. No byte budgets,
 * no app-level soft backstop, no memory trim toast.
 */
import type { DisplayFormat, Encoding, TerminalLine } from '../../types';
import { useAppStore } from '../../stores/useAppStore';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { linePassesFilter, type DirectionFilter } from '../lineFilter';
import { shouldFollow } from '../followLogic';
import { getSearchableText } from '../terminalSearch';
import { TerminalBuffer } from './TerminalBuffer';
import { TerminalTimeIndex } from './TerminalTimeIndex';
import { countVisibleSeqs, sourceTimeMs, upperBoundSeq, TERMINAL_REBUILD_SYNC_LIMIT, TERMINAL_REBUILD_CHUNK_SIZE, type TerminalSource, type TerminalViewportOptions, type TerminalTimelineAnchor, type TerminalTimelineResult, type TerminalTimelineRequest, type TerminalSeekOptions, type ScheduledSeekResult } from './TerminalSource';
import {
  TerminalRenderer,
  type RendererConfig,
  type TerminalViewState,
} from './TerminalRenderer';

/** Compact the lazy filter/search offset after this many logical drops. */
const COMPACT_THRESHOLD = 4096;

/** Config-derived line budget (issue #16 redesign: 最大显示行数, no byte budget). */
export function computeBufferLimits(): { maxLines: number } {
  const cfg = useAppStore.getState().config;
  const maxDisplayLines = cfg.maxDisplayLines ?? 100000;
  return { maxLines: Math.max(1000, Math.floor(maxDisplayLines)) };
}

interface SortedList {
  /** Ascending seqs. `offset` entries at the head were trimmed from the buffer. */
  seqs: number[];
  offset: number;
}

export class TerminalViewportManager {
  readonly buffer: TerminalSource;
  private readonly writableBuffer: TerminalBuffer | null;
  private readonly options: TerminalViewportOptions;
  private timeIndex = new TerminalTimeIndex();
  private timeIndexReady = true;
  private indexBuildVersion = 0;
  private indexBuildTimer: ReturnType<typeof setTimeout> | null = null;
  private indexWaiters = new Set<(ready: boolean) => void>();
  private filterLoading = false;
  private searchLoading = false;
  private filterBuildVersion = 0;
  private searchBuildVersion = 0;
  private cancelFilterScan: (() => void) | null = null;
  private cancelSearchScan: (() => void) | null = null;
  private sourceGenerationValue = 1;
  private sourceRevisionValue = 0;
  private timelineGrouped = false;
  private timelineLiveFollow = false;
  private readoutListeners = new Set<() => void>();
  private readoutsDirty = true;
  private pendingSeek: { seq: number; align: 'start' | 'center' | 'end'; followTail: boolean; options: TerminalSeekOptions; generation: number; resolve: (result: ScheduledSeekResult) => void; cleanup: () => void } | null = null;
  private heldTimelineRequest: TerminalTimelineRequest | null = null;
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
  /** Labels used by the current match lists, not a second display-state source. */
  private matchedEncoding: Encoding;
  private matchedDisplayFormat: DisplayFormat;

  constructor(portId: string, limits: { maxLines: number }, options: TerminalViewportOptions = {}) {
    this.portId = portId;
    this.options = options.display ? { ...options, display: { ...options.display } } : options;
    this.writableBuffer = options.source ? null : new TerminalBuffer(limits);
    this.buffer = options.source ?? this.writableBuffer!;
    this.matchedEncoding = this.getEncoding();
    this.matchedDisplayFormat = this.getDisplayFormat();
    this.rebuildTimeIndex();
  }

  get sourceGeneration(): number { return this.sourceGenerationValue; }
  get sourceRevision(): number { return this.sourceRevisionValue; }
  get readonlySource(): boolean { return this.writableBuffer === null; }
  get isLoading(): boolean { return this.filterLoading || this.searchLoading || !this.timeIndexReady; }

  /** Port's current encoding (read live from the store — lazy-decode aware). */
  private getEncoding(): Encoding {
    return this.options.display?.encoding ?? useTerminalStore.getState().terminals[this.portId]?.encoding ?? 'UTF-8';
  }

  private getDisplayFormat(): DisplayFormat {
    return this.options.display?.displayFormat ?? useTerminalStore.getState().terminals[this.portId]?.displayFormat ?? 'string';
  }

  // ==================== Data ingestion ====================

  /** Append lines (RX batches / TX echo / tool output / replay).
   *  Returns true when the oldest line was evicted (capacity rolling window). */
  appendLines(lines: TerminalLine[]): boolean {
    if (this.destroyed || !this.writableBuffer) return false;
    let trimmed = false;
    const encoding = this.getEncoding();
    const displayFormat = this.getDisplayFormat();
    for (const line of lines) {
      const beforeFirst = this.buffer.firstSeq;
      const r = this.writableBuffer.append(line);
      this.sourceRevisionValue++;
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
          this.matchSetCache?.add(r.seq);
        }
      }
      if ((this.frozenSeq === null || r.seq <= this.frozenSeq) &&
          (!this.filterActive || this.filtered.seqs[this.filtered.seqs.length - 1] === r.seq)) {
        this.timeIndex.add(r.seq, sourceTimeMs(this.buffer, r.seq));
      }
      // The buffer may have evicted any number of oldest lines — drop each
      // from the sorted lists.
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
    if (!this.writableBuffer || this.destroyed) return;
    this.invalidateSource();
    this.writableBuffer.replaceAll(lines);
    this.recomputeFilter();
    this.recomputeSearch();
    this.renderer?.invalidate();
    this.requestRender();
  }

  /** Ctrl+L / mode-switch clear. */
  clear(): void {
    if (!this.writableBuffer || this.destroyed) return;
    this.invalidateSource();
    const wasPaused = this.frozenSeq !== null;
    this.writableBuffer.clear();
    this.cancelScans();
    this.cancelIndexBuild();
    this.timeIndex.clear();
    // Keep the pause state aligned with the UI toggle: a paused view freezes
    // at the (now empty) tail instead of silently resuming follow.
    this.frozenSeq = wasPaused ? this.buffer.lastSeq : null;
    this.selectedRange = null;
    this.filtered = { seqs: [], offset: 0 };
    this.matches = { seqs: [], offset: 0 };
    this.currentMatch = 0;
    this.matchSetCache = null;
    this.renderer?.clear();
    this.requestRender();
  }

  /** Live buffer-limit change (config edited while streaming). */
  applyLimits(limits: { maxLines: number }): void {
    if (!this.writableBuffer || this.destroyed) return;
    const first = this.buffer.firstSeq;
    this.writableBuffer.setLimits(limits);
    for (let seq = first; seq < this.buffer.firstSeq; seq++) {
      this.timeIndex.delete(seq);
      this.matchSetCache?.delete(seq);
    }
    this.sourceRevisionValue++;
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
    return countVisibleSeqs(this.buffer, this.filterActive ? this.filtered.seqs : null, this.filtered.offset, this.frozenSeq);
  }

  setPaused(paused: boolean): void {
    this.frozenSeq = paused ? this.buffer.lastSeq : null;
    this.rebuildTimeIndex();
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
    return countVisibleSeqs(this.buffer, this.matches.seqs, this.matches.offset, this.frozenSeq);
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
    if (this.frozenSeq !== null && targetSeq > this.frozenSeq) return false;
    // Match navigation is an explicit seek, not a request to keep riding the tail.
    // The UI releases the store/group Pin before calling this method as well.
    this.locked = false;
    this.requestRender();
    this.scrollToSeq(targetSeq, 'center');
    return true;
  }

  // ==================== Selection / lock / gesture ====================

  setSelectedRange(range: { start: number; end: number } | null): void {
    this.selectedRange = range;
    this.requestRender();
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

  /** Scroll to the first row of the currently visible list (filter-aware). */
  scrollToTop(): void {
    if (!this.renderer || this.buffer.length === 0) return;
    const firstVisible = this.filterActive
      ? this.filtered.seqs[this.filtered.offset] ?? this.buffer.firstSeq
      : this.buffer.firstSeq;
    this.renderer.scrollToSeq(firstVisible, 'start', this.buffer, this.buildView());
  }

  updateConfig(patch: Partial<RendererConfig>): void {
    if (this.options.display) {
      if (patch.encoding !== undefined) this.options.display.encoding = patch.encoding as Encoding;
      if (patch.displayFormat !== undefined) this.options.display.displayFormat = patch.displayFormat;
    }
    const encoding = this.getEncoding();
    const displayFormat = this.getDisplayFormat();
    const encodingChanged = encoding !== this.matchedEncoding;
    const displayChanged = displayFormat !== this.matchedDisplayFormat;
    this.matchedEncoding = encoding;
    this.matchedDisplayFormat = displayFormat;
    if (encodingChanged) this.recomputeFilter();
    if (encodingChanged || displayChanged) {
      this.recomputeSearch();
      this.renderer?.bumpFilterVersion();
    }
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
    this.renderer.onRenderNeeded = () => this.requestRender(false);
    this.requestRender();
  }

  detachRenderer(): void {
    this.finishPendingSeek('unavailable');
    this.renderer?.detach();
  }

  /** Tab close / mode switch: destroy the instance. */
  dispose(): void {
    this.destroyed = true;
    this.cancelScans();
    this.invalidateSource();
    this.cancelIndexBuild();
    this.timeIndex.clear();
    this.readoutListeners.clear();
    if (this.renderRaf !== null) cancelAnimationFrame(this.renderRaf);
    this.renderRaf = null;
    this.renderer?.dispose();
    this.renderer = null;
    this.listeners.clear();
  }

  // ==================== Timeline / independent document ====================

  setTimelineGrouped(grouped: boolean): void {
    if (this.timelineGrouped === grouped) return;
    this.timelineGrouped = grouped;
    // Leaving a group must not silently reactivate independent tail-follow.
    if (!grouped) {
      this.locked = false;
      this.timelineLiveFollow = false;
    }
    this.requestRender(false);
  }

  /** The coordinator alone authorizes same-clock LIVE tail-follow; membership is not a lock. */
  setTimelineLiveFollow(enabled: boolean): void {
    const follow = this.timelineGrouped && enabled;
    if (this.timelineLiveFollow === follow) return;
    this.timelineLiveFollow = follow;
    this.requestRender(false);
  }

  readTimelineAnchor(align: 'start' | 'center' | 'end' = 'center'): TerminalTimelineAnchor | null {
    const anchor = this.renderer?.readGeometryAnchor(this.buffer, this.buildView(), align);
    return anchor ? { ...anchor, timeMs: sourceTimeMs(this.buffer, anchor.seq), recordKey: String(anchor.seq), sourceGeneration: this.sourceGeneration, sourceRevision: this.sourceRevision, clockEpoch: this.buffer.getClockEpoch?.(anchor.seq) } : null;
  }

  getTimelineAnchor(): TerminalTimelineAnchor | null { return this.readTimelineAnchor(); }

  lookupTime(timeMs: number): TerminalTimelineResult {
    if (!this.timeIndexReady) return { status: 'loading', actualTimeMs: null, sourceRevision: this.sourceRevision };
    const found = this.timeIndex.lookup(timeMs);
    if (!found) return { status: this.getVisibleCount() === 0 && this.buffer.length > 0 ? 'filtered' : 'no-time', actualTimeMs: null, sourceRevision: this.sourceRevision };
    return { status: found.status, seq: found.entry.seq, recordKey: String(found.entry.seq), actualTimeMs: found.entry.time, deltaMs: found.entry.time - timeMs, sourceRevision: this.sourceRevision };
  }

  async seekTimeline(request: TerminalTimelineRequest): Promise<TerminalTimelineResult> {
    if (this.destroyed || request.signal?.aborted || !(request.isCurrent?.() ?? true)) return { status: 'unsupported', actualTimeMs: null };
    if (!this.timeIndexReady && request.phase === 'commit') {
      const ready = await this.waitForTimeIndex(request.signal);
      if (!ready || request.signal?.aborted || !(request.isCurrent?.() ?? true)) return { status: 'unsupported', actualTimeMs: null };
    }
    const found = this.lookupTime(request.timeMs);
    if (found.seq === undefined) return found;
    if (this.selectedRange || this.renderer?.hasSelection) {
      this.heldTimelineRequest = request;
      return { status: 'held', actualTimeMs: this.readTimelineAnchor()?.timeMs ?? null };
    }
    this.heldTimelineRequest = null;
    if (this.timelineLiveFollow && this.frozenSeq !== null)
      return { status: 'held', actualTimeMs: this.readTimelineAnchor()?.timeMs ?? null };
    const followTail = this.timelineLiveFollow;
    const applied = await this.scheduleTimelineSeek(found.seq, followTail ? 'end' : 'center', request);
    if (applied.status === 'held') {
      this.heldTimelineRequest = request;
      return { status: 'held', actualTimeMs: null };
    }
    return applied.status === 'applied'
      ? {
        ...found,
        ...(followTail && applied.seq !== undefined ? {
          seq: applied.seq, recordKey: String(applied.seq),
          status: applied.timeMs == null ? 'no-time' as const : found.status,
          deltaMs: applied.timeMs == null ? undefined : applied.timeMs - request.timeMs,
        } : {}),
        actualTimeMs: applied.timeMs ?? null, sourceRevision: applied.sourceRevision,
      }
      : { status: 'unsupported', actualTimeMs: null };
  }

  scheduleTimelineSeek(seq: number, align: 'start' | 'center' | 'end' = 'center', options: TerminalSeekOptions = {}): Promise<ScheduledSeekResult> {
    this.finishPendingSeek('superseded');
    if (this.destroyed || !this.renderer?.geometryAvailable) return Promise.resolve({ status: 'unavailable', sourceRevision: this.sourceRevision });
    if (options.signal?.aborted || !(options.isCurrent?.() ?? true)) return Promise.resolve({ status: 'aborted', sourceRevision: this.sourceRevision });
    return new Promise(resolve => {
      const onAbort = () => { if (this.pendingSeek?.resolve === resolve) this.finishPendingSeek('aborted'); };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      this.pendingSeek = { seq, align, followTail: this.timelineLiveFollow && align === 'end', options, generation: this.sourceGeneration, resolve, cleanup: () => options.signal?.removeEventListener('abort', onAbort) };
      this.requestRender(false);
    });
  }

  /** A mutable external source explicitly publishes one new document version.
   * No copying or realtime ring limits are applied to the document. */
  refreshSource(): void {
    if (this.destroyed) return;
    this.invalidateSource();
    this.recomputeFilter();
    this.recomputeSearch();
    this.renderer?.invalidate();
    this.requestRender();
  }

  private finishPendingSeek(status: ScheduledSeekResult['status']): void {
    const pending = this.pendingSeek;
    if (!pending) return;
    this.pendingSeek = null;
    pending.cleanup();
    pending.resolve({ status, seq: pending.seq, timeMs: sourceTimeMs(this.buffer, pending.seq), sourceRevision: this.sourceRevision });
  }

  private invalidateSource(): void {
    this.sourceGenerationValue++;
    this.sourceRevisionValue++;
    this.heldTimelineRequest = null;
    this.finishPendingSeek('aborted');
  }

  private waitForTimeIndex(signal?: AbortSignal): Promise<boolean> {
    if (this.timeIndexReady) return Promise.resolve(true);
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise(resolve => {
      const finish = (ready: boolean) => {
        this.indexWaiters.delete(finish);
        signal?.removeEventListener('abort', abort);
        resolve(ready);
      };
      const abort = () => finish(false);
      this.indexWaiters.add(finish);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  private cancelIndexBuild(preserveWaiters = false): void {
    if (!preserveWaiters) for (const waiter of this.indexWaiters) waiter(false);
    this.indexBuildVersion++;
    if (this.indexBuildTimer !== null) clearTimeout(this.indexBuildTimer);
    this.indexBuildTimer = null;
    this.timeIndexReady = true;
  }

  private rebuildTimeIndex(preserveWaiters = false): void {
    this.cancelIndexBuild(preserveWaiters);
    this.timeIndex.clear();
    if (this.filterLoading) { this.timeIndexReady = false; return; }
    const version = this.indexBuildVersion;
    const list = this.filterActive ? this.filtered.seqs : null;
    let cursor = list ? this.filtered.offset : this.buffer.firstSeq;
    const end = list ? this.filtered.offset + this.getVisibleCount() : Math.min(this.buffer.lastSeq, this.frozenSeq ?? this.buffer.lastSeq) + 1;
    this.timeIndexReady = end - cursor <= TERMINAL_REBUILD_SYNC_LIMIT;
    const run = () => {
      this.indexBuildTimer = null;
      if (this.destroyed || version !== this.indexBuildVersion) return;
      const stop = this.timeIndexReady ? end : Math.min(end, cursor + TERMINAL_REBUILD_CHUNK_SIZE);
      for (; cursor < stop; cursor++) {
        const seq = list ? list[cursor] : cursor;
        if (seq >= this.buffer.firstSeq && seq <= this.buffer.lastSeq) this.timeIndex.add(seq, sourceTimeMs(this.buffer, seq));
      }
      if (cursor < end) this.indexBuildTimer = setTimeout(run, 0);
      else {
        this.timeIndexReady = true;
        for (const waiter of this.indexWaiters) waiter(true);
        this.compact(this.filtered);
        this.requestRender();
      }
    };
    if (this.timeIndexReady) run();
    else this.indexBuildTimer = setTimeout(run, 0);
  }

  // ==================== Internals ====================

  /** Subscribe to render passes (data/config/filter changes). Returns an
   *  unsubscribe fn. Used by React shells to refresh lightweight readouts
   *  (FilterBar match count, search index) without polling. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Readout-only subscription excludes geometry-only scroll/resize/seek. */
  subscribeReadouts(fn: () => void): () => void {
    this.readoutListeners.add(fn);
    return () => this.readoutListeners.delete(fn);
  }

  private requestRender(readouts = true): void {
    if (readouts) this.readoutsDirty = true;
    if (this.renderRaf !== null || !this.renderer?.attached || this.destroyed) return;
    this.renderRaf = requestAnimationFrame(() => {
      this.renderRaf = null;
      const renderer = this.renderer;
      if (!renderer?.attached || this.destroyed) return;
      let seekApplied = false;
      if (this.heldTimelineRequest && !renderer.hasSelection && !this.selectedRange) {
        const held = this.heldTimelineRequest;
        this.heldTimelineRequest = null;
        if (!held.signal?.aborted && (held.isCurrent?.() ?? true)) void this.seekTimeline(held);
      }
      const seek = this.pendingSeek;
      if (seek) {
        if (seek.options.signal?.aborted || !(seek.options.isCurrent?.() ?? true) || seek.generation !== this.sourceGeneration) {
          this.finishPendingSeek('aborted');
        } else if (renderer.hasSelection || this.selectedRange) {
          this.finishPendingSeek('held');
        } else if (seek.followTail) {
          if (!this.timelineLiveFollow) this.finishPendingSeek('aborted');
          else if (!this.buildView().followEnabled) this.finishPendingSeek('held');
          else {
            // Native follow computes the newest visible tail in this render,
            // including records appended after the timeline lookup was admitted.
            seekApplied = renderer.geometryAvailable && this.getVisibleCount() > 0;
            if (!seekApplied) this.finishPendingSeek('unavailable');
          }
        } else {
          seekApplied = renderer.positionToSeq(seek.seq, seek.align, this.buffer, this.buildView());
          if (!seekApplied) this.finishPendingSeek('unavailable');
        }
      }
      const view = this.buildView();
      if (seekApplied && !seek?.followTail) view.followEnabled = false;
      renderer.render(this.buffer, view);
      // ACK means the local render pass applied, not merely queue admission.
      if (seekApplied && seek && this.pendingSeek === seek) {
        if (seek.followTail) {
          const anchor = renderer.readGeometryAnchor(this.buffer, view, 'end');
          if (anchor) seek.seq = anchor.seq;
          else this.finishPendingSeek('unavailable');
        }
        if (this.pendingSeek === seek) this.finishPendingSeek('applied');
      }
      const notifyReadouts = this.readoutsDirty;
      this.readoutsDirty = false;
      for (const fn of this.listeners) fn();
      if (notifyReadouts) for (const fn of this.readoutListeners) fn();
    });
  }

  private buildView(): TerminalViewState {
    const searchActive = this.searchOpen && this.searchQuery.length > 0;
    const locked = this.timelineGrouped
      ? this.timelineLiveFollow && !this.selectedRange && !this.renderer?.hasSelection
      : this.locked;
    return {
      visibleSeqs: this.filterActive ? this.filtered.seqs : null,
      visibleSeqsOffset: this.filterActive ? this.filtered.offset : 0,
      frozenSeq: this.frozenSeq,
      matchSet: searchActive ? this.cachedMatchSet() : null,
      currentMatchSeq: searchActive ? this.matches.seqs[this.matches.offset + this.currentMatch] ?? -1 : -1,
      searchQuery: this.searchOpen ? this.searchQuery : '',
      searchCaseSensitive: this.searchCaseSensitive,
      selectedRange: this.selectedRange,
      locked,
      gestureActive: this.gestureActive,
      followEnabled: shouldFollow(
        this.frozenSeq !== null,
        locked,
        this.gestureActive,
      ),
    };
  }

  /** matchSet is read by every render pass (applyRowClasses + <mark> paint);
   *  rebuilding a potentially 50k-entry Set per frame is pure GC churn. The
   *  cache key is (offset, length, currentMatch) — matches mutate only via
   *  push (append), offset bump (trim) and recompute (new query). */
  private matchSetCache: Set<number> | null = null;
  private cachedMatchSet(): Set<number> {
    // Rebuilds fill this Set in the same bounded scan chunks; append/trim
    // mutate membership incrementally. Navigation/scroll never copy it.
    if (this.matchSetCache === null) this.matchSetCache = new Set(this.matches.seqs.slice(this.matches.offset));
    return this.matchSetCache;
  }

  /**
   * 过滤列表（以及紧随其后的搜索列表）的**条件变化**入口——唯一整缓冲重扫点。
   *
   * 增量语义：`appendLines` 里每条新行按当前条件匹配一次并入列，只有条件变化才
   * 走到这里；因此「继续输入时收窄扫描范围」这层优化不需要单独实现——查询/关键字
   * 一改就是全量重扫，而新行由 append 路径增量吸收，两者合起来覆盖了旧
   * findMatchesIncremental 的「旧匹配 ∪ 新增行」语义，且少一份需要与主实现保持
   * 同步的缓存状态。
   *
   * 裁剪回退：列表项存 **seq** 而非行下标，缓冲头部被裁只 `dropTrimmedSeq` 地
   * bump `offset`（O(1)），不重扫也不失效索引；`offset` 增长过 COMPACT_THRESHOLD
   * 才 splice 压缩一次（append 摊还 O(1)）——旧实现的「lineCount 回退即全量重扫」
   * 在这里是结构性不需要的。
   */
  private recomputeFilter(): void {
    this.cancelFilterScan?.(); this.cancelFilterScan = null;
    const version = ++this.filterBuildVersion;
    this.cancelIndexBuild();
    const active = this.filterDirection !== 'all' || this.filterKeyword.trim().length > 0;
    this.filterActive = active;
    this.filtered = { seqs: [], offset: 0 };
    this.filterLoading = active && this.buffer.length > TERMINAL_REBUILD_SYNC_LIMIT;
    if (!active) { this.rebuildTimeIndex(); return; }
    this.timeIndex.clear();
    this.timeIndexReady = !this.filterLoading;
    const encoding = this.getEncoding(), direction = this.filterDirection, keyword = this.filterKeyword;
    this.cancelFilterScan = this.scanSource(
      line => linePassesFilter(line, direction, keyword, encoding),
      (seqs, end) => {
        if (version !== this.filterBuildVersion || this.destroyed) return;
        // Appends newer than the captured tail have already matched exactly
        // once in appendLines. Merge, don't rescan or lose those live records.
        const appended = this.filtered.seqs.slice(upperBoundSeq(this.filtered.seqs, end, this.filtered.offset));
        const offset = upperBoundSeq(seqs, this.buffer.firstSeq - 1);
        this.filtered = { seqs: seqs.slice(offset).concat(appended), offset: 0 };
        this.filterLoading = false;
        this.cancelFilterScan = null;
        this.rebuildTimeIndex(true);
        this.renderer?.bumpFilterVersion();
        this.requestRender();
      },
    );
  }

  private recomputeSearch(): void {
    this.cancelSearchScan?.(); this.cancelSearchScan = null;
    const version = ++this.searchBuildVersion;
    this.matches = { seqs: [], offset: 0 };
    this.currentMatch = 0;
    const membership = new Set<number>();
    this.matchSetCache = membership;
    this.searchLoading = this.searchOpen && !!this.searchQuery && this.buffer.length > TERMINAL_REBUILD_SYNC_LIMIT;
    if (!this.searchOpen || !this.searchQuery) return;
    const encoding = this.getEncoding(), displayFormat = this.getDisplayFormat();
    this.cancelSearchScan = this.scanSource(
      (line, seq) => {
        const matched = this.lineMatchesSearch(line, displayFormat, encoding);
        if (matched) membership.add(seq);
        return matched;
      },
      (seqs, end) => {
        if (version !== this.searchBuildVersion || this.destroyed) return;
        const appended = this.matches.seqs.slice(upperBoundSeq(this.matches.seqs, end, this.matches.offset));
        const offset = upperBoundSeq(seqs, this.buffer.firstSeq - 1);
        this.matches = { seqs: seqs.slice(offset).concat(appended), offset: 0 };
        this.currentMatch = Math.min(this.currentMatch, Math.max(0, this.getMatchCount() - 1));
        this.searchLoading = false;
        this.cancelSearchScan = null;
        this.renderer?.bumpFilterVersion();
        this.requestRender();
      },
    );
  }

  /** Rebuild-only scanner. Each task captures its tail, yields between bounded
   * chunks, and never snapshots/decodes the full document in a preview. */
  private scanSource(predicate: (line: TerminalLine, seq: number) => boolean, complete: (seqs: number[], end: number) => void): () => void {
    const end = this.buffer.lastSeq;
    let cursor = this.buffer.firstSeq;
    const seqs: number[] = [];
    const sync = this.buffer.length <= TERMINAL_REBUILD_SYNC_LIMIT;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    const run = () => {
      timer = null;
      if (cancelled || this.destroyed) return;
      const stop = sync ? end + 1 : Math.min(end + 1, cursor + TERMINAL_REBUILD_CHUNK_SIZE);
      for (; cursor < stop; cursor++) {
        const line = this.buffer.getBySeq(cursor);
        if (line && predicate(line, cursor)) seqs.push(cursor);
      }
      if (cursor <= end) timer = setTimeout(run, 0);
      else complete(seqs, end);
    };
    if (sync) run(); else timer = setTimeout(run, 0);
    return () => { cancelled = true; if (timer !== null) clearTimeout(timer); };
  }

  private cancelScans(): void {
    this.filterBuildVersion++; this.searchBuildVersion++;
    this.cancelFilterScan?.(); this.cancelFilterScan = null;
    this.cancelSearchScan?.(); this.cancelSearchScan = null;
    this.filterLoading = false; this.searchLoading = false;
  }

  /** Drop one trimmed seq from the sorted lists (O(1) offset bump). */
  private dropTrimmedSeq(seq: number): void {
    this.timeIndex.delete(seq);
    this.matchSetCache?.delete(seq);
    if (this.filterActive && this.filtered.seqs[this.filtered.offset] === seq) {
      this.filtered.offset++;
      this.compact(this.filtered);
    }
    if (this.matches.seqs.length > this.matches.offset && this.matches.seqs[this.matches.offset] === seq) {
      this.currentMatch = Math.max(0, this.currentMatch - 1);
      this.matches.offset++;
      this.compact(this.matches);
      this.currentMatch = Math.min(this.currentMatch, Math.max(0, this.getMatchCount() - 1));
    }
  }

  /** Amortized compaction: splice when the offset grows past the threshold. */
  private compact(list: SortedList): void {
    // A chunked index build holds this array by reference, never a full copy.
    if (list === this.filtered && !this.timeIndexReady) return;
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
    const previousOffset = this.matches.offset;
    while (
      this.matches.offset < this.matches.seqs.length &&
      this.matches.seqs[this.matches.offset] < first
    ) {
      this.matches.offset++;
    }
    this.currentMatch = Math.min(
      Math.max(0, this.currentMatch - (this.matches.offset - previousOffset)),
      Math.max(0, this.getMatchCount() - 1),
    );
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

/** Port ids with live managers (config-limit sync / tests). */
export function getManagerPortIds(): string[] {
  return Array.from(managers.keys());
}

/** Query display ownership without creating a manager or allocating a key list. */
export function hasViewportManager(portId: string): boolean {
  return managers.has(portId);
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

/** Append lines to a port's buffer (RxPipeline appendLines target).
 *  Returns true when the oldest line was evicted (rolling window). */
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

/** Tauri's JSON event IPC turns nested Uint8Array into number[]; rebuild the
 *  typed arrays before a received snapshot enters the buffer (decode/render
 *  call TextDecoder.decode(rawData) / rawData.subarray, both of which throw on
 *  a plain array). */
export function normalizeReceivedTerminalLines(lines: TerminalLine[]): TerminalLine[] {
  return lines.map((line) => {
    if (!line.rawData || line.rawData instanceof Uint8Array) return line;
    return {
      ...line,
      rawData: Uint8Array.from(line.rawData as unknown as ArrayLike<number>),
    };
  });
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
