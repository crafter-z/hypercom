import { TerminalHeightIndex } from './TerminalHeightIndex';
import { mapScrollTop, TERMINAL_MAX_PHYSICAL_HEIGHT, type TerminalAlignment, type TerminalGeometryAnchor, type TerminalSource } from './TerminalSource';

/** Geometry only: row creation, order, selection pins and content remain owned
 * by TerminalRenderer. This optional object is never allocated in fixed mode.
 */
export interface WrapProjection {
  source: TerminalSource;
  seqs: number[] | null;
  first: number;
  count: number;
  seqAt: (key: number) => number | null;
  keyOf: (seq: number) => number | null;
}
export interface WrapRow { key: number; node: HTMLDivElement; dirty: boolean }
interface ReadingAnchor { seq: number; offset: number }
interface Seek { seq: number; align: TerminalAlignment; search: boolean; matchOffset?: number }

export class TerminalWrapLayout {
  private heights: TerminalHeightIndex;
  private projection: WrapProjection | null = null;
  private width = -1;
  private listHead: number | undefined;
  private dirty = true;
  private generation = 0;
  private measurements = new WeakMap<HTMLElement, { key: number; generation: number; height: number }>();
  private pending: Seek | null = null;
  private exactTop: { physical: number; logical: number } | null = null;
  private lastTop = 0;
  private padding = { top: 0, bottom: 0 };
  anchor: ReadingAnchor | null = null;

  constructor(height: number, anchorSeq: number | null) {
    this.heights = new TerminalHeightIndex(height);
    if (anchorSeq !== null) this.anchor = { seq: anchorSeq, offset: 0 };
  }
  invalidate(): void { this.dirty = true; }
  clear(): void {
    this.heights.clear(); this.projection = null; this.anchor = null;
    this.pending = null; this.exactTop = null; this.dirty = true;
  }
  detach(): void {
    this.heights.clear(); this.projection = null; this.exactTop = null;
    this.measurements = new WeakMap(); this.pending = null; this.dirty = true;
  }
  seek(seq: number, align: TerminalAlignment, search = false): void { this.pending = { seq, align, search }; }

  private total(p: WrapProjection): number { return this.heights.range(p.first, p.first + p.count); }
  private physicalHeight(p: WrapProjection): number { return Math.min(TERMINAL_MAX_PHYSICAL_HEIGHT, this.total(p)); }
  private map(top: number, p: WrapProjection, clientHeight: number, physical: boolean): number {
    const padding = this.padding.top + this.padding.bottom;
    const logical = this.total(p) + padding, bounded = this.physicalHeight(p) + padding;
    return mapScrollTop(top, physical ? logical : bounded, physical ? bounded : logical, 1, clientHeight);
  }
  private logicalTop(container: HTMLDivElement, p: WrapProjection): number {
    return this.exactTop?.physical === container.scrollTop ? this.exactTop.logical : this.map(container.scrollTop, p, container.clientHeight, false);
  }
  readAnchor(container: HTMLDivElement, align: TerminalAlignment = 'start'): TerminalGeometryAnchor | null {
    const p = this.projection;
    if (!p?.count || container.clientHeight <= 0) return null;
    const point = Math.max(0, this.logicalTop(container, p) - this.padding.top +
      (align === 'center' ? container.clientHeight / 2 : align === 'end' ? container.clientHeight - 1 : 0));
    const key = this.heights.keyAt(p.first, p.count, point), seq = p.seqAt(key);
    return seq === null ? null : { seq, visibleIndex: key - p.first, offsetPx: point - this.heights.range(p.first, key) };
  }

