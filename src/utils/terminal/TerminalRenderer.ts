/**
 * TerminalRenderer — direct-DOM rendering engine for the TRX terminal
 * (方案B, issue #14).
 *
 * Replaces the React + @tanstack/react-virtual row pipeline with a
 * rAF-driven engine that owns the row DOM directly:
 * - O(visible rows) per frame: a pool of absolutely-positioned row divs is
 *   reused; only NEW lines get their content written (`innerHTML`), existing
 *   lines are only re-positioned (transform), never re-created
 * - Stable seq keys: rows are keyed by the buffer's absolute seq — head
 *   trimming never re-renders surviving rows (the old virtualizer re-keyed
 *   every visible row on each trim)
 * - Fixed row height: monospace font ⇒ rowHeight = fontSize × lineHeight;
 *   content height is `count × rowHeight`, zero DOM measurement
 * - Same-frame pin: when follow is engaged, `scrollTop` is set inside
 *   `render()` — the follow path is one rAF, not the old effect + double-rAF
 *   chain
 * - DOM order == visual order: newly acquired rows are inserted at their
 *   visIdx position (`insertRowInOrder`), NOT appended to the tail — a
 *   reversed DOM order makes cross-row drag selection skip rows (the browser
 *   walks the selection by DOM order)
 * - DOM structure mirrors the old TerminalRow output exactly (`.terminal-line`
 *   with `.terminal-timestamp` / `.terminal-direction` / `.terminal-content`
 *   spans), so the existing CSS needs no changes
 *
 * The renderer is presentation-only: the viewport manager owns the buffer,
 * filter/search state and render scheduling, and hands the renderer a
 * `TerminalViewState` describing which seqs to show.
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
import { markSearchMatchesInHtml } from '../../components/MainDisplay/terminalSearch';

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

const OVERSACAN_ROWS = 12;
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
  private contentLayer: HTMLDivElement | null = null;
  private readonly config: RendererConfig;
  private active = new Map<number, ActiveRow>();
  private pool: HTMLDivElement[] = [];
  /** Highest seq whose content has been written; higher seqs are dirty. */
  private lastRenderedSeq = -1;
  private fullRedraw = false;
  private filterVersion = 0;
  private onScrollHandler: (() => void) | null = null;
  private resizeObserver: ResizeObserver | null = null;
  /** Drag-selection in progress: render freezes structural DOM changes so the
   *  browser's native cross-row selection (anchored to live nodes) is not
   *  broken by recycle/rewrite. Restored via a full redraw on release. */
  private isSelecting = false;

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
    layer.style.position = 'relative';
    layer.style.width = '100%';
    layer.style.height = '0px';
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

  /** Detach from the container, keeping the node pool alive. */
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
  }

  /** Drop all DOM rows (clear). Pool is discarded — seqs are invalid. */
  clear(): void {
    this.active.clear();
    this.pool = [];
    this.lastRenderedSeq = -1;
    if (this.contentLayer) {
      this.contentLayer.innerHTML = '';
      this.contentLayer.style.height = '0px';
    }
    this.fullRedraw = true;
  }

  dispose(): void {
    this.detach();
    this.clear();
  }

  /** Mark every row dirty (config change / buffer replacement). */
  invalidate(): void {
    this.fullRedraw = true;
  }

  /** Invalidate cached visIdx positions (filter/search list changed). */
  bumpFilterVersion(): void {
    this.filterVersion++;
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

  /** Drag-selection guard: while active, render() keeps the row DOM
   *  structurally frozen (no recycle/acquire/innerHTML) so the browser's
   *  native cross-row selection stays anchored. Release schedules a full
   *  redraw that restores everything the freeze skipped. */
  setSelecting(active: boolean): void {
    if (this.isSelecting === active) return;
    this.isSelecting = active;
    if (!active) {
      this.fullRedraw = true;
      this.onRenderNeeded?.();
    }
  }

  getConfig(): Readonly<RendererConfig> {
    return this.config;
  }

  // ==================== Main render pass ====================

  /**
   * Render the visible window. Called by the manager on data/config/filter/
   * search changes (rAF-scheduled) and on scroll/resize (direct, coalesced).
   */
  render(buffer: TerminalBuffer, view: TerminalViewState): void {
    const layer = this.contentLayer;
    const container = this.container;
    if (!layer || !container) return;

    const rowHeight = this.config.rowHeight;
    const firstSeq = buffer.firstSeq;
    const lastSeq = buffer.lastSeq;
    if (buffer.length === 0 || lastSeq < firstSeq) {
      layer.style.height = '0px';
      this.recycleAll();
      this.lastRenderedSeq = lastSeq;
      return;
    }

    const frozen = view.frozenSeq !== null ? Math.min(view.frozenSeq, lastSeq) : lastSeq;
    const baseCount = this.computeVisibleCount(view, buffer, frozen);
    const totalHeight = baseCount * rowHeight;
    layer.style.height = `${totalHeight}px`;

    // Follow pin: when follow is engaged and no gesture is active, the
    // viewport rides the newest row — the pin target IS the scrollTop used
    // for the window computation, so rows are laid out for the pinned view.
    const follow = view.followEnabled && !view.gestureActive;
    const scrollTop = follow
      ? Math.max(0, totalHeight - container.clientHeight)
      : container.scrollTop;

    const firstVisIdx = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSACAN_ROWS);
    const lastVisIdx = Math.min(
      baseCount - 1,
      Math.ceil((scrollTop + container.clientHeight) / rowHeight) + OVERSACAN_ROWS,
    );

    //    Frozen during drag-selection: removing a node whose text is inside
    //    the live selection range breaks the native cross-row Range.
    const selecting = this.isSelecting;
    for (const [seq, row] of this.active) {
      const stale =
        row.version !== this.filterVersion ||
        row.visIdx < firstVisIdx ||
        row.visIdx > lastVisIdx;
      if (stale && !selecting) {
        this.recycle(row);
        this.active.delete(seq);
      }
    }

    // 2. Ensure + update visible rows.
    for (let visIdx = firstVisIdx; visIdx <= lastVisIdx; visIdx++) {
      const seq = this.visIdxToSeq(visIdx, view, buffer, frozen);
      if (seq === null) continue;
      const line = buffer.getBySeq(seq);
      if (!line) continue;

      let row = this.active.get(seq);
      if (!row) {
        // Frozen: keep the DOM untouched mid-drag — new rows appear after
        // release (full redraw). Creating/inserting nodes here would also be
        // safe for the selection, but the recycled node may be re-inserted at
        // a new position, shifting the Range endpoints.
        if (selecting) continue;
        row = this.acquireRow();
        this.active.set(seq, row);
        // DOM 顺序 = 视觉顺序：池复用/新建节点默认在 contentLayer 末尾，必须
        // 按 visIdx 归位——否则向上滚动补位时 DOM 顺序颠倒，跨行拖拽选择时
        // 浏览器按 DOM 顺序拼接选区，视觉中间的行被跳过（issue #14 回归）。
        this.insertRowInOrder(row.node, visIdx);
      }
      row.seq = seq;
      row.visIdx = visIdx;
      row.version = this.filterVersion;
      const node = row.node;
      node.style.transform = `translateY(${visIdx * rowHeight}px)`;
      node.dataset.seq = String(seq);

      // A row is dirty when it's new (seq beyond the last written one), the
      // node was recycled from another seq, or a full redraw is pending.
      // Content is frozen during drag-selection too: innerHTML replacement
      // rebuilds the text node the Range endpoint points at, silently
      // dropping the selected text from the highlight (the row appears
      // half-selected).
      if (
        !selecting &&
        (this.fullRedraw || seq > this.lastRenderedSeq || node.dataset.renderedSeq !== String(seq))
      ) {
        this.writeRowContent(node, line, seq, buffer, view);
        node.dataset.renderedSeq = String(seq);
      }
      this.applyRowClasses(node, seq, view);
    }
    this.fullRedraw = false;
    this.lastRenderedSeq = lastSeq;

    // 3. Follow pin — same frame, zero latency.
    if (follow) {
      container.scrollTop = Math.max(0, totalHeight - container.clientHeight);
    }
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
   *  comparison would coerce it to 0 and wrongly hide every seq). */
  private seqToVisIdx(
    seq: number,
    view: TerminalViewState,
    buffer: TerminalBuffer,
    frozen: number | null,
  ): number | null {
    const fz = frozen ?? Number.MAX_SAFE_INTEGER;
    if (seq > fz || seq < buffer.firstSeq || seq > buffer.lastSeq) return null;
    if (view.visibleSeqs === null) return seq - buffer.firstSeq;
    const idx = view.visibleSeqs.indexOf(seq);
    return idx >= view.visibleSeqsOffset ? idx - view.visibleSeqsOffset : null;
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
      // Pooled nodes were removed from the DOM on recycle — reset display so
      // the row becomes visible again. DOM insertion is deferred to
      // `insertRowInOrder` (the caller keeps DOM order == visual order).
      node.style.display = '';
    }
    return { node, seq: -1, visIdx: -1, version: -1 };
  }

  private createRowNode(): HTMLDivElement {
    const node = document.createElement('div');
    node.className = 'terminal-line';
    node.style.position = 'absolute';
    node.style.top = '0';
    node.style.left = '0';
    node.style.width = '100%';
    node.style.height = `${this.config.rowHeight}px`;
    return node;
  }

  /** Insert the node keeping contentLayer children sorted by visIdx (DOM
   *  order == visual order). No-op when already in place. */
  private insertRowInOrder(node: HTMLDivElement, visIdx: number): void {
    const layer = this.contentLayer;
    if (!layer) return;
    let target: HTMLDivElement | null = null;
    for (const row of this.active.values()) {
      if (row.node !== node && row.visIdx > visIdx) {
        target = row.node;
        break;
      }
    }
    if (target === null) {
      layer.appendChild(node);
    } else if (node.nextSibling !== target) {
      layer.insertBefore(node, target);
    }
  }

  private recycle(row: ActiveRow): void {
    const node = row.node;
    node.remove();
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
      html = renderProtocolLine(line);
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
    node.innerHTML = `${tsHtml}${dirHtml}<span class="terminal-content">${html}</span>`;
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
