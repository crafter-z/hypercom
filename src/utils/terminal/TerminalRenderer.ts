/**
 * TerminalRenderer — direct-DOM rendering engine for the TRX terminal
 * (方案B engine, issue #14; flow-layout + selection-pin redesign, issue #18).
 *
 * Layout — document flow + spacers:
 * - The content layer is `[headSpacer][rows…][tailSpacer]`. Rows are normal
 *   flow children (fixed rowHeight); spacers carry the off-screen space:
 *   head = firstVisIdx × rowHeight, tail = the space after the last window
 *   row. DOM order == visual order BY CONSTRUCTION — the old absolute/
 *   translateY lattice and its whole order-maintenance machinery
 *   (insertRowInOrder, per-frame sort repair, detached-reference defenses —
 *   issues #14/#15 class) are structurally gone.
 * - New rows insert relative to the permanent spacers or the first visible
 *   row with a larger visIdx (walk skips parked rows); no node is ever moved
 *   once placed, so insertBefore references are always live children.
 *
 * Selection — pin rule instead of freeze:
 * - A native cross-row selection Range is anchored to live row nodes.
 *   Chromium semantics (probed, issue #18): re-parenting an anchored node
 *   discards/clips the range; deleting a NON-endpoint row only clips it.
 *   Therefore selected rows are never re-parented — they "park" in place:
 *   - Row inside the window: normal flow row (its correct slot).
 *   - Row outside the window: `display:none` (zero flow impact, same parent,
 *     style-only transitions — re-entering the window just clears the style,
 *     no node move). Chromium keeps the Range and its text across
 *     display:none.
 * - Unpinned rows recycle/rewrite freely even mid-drag — no global freeze,
 *   no fullRedraw suppression, no setSelecting API.
 * - `document.selectionchange` (watcher installed while pins exist) clears
 *   dead selections → next render recycles parked rows. Head-trimmed pinned
 *   rows park with frozen content until the selection clears (self-limiting
 *   via MAX_PINNED_ROWS).
 *
 * Unchanged invariants:
 * - O(visible rows + parked) per frame; only new/dirty rows get content.
 * - Stable seq keys; stale detection via REAL-TIME seqToVisIdx (issue #10 —
 *   cached visIdx fields are never trusted).
 * - Large-trim reading-position anchor (headAdvance ≥ LARGE_TRIM_ROWS —
 *   reachable via setLimits shrink; issue #10).
 * - Fixed row height, zero measurement, padding-aware same-frame follow pin.
 * - DOM structure mirrors TerminalRow (`.terminal-line` with
 *   `.terminal-timestamp` / `.terminal-direction` / `.terminal-content`).
 *
 * DOM-dependent — tests run under jsdom (`@vitest-environment jsdom`).
 */
import type {
  DisplayFormat,
  Encoding,
  HighlightRuleSet,
  TerminalLine,
  TimestampFormat,
} from '../../types';
import { TerminalBuffer } from './TerminalBuffer';
import { getLineText } from '../lineText';
import { applyHighlightSets, escapeHtml } from '../highlightEngine';
import { renderProtocolLine } from '../protocolRenderer';
import { formatTerminalTimestampAdj, isSameRound } from '../timeFormat';
import { markSearchMatchesInHtml } from '../terminalSearch';

export interface RendererConfig {
  rowHeight: number;
  showTimestamp: boolean;
  displayFormat: DisplayFormat;
  encoding: Encoding | string;
  timestampFormat: TimestampFormat;
  timestampMode: 'perLine' | 'perRound';
  highlightRuleSets: HighlightRuleSet[];
  connectedAt: number | null;
}

/** One live selection range translated into the buffer's seq space
 *  (startSeq ≤ endSeq, inclusive — the whole span holds selected text). */
interface SelectionSeqSpan {
  startSeq: number;
  endSeq: number;
}

