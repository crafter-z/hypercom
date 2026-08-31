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
/** Head advance (in rows) between two renders that counts as a "large trim":
 *  the byte-budget drain / soft-backstop trim drops ~half the buffer at once,
 *  while normal capacity overwrite advances ≤ maxLinesPerTick (2000)/frame —
 *  the anchor restores the reading position only for the former. */
const LARGE_TRIM_ROWS = 2_500;
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
  /** firstSeq at the last completed render — a head advance between renders
   *  signals a trim (capacity overwrite / byte-budget drain / soft backstop). */
  private lastRenderedFirstSeq = -1;
  /** Seq at the top of the viewport at the last render (non-follow only) —
   *  restores the reading position across a large trim (issue #10). */
  private anchorSeq: number | null = null;
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
    // issue #15：旧 active 行随旧 layer 一起从 DOM 移除（孤儿节点），但兄弟
    // 指针仍链在旧 layer 上。若保留 active，跨 Pane 位移（splitPane 嵌套分支）
    // 时新容器 attach 后的 render 会对已脱链的 reference 调 insertBefore →
    // DOMException（'node before which … is not a child of this node'）。清空
    // active 与池（含锚点状态），下一次 attach 全量重建。
    this.active.clear();
    this.pool = [];
    this.lastRenderedFirstSeq = -1;
    this.anchorSeq = null;
    this.fullRedraw = true;
  }

  /** Drop all DOM rows (clear). Pool is discarded — seqs are invalid. */
  clear(): void {
    this.active.clear();
    this.pool = [];
    this.lastRenderedFirstSeq = -1;
    this.anchorSeq = null;
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
   *  native cross-row selection stays anchored. Release schedules ONE
   *  render (NOT a full redraw) — already-rendered rows keep their text
   *  nodes (selection survives), while rows that arrived or were skipped
   *  during the freeze are picked up by the normal dirty check. */
  setSelecting(active: boolean): void {
    if (this.isSelecting === active) return;
    this.isSelecting = active;
    if (!active) {
      // Do NOT set fullRedraw here — a full redraw rewrites every row's
      // innerHTML, replacing the text nodes the browser's live selection
      // Range is anchored to. The selection would silently empty, making
      // all selection-based copy menu items read blank. Instead just
      // schedule one render: rows already written (renderedSeq === seq)
      // are skipped, new/skipped rows are picked up via the dirty check.
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
      this.anchorSeq = null;
      this.lastRenderedFirstSeq = firstSeq;
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
    // issue #10：大 drain（字节预算裁半 / 软兜底 softTrim）单帧前移 firstSeq
    // 数十万行 → 内容总高度骤降。follow 场景由下方同帧钉底一次到位处理（视口
    // 内容即最新行，与 trim 前一致）；非 follow（用户上滚读历史）时浏览器会把
    // 超界的 scrollTop 夹到新内容底——阅读位置瞬间丢失，随后逐帧回填产生
    // 「内容上移/滚动条跳动」的抖动观感。这里检测到大 trim 时按上一帧视口
    // 顶部的 seq 恢复锚点：锚点行仍存活则回到视口顶部，被裁则停在内容头部
    // （而不是被夹到底部）。gesture / 拖选期间不干预（用户正在主动操作）。
    const headAdvance = firstSeq - this.lastRenderedFirstSeq;
    const anchorRestored =
      headAdvance >= LARGE_TRIM_ROWS && !follow && !view.gestureActive && !this.isSelecting;
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

    const firstVisIdx = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSACAN_ROWS);
    const lastVisIdx = Math.min(
      baseCount - 1,
      Math.ceil((scrollTop + container.clientHeight) / rowHeight) + OVERSACAN_ROWS,
    );

    //    Frozen during drag-selection: removing a node whose text is inside
    //    the live selection range breaks the native cross-row Range.
    const selecting = this.isSelecting;
    // issue #17：release 后（selecting=false）的回收会 `recycle()` 滚出视口的
    // 行——若该行是浏览器活选区 Range 的锚定节点（拖选起点行），node.remove()
    // 会让 Chromium 清空/漂移选区，起点无法定位。有活选区时跳过被命中的行；
    // 用户点击别处清选区后下一帧自然回收（自限）。仅 !selecting 时需要检查
    // （selecting 期间本就不回收）。
    const liveRanges = selecting ? null : this.captureLiveSelectionRanges();
    for (const [seq, row] of this.active) {
      // issue #10：stale 判定用**实时**列表位置而非缓存的 visIdx 字段——head trim
      // （内存预算/容量裁剪）前进 firstSeq（及 filtered.offset）后，行的实际位置
      // 整体平移，缓存的 visIdx 停在旧窗口值 → 仅按字段判定 stale 永不触发 →
      // 每帧 append+trim 都新建窗口行、旧行残留 → active 无限增长、DOM 行数爆炸
      // （e2e 实测 6669 行 vs 正常 27）、每帧 O(n) 渲染 → 高频数据下帧率暴跌、
      // 输出区上下抖动（数据突发填满缓冲 → trim 风暴 → 抖动 → 突发结束恢复）。
      // 实时位置：identity 模式 O(1)，过滤模式二分 O(log n)；越界（被裁/冻结外）
      // 返回 null → 回收。
      const visIdx = this.seqToVisIdx(seq, view, buffer, frozen);
      const stale =
        visIdx === null ||
        row.version !== this.filterVersion ||
        visIdx < firstVisIdx ||
        visIdx > lastVisIdx;
      if (stale && !selecting && !this.rowInLiveSelection(row.node, liveRanges)) {
        this.recycle(row);
        this.active.delete(seq);
      }
    }

    // 1b. Ensure DOM order matches visIdx order for surviving rows. Past
    //     insertRowInOrder bugs may have left the DOM scrambled; fix it now
    //     so the browser's native cross-row selection walks the correct
    //     document order. Skipped during drag-selection (moving nodes would
    //     break the live Range).
    //     issue #14：用**实时** seqToVisIdx 排序，不信缓存的 row.visIdx——
    //     head trim 后缓存值过期（整体平移，相对顺序碰巧不变但非设计保证）。
    if (!selecting) {
      const sorted = Array.from(this.active.entries())
        .map(([seq, row]) => ({ node: row.node, visIdx: this.seqToVisIdx(seq, view, buffer, frozen) }))
        .filter((r): r is { node: HTMLDivElement; visIdx: number } => r.visIdx !== null)
        .sort((a, b) => a.visIdx - b.visIdx);
      let prev: HTMLDivElement | null = null;
      for (const { node } of sorted) {
        if (prev !== null && node.previousSibling !== prev) {
          // issue #15 防御：跨容器位移 / attach-detach 交错的窗口期，reference
          // 可能已脱链（旧 layer 移除后节点保留兄弟指针）——insertBefore 的
          // reference 必须是 layer 的子孙节点，否则抛 DOMException。脱链时降级
          // appendChild（视觉顺序由下一步物化循环的 insertRowInOrder 归位）。
          const ref = prev.nextSibling;
          if (ref !== null && layer.contains(ref)) {
            layer.insertBefore(node, ref);
          } else {
            layer.appendChild(node);
          }
        }
        prev = node;
      }
    }

    // 2. Ensure + update visible rows.
    for (let visIdx = firstVisIdx; visIdx <= lastVisIdx; visIdx++) {
      const seq = this.visIdxToSeq(visIdx, view, buffer, frozen);
      if (seq === null) continue;
      const line = buffer.getBySeq(seq);
      if (!line) continue;

      let row = this.active.get(seq);
      const isNew = !row;
      if (!row) {
        // issue #12：拖选冻结期间也物化**新**行——滚动（含拖选边缘的浏览器
        // auto-scroll）新进视口的行与冻结期间新到达的数据行必须出现在 DOM 里，
        // 否则露出区域一片黑且选不到。冻结只保护**已有**行（浏览器原生选区
        // Range 锚定的节点）不被回收/重写；新行不在任何活 Range 端点内，
        // acquire + 按 visIdx 归位 + 写内容都安全（池节点已从 DOM 移除，
        // 重插不会回移已有节点的 Range）。
        row = this.acquireRow();
        this.active.set(seq, row);
        // DOM 顺序 = 视觉顺序：池复用/新建节点默认在 contentLayer 末尾，必须
        // 按 visIdx 归位——否则向上滚动补位时 DOM 顺序颠倒，跨行拖拽选择时
        // 浏览器按 DOM 顺序拼接选区，视觉中间的行被跳过（issue #14 回归）。
        this.insertRowInOrder(row.node, visIdx, view, buffer, frozen);
      }
      row.seq = seq;
      row.visIdx = visIdx;
      row.version = this.filterVersion;
      const node = row.node;
      node.style.transform = `translateY(${visIdx * rowHeight}px)`;
      node.dataset.seq = String(seq);

      // A row is dirty when it's new (seq beyond the last written one), the
      // node was recycled from another seq, or a full redraw is pending.
      // Content is frozen during drag-selection **for existing rows only**:
      // innerHTML replacement rebuilds the text node the Range endpoint
      // points at, silently dropping the selected text from the highlight.
      // New rows (isNew) get their content written even mid-drag — they are
      // not part of any live Range yet (issue #12: scrolling during a drag
      // must show the newly exposed rows, not black space).
      if (
        isNew ||
        (!selecting &&
          (this.fullRedraw || node.dataset.renderedSeq !== String(seq)))
      ) {
        this.writeRowContent(node, line, seq, buffer, view);
        node.dataset.renderedSeq = String(seq);
      }
      this.applyRowClasses(node, seq, view);
    }
    // Don't clear fullRedraw during drag-selection: freezing it lets the
    // post-release dirty check distinguish "rows already rendered before the
    // freeze" (renderedSeq === seq → not dirty → text nodes survive) from
    // "rows that arrived or were skipped during the freeze" (renderedSeq
    // mismatch or not yet materialized → dirty → written). This preserves the
    // browser selection Range across the freeze-release cycle.
    if (!selecting) {
      this.fullRedraw = false;
    }

    // 3. Follow pin — same frame, zero latency. Account for the container's
    //    padding (8px top/bottom on .terminal-view) so the last row is fully
    //    visible. The old `totalHeight - clientHeight` left ~8px unscrolled,
    //    cutting off the bottom third of the last row. getComputedStyle is
    //    read only when following; jsdom has no layout (padding 0 → old formula).
    if (follow) {
      const cs = getComputedStyle(container);
      const padTop = parseFloat(cs.paddingTop) || 0;
      const padBottom = parseFloat(cs.paddingBottom) || 0;
      container.scrollTop = Math.max(0, padTop + totalHeight + padBottom - container.clientHeight);
    }

    // Record the trim anchor for the next render: the seq at the top of the
    // viewport (non-follow only — follow re-pins every frame, no anchor
    // needed). headAdvance is measured against this on the next render.
    if (!follow && !view.gestureActive && !this.isSelecting) {
      const topVisIdx = Math.min(
        Math.floor(container.scrollTop / rowHeight),
        Math.max(0, baseCount - 1),
      );
      this.anchorSeq = this.visIdxToSeq(topVisIdx, view, buffer, frozen);
    }
    this.lastRenderedFirstSeq = firstSeq;
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

  /** Snapshot the browser's live selection ranges (issue #17). Returns null
   *  when no selection or only a collapsed caret — a collapsed range has no
   *  anchor text to protect. Whole-container selections (Select All) are
   *  excluded: their endpoints sit on the container, not on row nodes, so
   *  protecting every row would pin the whole DOM. */
  private captureLiveSelectionRanges(): Range[] | null {
    const sel = window.getSelection?.();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const container = this.container;
    if (!container) return null;
    const ranges: Range[] = [];
    for (let i = 0; i < sel.rangeCount; i++) {
      const r = sel.getRangeAt(i);
      if (r.collapsed) continue;
      if (r.startContainer === container || r.endContainer === container) continue;
      // Only ranges anchored inside this renderer's content layer matter —
      // selections from other DOM areas (inputs, other panes) must not pin rows.
      const layer = this.contentLayer;
      if (layer && !layer.contains(r.startContainer) && !layer.contains(r.endContainer)) continue;
      ranges.push(r);
    }
    return ranges.length > 0 ? ranges : null;
  }

  /** Whether a row node is touched by any live selection range (issue #17).
   *  Row nodes are pinned while the browser selection references them —
   *  removing the anchor node empties/relocates the selection. */
  private rowInLiveSelection(node: HTMLDivElement, ranges: Range[] | null): boolean {
    if (!ranges) return false;
    for (const r of ranges) {
      try {
        if (r.intersectsNode(node)) return true;
      } catch {
        // A range may have been invalidated (node detached / selection reset)
        // between capture and use — treat as not intersecting.
      }
    }
    return false;
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
   *  order == visual order). No-op when already in place.
   *
   *  issue #14：用**实时** seqToVisIdx 计算候选行的位置，不信缓存的
   *  `row.visIdx`——head trim 后存活行的缓存 visIdx 停在旧窗口值（整体平移），
   *  虽然相对顺序碰巧不变，但用旧值属于"碰巧对"而非"设计上对"；一旦出现
   *  非均匀位置变化（过滤列表重算、setLimits 不均匀裁剪）就会乱序/堆叠。
   *  新行的 visIdx 由调用方传入（本帧刚算出），候选行用实时位置比较。 */
  private insertRowInOrder(
    node: HTMLDivElement,
    visIdx: number,
    view: TerminalViewState,
    buffer: TerminalBuffer,
    frozen: number,
  ): void {
    const layer = this.contentLayer;
    if (!layer) return;
    let target: HTMLDivElement | null = null;
    let targetVisIdx = Infinity;
    for (const [seq, row] of this.active) {
      if (row.node === node) continue;
      const rVisIdx = this.seqToVisIdx(seq, view, buffer, frozen);
      if (rVisIdx !== null && rVisIdx > visIdx && rVisIdx < targetVisIdx) {
        target = row.node;
        targetVisIdx = rVisIdx;
      }
    }
    if (target === null) {
      layer.appendChild(node);
    } else if (node.nextSibling !== target) {
      // issue #15 防御：target 可能已脱链（同排序循环的竞态窗口）——insertBefore
      // 的 reference 必须是 layer 的子孙节点，否则抛 DOMException；脱链时降级
      // appendChild（行仍在 layer 内、位置交给下一帧排序循环修正）。
      if (layer.contains(target)) {
        layer.insertBefore(node, target);
      } else {
        layer.appendChild(node);
      }
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
    // issue #9：行高固定（rowHeight）而内容 span 在 .terminal-content 的
    // white-space: pre 下不再被容器宽度换行——但 TX 多行输入等内嵌 \n 仍会画出
    // 第二视觉行并叠到下一行上，这里把内容裁剪在固定行盒内（横向不裁：span 宽度
    // 随内容撑开，超宽部分由 .terminal-view 的 overflow-x 横向滚动查看）。
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