  /** At most three write/read batches, measuring only new/changed window rows.
   * No history walk, no per-row write/read interleaving, no ResizeObserver per
   * row. A rare unresolved window correction is continued on the next rAF.
   */
  render(
    container: HTMLDivElement, head: HTMLDivElement, tail: HTMLDivElement,
    p: WrapProjection, rowHeight: number, follow: boolean, gesture: boolean, selection: boolean,
    renderRows: (first: number, last: number) => WrapRow[],
    requestRender: () => void,
  ): void {
    // Hidden tabs retain anchors and caches; zero-width measurements must never
    // poison geometry. Container ResizeObserver schedules the reveal render.
    if (container.clientWidth <= 0 || container.clientHeight <= 0) return;
    const old = this.projection;
    const reset = this.dirty || this.width !== container.clientWidth || this.heights.estimate !== rowHeight ||
      old?.source !== p.source || old?.seqs !== p.seqs || this.listHead !== p.seqs?.[0];
    // Reflow can shrink the current flow rows before ResizeObserver/render runs.
    // The browser then clamps scrollTop against those NEW boxes, while our height
    // index still describes the OLD layout. Never invert that mixed geometry to
    // replace the saved reading anchor or infer a user request to jump to tail.
    // Explicit seeks and LIVE follow retain their normal precedence below.
    const scrolled = !!old && !reset && container.scrollTop !== this.lastTop;
    // A user reaching the physical scrollbar end requests the last record,
    // even before that tail's estimated heights have been measured. Preserve
    // this boundary during correction without enabling persistent LIVE/follow.
    const atTail = scrolled && !!old?.count && container.scrollTop > 0 &&
      container.scrollTop + container.clientHeight >= this.physicalHeight(old) + this.padding.top + this.padding.bottom - 1.5;
    const current = scrolled ? this.readAnchor(container) : null;
    const saved = current ? { seq: current.seq, offset: current.offsetPx } : this.anchor;
    const rangeChanged = old?.first !== p.first || old?.count !== p.count;
    let logical = old ? this.logicalTop(container, old) : container.scrollTop;
    if (reset) {
      this.heights = new TerminalHeightIndex(rowHeight);
      this.generation++;
      this.exactTop = null;
    }
    this.width = container.clientWidth;
    this.listHead = p.seqs?.[0];
    this.projection = p;
    this.dirty = false;
    this.heights.trimBefore(p.first);
    const cs = getComputedStyle(container);
    this.padding = { top: parseFloat(cs.paddingTop) || 0, bottom: parseFloat(cs.paddingBottom) || 0 };
    if (!p.count) {
      renderRows(0, -1); head.style.height = '0px'; tail.style.height = '0px';
      this.anchor = null; this.pending = null; this.exactTop = null;
      this.lastTop = container.scrollTop;
      return;
    }
    const seek = this.pending;
    const preserve = !seek && !follow && !gesture && !selection && saved && (reset || rangeChanged);
    let sticky = preserve ? saved : null;
    const clamp = (top: number) => Math.max(0, Math.min(top, Math.max(0, this.total(p) + this.padding.top + this.padding.bottom - container.clientHeight)));
    const desired = (): number => {
      if (follow || (atTail && !seek)) return clamp(Number.MAX_VALUE);
      const key = seek ? p.keyOf(seek.seq) : sticky ? p.keyOf(sticky.seq) : null;
      if (key !== null) {
        let top = this.padding.top + this.heights.range(p.first, key);
        if (seek) {
          if (seek.matchOffset !== undefined) top += seek.matchOffset - container.clientHeight / 2;
          else if (seek.align === 'center') top -= (container.clientHeight - this.heights.height(key)) / 2;
          else if (seek.align === 'end') top -= container.clientHeight - this.heights.height(key);
        } else top += Math.min(sticky!.offset, this.heights.height(key) - 1);
        return clamp(top);
      }
      // An evicted/filtered reading anchor falls back to the nearest boundary.
      return clamp(preserve ? 0 : logical);
    };
    const windowAt = (top: number): [number, number] => {
      const physical = this.map(top, p, container.clientHeight, true);
      const overscan = Math.min(rowHeight * 8, physical);
      return [
        this.heights.keyAt(p.first, p.count, Math.max(0, top - this.padding.top - overscan)),
        this.heights.keyAt(p.first, p.count, Math.max(0, top - this.padding.top + container.clientHeight + rowHeight * 8)),
      ];
    };
    let first = p.first, last = p.first, rows: WrapRow[] = [];
    let stable = false;
    for (let pass = 0; pass < 3; pass++) {
      logical = desired();
      [first, last] = windowAt(logical);
      // Preserve the point actually requested by a user scroll, not a numeric
      // scrollTop whose meaning changes when estimated heights become known.
      if (!seek && !follow && !sticky) {
        const key = this.heights.keyAt(p.first, p.count, Math.max(0, logical - this.padding.top));
        const seq = p.seqAt(key);
        if (seq !== null) sticky = { seq, offset: Math.max(0, logical - this.padding.top - this.heights.range(p.first, key)) };
      }
      rows = renderRows(first - p.first, last - p.first);
      // All DOM writes above, all row-height reads below. offsetHeight is in
      // layout CSS pixels (unlike transformed/zoomed client rectangles).
      const measured = rows.map(row => {
        const cached = this.measurements.get(row.node);
        const height = row.dirty || cached?.key !== row.key || cached.generation !== this.generation
          ? Math.max(rowHeight, row.node.offsetHeight) : cached.height;
        this.measurements.set(row.node, { key: row.key, generation: this.generation, height });
        return { key: row.key, height };
      });
      for (const row of measured) this.heights.set(row.key, row.height);
      if (seek?.search) {
        const target = rows.find(row => p.seqAt(row.key) === seek.seq)?.node;
        const mark = target?.querySelector<HTMLElement>('.terminal-search-mark');
        const rect = mark?.getClientRects()[0];
        if (target && rect) {
          const scale = container.getBoundingClientRect().height / container.offsetHeight || 1;
          seek.matchOffset = (rect.top - target.getBoundingClientRect().top + rect.height / 2) / scale;
        }
      }
      logical = desired();
      const next = windowAt(logical);
      stable = first === next[0] && last === next[1];
      if (stable) break;
    }
    const physical = this.map(logical, p, container.clientHeight, true);
    const before = this.heights.range(p.first, first);
    const headHeight = Math.max(0, physical + before - logical);
    head.style.height = `${headHeight}px`;
    tail.style.height = `${Math.max(0, this.physicalHeight(p) - headHeight - this.heights.range(first, last + 1))}px`;
    container.scrollTop = physical;
    this.exactTop = { physical: container.scrollTop, logical };
    this.lastTop = container.scrollTop;
    const anchor = this.readAnchor(container);
    this.anchor = anchor ? { seq: anchor.seq, offset: anchor.offsetPx } : null;
    this.pending = null;
    if (!stable) requestRender();
  }
}