/** Per-render view description, built by the viewport manager. */
export interface TerminalViewState {
  /** Surviving seqs under the active filter; `null` = identity (contiguous
   *   [firstSeq..lastSeq] window, arithmetic rendering). */
  visibleSeqs: number[] | null;
  /** Number of leading `visibleSeqs` entries already trimmed from the buffer
   *   head (lazy-compaction offset — the manager splices only when the offset
   *   grows large, keeping append O(1) amortized). */
  visibleSeqsOffset: number;
  /** Pause cap: render only seqs ≤ frozenSeq (or all when null). */
  frozenSeq: number | null;
  /** Search hit seqs for the `<mark>` overlay; null when search closed. */
  matchSet: Set<number> | null;
  currentMatchSeq: number;
  /** Search query text ('' when closed) — needed to paint `<mark>`s. */
  searchQuery: string;
  searchCaseSensitive: boolean;
  /** Shift+click selection range (inclusive seqs); null when none. */
  selectedRange: { start: number; end: number } | null;
  /** Store's scrollLocked — reflected by the pin button. */
  locked: boolean;
  /** A user scroll gesture is in progress: suppress the follow pin. */
  gestureActive: boolean;
  /** Follow may pin the viewport (locked && !searchOpen, manager-computed). */
  followEnabled: boolean;
}

const OVERSCAN_ROWS = 12;
/** Head advance (in rows) between two renders that counts as a "large trim":
 *  normal capacity overwrite advances ≤ maxLinesPerTick (2000)/frame, while
 *  a setLimits shrink can move the head arbitrarily far — the anchor restores
 *  the reading position only for the latter (issue #10). */
const LARGE_TRIM_ROWS = 2_500;
/** Cap on pinned rows: a selection spanning more rows than this breaks its
 *  own pins (rows recycle) instead of pinning unbounded DOM. Chromium's
 *  wheel-during-drag extends the range, so this is reachable; 600 rows of
 *  continuously selected content is far beyond any plausible reading use. */
const MAX_PINNED_ROWS = 600;
/** Detached-node pool cap — bounds DOM churn during fast scrolls. */
const POOL_CAP = 64;

interface ActiveRow {
  node: HTMLDivElement;
  seq: number;
  /** Filtered-list position when the row was last positioned. */
  visIdx: number;
  /** filterVersion at position time — stale rows are recycled on mismatch. */
  version: number;
}

export class TerminalRenderer {
  private container: HTMLDivElement | null = null;
  private headSpacer: HTMLDivElement | null = null;
  private tailSpacer: HTMLDivElement | null = null;
  private contentLayer: HTMLDivElement | null = null;
  private readonly config: RendererConfig;
  private active = new Map<number, ActiveRow>();
  private pool: HTMLDivElement[] = [];
  /** firstSeq at the last completed render — a head advance between renders
   *  signals a trim (capacity overwrite / setLimits shrink). */
  private lastRenderedFirstSeq = -1;
  /** Seq at the top of the viewport at the last render (non-follow only) —
   *  restores the reading position across a large trim (issue #10). */
  private anchorSeq: number | null = null;
  private fullRedraw = false;
  private filterVersion = 0;
  private onScrollHandler: (() => void) | null = null;
  private resizeObserver: ResizeObserver | null = null;
  /** Live native selection → seq spans ("pins"). Pinned rows are never
   *  re-parented: they stay flow rows in-window, or park (display:none)
   *  outside it. See class doc. */
  private selectionSpans: SelectionSeqSpan[] | null = null;
  /** document.selectionchange watcher (installed on first pin). */
  private selectionWatcher: (() => void) | null = null;

  /** Set by the manager: (re)schedule a rAF render (coalesces scroll/resize). */
  onRenderNeeded: (() => void) | null = null;

  constructor(config: RendererConfig) {
    this.config = config;
  }

  // ==================== Lifecycle ====================

  /** Attach to (or re-attach onto) a scroll container. Idempotent per container. */
  attachToContainer(container: HTMLDivElement): void {
    if (this.container === container) return;
    this.detach();
    this.container = container;
    const layer = document.createElement('div');
    layer.className = 'terminal-content-layer';
    this.headSpacer = document.createElement('div');
    this.headSpacer.style.height = '0px';
    this.tailSpacer = document.createElement('div');
    this.tailSpacer.style.height = '0px';
    layer.appendChild(this.headSpacer);
    layer.appendChild(this.tailSpacer);
    container.appendChild(layer);
    this.contentLayer = layer;
    this.onScrollHandler = () => this.onRenderNeeded?.();
    container.addEventListener('scroll', this.onScrollHandler);
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.onRenderNeeded?.());
      this.resizeObserver.observe(container);
    }
    this.fullRedraw = true;
  }

  /** Detach from the container. Active rows + pool are dropped — a subsequent
   *  attach is a full rebuild (`attachToContainer` sets fullRedraw). */
  detach(): void {
    if (this.onScrollHandler && this.container) {
      this.container.removeEventListener('scroll', this.onScrollHandler);
      this.onScrollHandler = null;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.contentLayer) {
      this.contentLayer.remove();
      this.contentLayer = null;
    }
    this.container = null;
    this.headSpacer = null;
    this.tailSpacer = null;
    // Rows live inside the removed layer — dropping active is safe here
    // (the selection dies with the layer; parked rows are cleared too).
    this.active.clear();
    this.pool = [];
    this.lastRenderedFirstSeq = -1;
    this.anchorSeq = null;
    this.clearPins();
    this.fullRedraw = true;
  }

  /** Drop all DOM rows (clear). Pool is discarded — seqs are invalid. */
  clear(): void {
    this.active.clear();
    this.pool = [];
    this.lastRenderedFirstSeq = -1;
    this.anchorSeq = null;
    this.clearPins();
    const layer = this.contentLayer;
    if (layer && this.headSpacer && this.tailSpacer) {
      while (layer.firstChild) layer.removeChild(layer.firstChild);
      // Same spacer nodes go back — layer children stay [head, tail].
      layer.appendChild(this.headSpacer);
      layer.appendChild(this.tailSpacer);
      this.headSpacer.style.height = '0px';
      this.tailSpacer.style.height = '0px';
    }
    this.fullRedraw = true;
  }

  dispose(): void {
    this.detach();
  }

  /** Mark every row dirty (config change / buffer replacement). */
  invalidate(): void {
    this.fullRedraw = true;
  }

  /** Invalidate cached visIdx positions (filter/search list changed).
   *  A view change underneath a live selection invalidates it — pins are
   *  dropped (matches Chromium's own clipping semantics on structure change). */
  bumpFilterVersion(): void {
    this.filterVersion++;
    this.clearPins();
    this.fullRedraw = true;
  }

  /** Update the display config; every row is redrawn with the new settings. */
  updateConfig(patch: Partial<RendererConfig>): void {
    const rowHeightChanged =
      patch.rowHeight !== undefined && patch.rowHeight !== this.config.rowHeight;
    Object.assign(this.config, patch);
    if (rowHeightChanged) {
      for (const row of this.active.values()) {
        row.node.style.height = `${this.config.rowHeight}px`;
      }
    }
    this.fullRedraw = true;
  }

  getConfig(): Readonly<RendererConfig> {
    return this.config;
  }

  // ==================== Selection pins ====================

  /** Refresh the pin set from the browser's live selection. Rows intersected
   *  by any live range are protected (see class doc). Called at the top of
   *  every render pass. */
  private syncPins(): void {
    this.selectionSpans = this.captureSelectionSeqSpans();
    this.ensureWatcher();
    if (this.selectionSpans !== null) {
      let pinnedRows = 0;
      for (const span of this.selectionSpans) pinnedRows += span.endSeq - span.startSeq + 1;
      if (pinnedRows > MAX_PINNED_ROWS) this.clearPins();
    }
  }

  /** Drop all pins (and the watcher). Parked rows recycle on the next stale
   *  pass; the visual `.selected` path (shift+click) is pin-independent. */
  clearPins(): void {
    this.selectionSpans = null;
    if (this.selectionWatcher) {
      document.removeEventListener('selectionchange', this.selectionWatcher);
      this.selectionWatcher = null;
    }
  }

  /** Test/dev hook: number of active rows currently pinned. */
  pinnedCount(): number {
    if (this.selectionSpans === null) return 0;
    let n = 0;
    for (const seq of this.active.keys()) {
      if (this.seqInSelection(seq)) n++;
    }
    return n;
  }

  /** Install the document-level watcher once a pin exists: the moment the
   *  browser drops the selection (click elsewhere, Esc, programmatic clear),
   *  schedule a render so parked rows recycle on the next pass. */
  private ensureWatcher(): void {
    if (this.selectionWatcher || typeof document === 'undefined') return;
    this.selectionWatcher = () => {
      if (this.selectionSpans === null) return;
      if (this.hasLiveSelection()) return;
      this.clearPins();
      this.onRenderNeeded?.();
    };
    document.addEventListener('selectionchange', this.selectionWatcher);
  }

  private hasLiveSelection(): boolean {
    const sel = window.getSelection?.();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false;
    const layer = this.contentLayer;
    if (!layer) return false;
    for (let i = 0; i < sel.rangeCount; i++) {
      const r = sel.getRangeAt(i);
      if (r.collapsed) continue;
      if (layer.contains(r.startContainer) || layer.contains(r.endContainer)) return true;
    }
    return false;
  }

  /** Translate the live browser selection into pinned seq spans. Whole-layer
   *  selections (Select-All — endpoints on the container/layer) are excluded:
   *  they do not anchor on row nodes and would pin the entire DOM. */
  private captureSelectionSeqSpans(): SelectionSeqSpan[] | null {
    const sel = window.getSelection?.();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const container = this.container;
    const layer = this.contentLayer;
    if (!container || !layer) return null;
    const spans: SelectionSeqSpan[] = [];
    for (let i = 0; i < sel.rangeCount; i++) {
      const r = sel.getRangeAt(i);
      if (r.collapsed) continue;
      if (r.startContainer === container || r.endContainer === container) continue;
      if (r.startContainer === layer || r.endContainer === layer) continue;
      if (!layer.contains(r.startContainer) && !layer.contains(r.endContainer)) continue;
      const a = this.seqFromNode(r.startContainer);
      const b = this.seqFromNode(r.endContainer);
      if (a === null || b === null) continue;
      spans.push({ startSeq: Math.min(a, b), endSeq: Math.max(a, b) });
    }
    return spans.length > 0 ? spans : null;
  }

  /** Closest row seq for any node inside a row (or null outside rows). */
  private seqFromNode(node: Node): number | null {
    let el: Element | null = node instanceof Element ? node : node.parentElement;
    while (el && el !== this.contentLayer) {
      if (el.hasAttribute?.('data-seq')) {
        const n = Number(el.getAttribute('data-seq'));
        return Number.isFinite(n) ? n : null;
      }
      el = el.parentElement;
    }
    return null;
  }

  private seqInSelection(seq: number): boolean {
    if (this.selectionSpans === null) return false;
    for (const s of this.selectionSpans) {
      if (seq >= s.startSeq && seq <= s.endSeq) return true;
    }
    return false;
  }

  // ==================== Main render pass ====================

  /**
   * Render the visible window. Called by the manager on data/config/filter/
   * search changes (rAF-scheduled) and on scroll/resize (direct, coalesced).
   */
  render(buffer: TerminalBuffer, view: TerminalViewState): void {
    const layer = this.contentLayer;
    const container = this.container;
    const headSpacer = this.headSpacer;
    const tailSpacer = this.tailSpacer;
    if (!layer || !container || !headSpacer || !tailSpacer) return;

    // Refresh pin state from the live selection every pass (cheap; keeps
    // pins honest even if a selectionchange was coalesced away).
    if (this.hasLiveSelection()) this.syncPins();

    const rowHeight = this.config.rowHeight;
    const firstSeq = buffer.firstSeq;
    const lastSeq = buffer.lastSeq;
    if (buffer.length === 0 || lastSeq < firstSeq) {
      headSpacer.style.height = '0px';
      tailSpacer.style.height = '0px';
      this.recycleAll();
      this.anchorSeq = null;
      this.lastRenderedFirstSeq = firstSeq;
      return;
    }

    const frozen = view.frozenSeq !== null ? Math.min(view.frozenSeq, lastSeq) : lastSeq;
    const baseCount = this.computeVisibleCount(view, buffer, frozen);
    const totalHeight = baseCount * rowHeight;


    // Follow pin: when follow is engaged and no gesture is active, the
    // viewport rides the newest row — compute it before the window so rows
    // are laid out for the pinned view. (#10) A large head advance with a
    // non-follow viewport restores the reading position from the anchor seq
    // instead of letting the browser clamp it to the new content bottom.
    const follow = view.followEnabled && !view.gestureActive;
    const headAdvance = firstSeq - this.lastRenderedFirstSeq;
    const anchorRestored =
      headAdvance >= LARGE_TRIM_ROWS && !follow && !view.gestureActive && this.selectionSpans === null;
    if (anchorRestored) {
      const anchor = this.anchorSeq;
      // 过滤模式下 scrollTop 空间按 visIdx 索引（baseCount 是过滤后计数），
      // 不能用 identity 算式 (anchor - firstSeq)，须通过 seqToVisIdx 映射。
      if (anchor !== null && anchor >= firstSeq) {
        const visIdx = this.seqToVisIdx(anchor, view, buffer, frozen);
        container.scrollTop = visIdx !== null ? visIdx * rowHeight : 0;
      } else {
        container.scrollTop = 0;
      }
    }
    const scrollTop = follow
      ? Math.max(0, totalHeight - container.clientHeight)
      : container.scrollTop;

    const firstVisIdx = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN_ROWS);
    const lastVisIdx = Math.min(
      baseCount - 1,
      Math.ceil((scrollTop + container.clientHeight) / rowHeight) + OVERSCAN_ROWS,
    );

    // 2. Spacers carry the off-screen space; hidden parked rows contribute
    //    zero flow height, so the spacers alone define the geometry.
    headSpacer.style.height = `${firstVisIdx * rowHeight}px`;
    tailSpacer.style.height = `${Math.max(0, (baseCount - 1 - lastVisIdx) * rowHeight)}px`;

    // 3. Stale pass (window bounds are now final): rows outside the window
    //    or behind the filter version recycle — unless pinned, in which case
    //    they park (display:none, same parent).
    for (const [seq, row] of this.active) {
      const visIdx = this.seqToVisIdx(seq, view, buffer, frozen);
      const stale =
        visIdx === null ||
        row.version !== this.filterVersion ||
        visIdx < firstVisIdx ||
        visIdx > lastVisIdx;
      if (!stale) continue;
      if (this.seqInSelection(seq)) {
        row.node.style.display = 'none';
      } else {
        this.recycle(row);
        this.active.delete(seq);
      }
    }

    // 4. Materialize the window rows in flow order. New rows insert before
    //    the first visible row with a larger visIdx (or the tail spacer);
    //    parked rows re-entering the window just clear display:none — their
    //    parked flow slot IS their correct slot, no node move.
    for (let visIdx = firstVisIdx; visIdx <= lastVisIdx; visIdx++) {
      const seq = this.visIdxToSeq(visIdx, view, buffer, frozen);
      if (seq === null) continue;
      const line = buffer.getBySeq(seq);
      if (!line) continue;
      let row = this.active.get(seq);
      const isNew = !row;
      if (!row) {
        row = this.acquireRow();
        this.active.set(seq, row);
        row.node.style.height = `${this.config.rowHeight}px`;
        const anchor = this.findFlowAnchor(visIdx, view, buffer, frozen);
        layer.insertBefore(row.node, anchor);
      }
      row.seq = seq;
      row.visIdx = visIdx;
      row.version = this.filterVersion;
      row.node.style.display = '';
      row.node.dataset.seq = String(seq);
      // Pinned rows skip content rewrites while the selection lives: any
      // innerHTML replacement rebuilds the anchor text node and kills the
      // Range. Content refreshes on the pass after the selection clears.
      if (
        !this.seqInSelection(seq) &&
        (isNew || this.fullRedraw || row.node.dataset.renderedSeq !== String(seq))
      ) {
        this.writeRowContent(row.node, line, seq, buffer, view);
        row.node.dataset.renderedSeq = String(seq);
      }
      this.applyRowClasses(row.node, seq, view);
    }
    this.fullRedraw = false;

    // 5. Follow pin — same frame, zero latency. Account for the container's
    //    padding (8px top/bottom on .terminal-view) so the last row is fully
    //    visible. getComputedStyle is read only when following.
    if (follow) {
      const cs = getComputedStyle(container);
      const padTop = parseFloat(cs.paddingTop) || 0;
      const padBottom = parseFloat(cs.paddingBottom) || 0;
      container.scrollTop = Math.max(0, padTop + totalHeight + padBottom - container.clientHeight);
    }

    // Record the trim anchor for the next render: the seq at the top of the
    // viewport (non-follow only — follow re-pins every frame, no anchor
    // needed). headAdvance is measured against this on the next render.
    if (!follow && !view.gestureActive) {
      const topVisIdx = Math.min(
        Math.floor(container.scrollTop / rowHeight),
        Math.max(0, baseCount - 1),
      );
      this.anchorSeq = this.visIdxToSeq(topVisIdx, view, buffer, frozen);
    }
    this.lastRenderedFirstSeq = firstSeq;
  }

  /** First visible sibling that should come AFTER a row at `visIdx` — the
   *  insertBefore anchor that keeps flow order == visual order. Walks layer
   *  children (≈ window + parked rows). Parked (display:none) rows still
   *  hold their flow slot and MUST be considered as anchors; only rows
   *  whose seq no longer maps (seqToVisIdx null — head-trimmed out of the
   *  buffer) are legitimately skipped. */
  private findFlowAnchor(
    visIdx: number,
    view: TerminalViewState,
    buffer: TerminalBuffer,
    frozen: number,
  ): HTMLDivElement | null {
    const layer = this.contentLayer;
    const tail = this.tailSpacer;
    if (!layer || !tail) return null;
    let child = layer.firstElementChild;
    while (child && child !== tail) {
      if (
        child instanceof HTMLDivElement &&
        child.hasAttribute('data-seq')
      ) {
        const seq = Number(child.getAttribute('data-seq'));
        if (Number.isFinite(seq)) {
          const childVis = this.seqToVisIdx(seq, view, buffer, frozen);
          if (childVis !== null && childVis > visIdx) return child;
        }
      }
      child = child.nextElementSibling;
    }
    return tail;
  }

  /** Scroll so the given seq is visible at the requested alignment. */
  scrollToSeq(
    seq: number,
    align: 'start' | 'center' | 'end',
    buffer: TerminalBuffer,
    view: TerminalViewState,
  ): void {
    const container = this.container;
    const rowHeight = this.config.rowHeight;
    if (!container || !buffer.getBySeq(seq)) return;
    const visIdx = this.seqToVisIdx(seq, view, buffer, view.frozenSeq ?? null);
    if (visIdx === null) return;
    const targetTop = visIdx * rowHeight;
    const clientHeight = container.clientHeight;
    let scrollTop = targetTop;
    if (align === 'center') scrollTop = targetTop - (clientHeight - rowHeight) / 2;
    else if (align === 'end') scrollTop = targetTop - clientHeight + rowHeight;
    container.scrollTop = Math.max(0, scrollTop);
    // Materialize the rows at the target immediately.
    this.render(buffer, view);
  }

  // ==================== Geometry accessors (gesture settle) ====================

  getScrollTop(): number {
    return this.container?.scrollTop ?? 0;
  }

  getScrollHeight(): number {
    return this.container?.scrollHeight ?? 0;
  }

  getClientHeight(): number {
    return this.container?.clientHeight ?? 0;
  }

  /** Seq of the row under a DOM event target, or null. */
  static seqFromEventTarget(target: EventTarget | null): number | null {
    if (!(target instanceof Element)) return null;
    const el = target.closest('[data-seq]');
    const raw = el?.getAttribute('data-seq');
    if (raw === null || raw === undefined) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  // ==================== Internals ====================

  /** Number of rows to render: filtered survivor count or identity count. */
  private computeVisibleCount(
    view: TerminalViewState,
    buffer: TerminalBuffer,
    frozen: number,
  ): number {
    if (view.visibleSeqs !== null) {
      let n = 0;
      for (let i = view.visibleSeqsOffset; i < view.visibleSeqs.length; i++) {
        if (view.visibleSeqs[i] > frozen) break; // list is ascending
        n++;
      }
      return n;
    }
    return Math.max(0, frozen - buffer.firstSeq + 1);
  }

  /** Filtered/identity list position of a seq, or null if hidden.
   *  `frozen` null = no cap (normalized to MAX_SAFE_INTEGER — a raw null
   *  comparison would coerce it to 0 and wrongly hide every seq).
   *
   *  Filtered list is ascending — binary search instead of indexOf (called
   *  per active row every frame from the stale check). */
  private seqToVisIdx(
    seq: number,
    view: TerminalViewState,
    buffer: TerminalBuffer,
    frozen: number | null,
  ): number | null {
    const fz = frozen ?? Number.MAX_SAFE_INTEGER;
    if (seq > fz || seq < buffer.firstSeq || seq > buffer.lastSeq) return null;
    if (view.visibleSeqs === null) return seq - buffer.firstSeq;
    const list = view.visibleSeqs;
    let lo = view.visibleSeqsOffset;
    let hi = list.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid] === seq) return mid - view.visibleSeqsOffset;
      if (list[mid] < seq) lo = mid + 1;
      else hi = mid - 1;
    }
    return null;
  }

  /** Seq at a filtered/identity list position, or null. */
  private visIdxToSeq(
    visIdx: number,
    view: TerminalViewState,
    buffer: TerminalBuffer,
    frozen: number | null,
  ): number | null {
    const fz = frozen ?? Number.MAX_SAFE_INTEGER;
    if (view.visibleSeqs !== null) {
      const seq = view.visibleSeqs[view.visibleSeqsOffset + visIdx];
      if (seq === undefined || seq > fz) return null;
      return seq;
    }
    const seq = buffer.firstSeq + visIdx;
    return seq <= fz ? seq : null;
  }

  private acquireRow(): ActiveRow {
    let node = this.pool.pop();
    if (!node) {
      node = this.createRowNode();
    } else {
      node.style.display = '';
    }
    return { node, seq: -1, visIdx: -1, version: -1 };
  }

  private createRowNode(): HTMLDivElement {
    const node = document.createElement('div');
    node.className = 'terminal-line';
    return node;
  }

  private recycle(row: ActiveRow): void {
    const node = row.node;
    node.remove();
    node.style.display = '';
    delete node.dataset.renderedSeq;
    if (this.pool.length < POOL_CAP) this.pool.push(node);
  }

  private recycleAll(): void {
    for (const row of this.active.values()) this.recycle(row);
    this.active.clear();
  }

  private writeRowContent(
    node: HTMLDivElement,
    line: TerminalLine,
    seq: number,
    buffer: TerminalBuffer,
    view: TerminalViewState,
  ): void {
    const c = this.config;
    let html: string;
    if (line.parsedFields && line.parsedFields.length > 0) {
      html = renderProtocolLine(line, c.encoding);
    } else {
      const displayText =
        c.displayFormat === 'hex' && line.rawData
          ? Array.from(line.rawData, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')
          : getLineText(line, c.encoding);
      html = applyHighlightSets(displayText, c.highlightRuleSets);
    }

    if (view.matchSet?.has(seq) && view.searchQuery) {
      const isCurrent = seq === view.currentMatchSeq;
      html = markSearchMatchesInHtml(html, view.searchQuery, view.searchCaseSensitive, isCurrent);
    }

    const prevLine = seq > buffer.firstSeq ? buffer.getBySeq(seq - 1) : undefined;
    const isFirstInRound =
      c.timestampMode !== 'perRound' ||
      seq === buffer.firstSeq ||
      !prevLine ||
      !isSameRound(prevLine, line);
    const muted = c.timestampMode === 'perRound' && !isFirstInRound;

    const tsHtml =
      c.showTimestamp !== false
        ? `<span class="terminal-timestamp${muted ? ' terminal-timestamp-muted' : ''}">${
            muted
              ? '-'
              : escapeHtml(
                  formatTerminalTimestampAdj(line, prevLine ?? undefined, c.connectedAt, c.timestampFormat),
                )
          }</span>`
        : '';

    const dirColor = this.directionColor(line.direction, line.toolStream);
    const dirClass = line.direction === 'TOOL' ? ' terminal-direction-tool' : '';
    const dirHtml = `<span class="terminal-direction${dirClass}" style="color:${dirColor}">${line.direction}</span>`;
    // 行高固定（rowHeight）而内容 span 在 .terminal-content 的 white-space: pre
    // 下不被容器宽度换行——内嵌 \n 的第二视觉行被裁剪在固定行盒内（横向不裁：
    // span 宽度随内容撑开，超宽部分由 .terminal-view 的 overflow-x 横向滚动）。
    node.innerHTML = `${tsHtml}${dirHtml}<span class="terminal-content" style="max-height:${c.rowHeight}px;overflow:hidden">${html}</span>`;
  }

  private applyRowClasses(node: HTMLDivElement, seq: number, view: TerminalViewState): void {
    const classes = ['terminal-line'];
    if (view.selectedRange && seq >= view.selectedRange.start && seq <= view.selectedRange.end) {
      classes.push('selected');
    }
    if (view.matchSet?.has(seq)) {
      if (seq === view.currentMatchSeq) classes.push('current-match');
      else classes.push('search-hit-line');
    }
    node.className = classes.join(' ');
  }

  private directionColor(dir: string, stream?: string): string {
    if (dir === 'TX') return 'var(--terminal-tx-color)';
    if (dir === 'TOOL') {
      return stream === 'stderr'
        ? 'var(--terminal-tool-stderr-color, #f48771)'
        : 'var(--terminal-tool-color, #dcdcaa)';
    }
    return 'var(--terminal-rx-color)';
  }
}
