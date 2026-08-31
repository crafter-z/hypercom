// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import type { TerminalLine } from '../../types';
import { TerminalBuffer } from './TerminalBuffer';
import { TerminalRenderer, type RendererConfig, type TerminalViewState } from './TerminalRenderer';
import '../../styles/terminal-view.css';

const ROW_HEIGHT = 18;
const CLIENT_HEIGHT = 200;

const makeLine = (tag: string): TerminalLine => ({
  timestamp: 0,
  direction: 'RX',
  content: undefined,
  rawData: new TextEncoder().encode(tag),
  isHex: false,
});

const makeConfig = (overrides?: Partial<RendererConfig>): RendererConfig => ({
  rowHeight: ROW_HEIGHT,
  showTimestamp: true,
  displayFormat: 'string',
  encoding: 'UTF-8',
  timestampFormat: 'absolute',
  timestampMode: 'perLine',
  highlightRuleSets: [],
  connectedAt: null,
  ...overrides,
});

const identityView = (overrides?: Partial<TerminalViewState>): TerminalViewState => ({
  visibleSeqs: null,
  visibleSeqsOffset: 0,
  frozenSeq: null,
  matchSet: null,
  currentMatchSeq: -1,
  searchQuery: '',
  searchCaseSensitive: false,
  selectedRange: null,
  locked: true,
  gestureActive: false,
  followEnabled: true,
  ...overrides,
});

function mount(config?: RendererConfig) {
  const container = document.createElement('div');
  Object.defineProperty(container, 'clientHeight', { value: CLIENT_HEIGHT, configurable: true });
  document.body.appendChild(container);
  const renderer = new TerminalRenderer(config ?? makeConfig());
  renderer.attachToContainer(container);
  return { container, renderer };
}

const fill = (b: TerminalBuffer, tags: string[]) => {
  for (const t of tags) b.append(makeLine(t));
};

let buf: TerminalBuffer;
let container: HTMLDivElement;
let renderer: TerminalRenderer;

beforeEach(() => {
  buf = new TerminalBuffer({ maxLines: 10_000 });
  ({ container, renderer } = mount());
});

describe('TerminalRenderer lifecycle', () => {
  it('attach creates the content layer', () => {
    const layer = container.querySelector('.terminal-content-layer');
    expect(layer).not.toBeNull();
    expect(renderer.getConfig().rowHeight).toBe(ROW_HEIGHT);
  });

  it('detach removes the layer; re-attach to a new container works', () => {
    renderer.detach();
    expect(container.querySelector('.terminal-content-layer')).toBeNull();
    const container2 = document.createElement('div');
    Object.defineProperty(container2, 'clientHeight', { value: 200, configurable: true });
    renderer.attachToContainer(container2);
    expect(container2.querySelector('.terminal-content-layer')).not.toBeNull();
    expect(container.querySelector('.terminal-content-layer')).toBeNull();
  });

  it('re-attach after detach renders without throwing on orphaned rows (issue #15)', () => {
    // 复现 splitPane 跨 Pane 位移：底部渲染（follow）后 active 持有窗口行
    // （seqs 6..29）→ detach（旧容器）→ 不 render → 直接 attach 到新容器 →
    // 置顶 render。新窗口（visIdx 0..24）与旧 active 部分重叠：seqs 0..5 是
    // 新行，而 seqs 6..24 仍在 active（未达 stale 边界）——新行归位必须相对
    // 这些**已脱链**的旧行插。修复前 detach 不清 active，insertRowInOrder 对
    // 脱链 target 调 layer.insertBefore → DOMException（'node before which … is
    // not a child of this node'）。修复后 detach 清空 active，全量重建。
    fill(buf, Array.from({ length: 30 }, (_, i) => String(i)));
    // 底部窗口：rowHeight 18、client 200 → scrollTop = 340 → 窗口 visIdx 6..29
    renderer.render(buf, identityView({ followEnabled: true }));
    expect(container.scrollTop).toBe(340);
    expect(container.querySelector('[data-seq="6"]')).not.toBeNull();

    renderer.detach();
    const container2 = document.createElement('div');
    Object.defineProperty(container2, 'clientHeight', { value: CLIENT_HEIGHT, configurable: true });
    document.body.appendChild(container2);
    renderer.attachToContainer(container2);
    container2.scrollTop = 0;
    expect(() => renderer.render(buf, identityView({ followEnabled: false }))).not.toThrow();
    // 内容正确重建：头部行存在、行数有界。
    expect(container2.querySelector('[data-seq="0"]')).not.toBeNull();
    expect(container2.querySelectorAll('.terminal-line').length).toBeGreaterThan(0);
    expect(container2.querySelectorAll('.terminal-line').length).toBeLessThan(40);
  });

  it('clear empties the layer and resets height', () => {
    fill(buf, ['a', 'b', 'c']);
    renderer.render(buf, identityView());
    expect(container.querySelectorAll('.terminal-line').length).toBeGreaterThan(0);
    renderer.clear();
    expect(container.querySelectorAll('.terminal-line').length).toBe(0);
    expect((container.querySelector('.terminal-content-layer') as HTMLElement).style.height).toBe('0px');
  });
});

describe('TerminalRenderer identity rendering', () => {
  it('renders the pinned bottom window with correct transforms', () => {
    fill(buf, Array.from({ length: 100 }, (_, i) => String(i)));
    renderer.render(buf, identityView());
    const layer = container.querySelector('.terminal-content-layer') as HTMLElement;
    expect(layer.style.height).toBe('1800px'); // 100 × 18
    // locked + followEnabled → scrollTop = 1800 - 200 = 1600 → rows 76..99
    expect(container.scrollTop).toBe(1600);
    const rows = container.querySelectorAll('.terminal-line');
    expect(rows.length).toBe(24);
    const last = rows[rows.length - 1] as HTMLElement;
    expect(last.dataset.seq).toBe('99');
    expect(last.style.transform).toBe('translateY(1782px)');
  });

  it('keeps a fixed-height lattice for over-wide lines (issue #9)', () => {
    // An over-wide line must stay ONE fixed-height row: with CSS wrapping the
    // row painted a second visual line over the next row (fixed rowHeight +
    // pre-wrap). The lattice below is what makes overlap impossible.
    const long = 'X'.repeat(5000);
    fill(buf, ['a', long, 'b', 'c']);
    renderer.render(buf, identityView({ followEnabled: false }));
    const rows = Array.from(container.querySelectorAll('.terminal-line')) as HTMLElement[];
    expect(rows.length).toBe(4); // exactly one row per line — no wrapped rows
    const tops = rows.map((n) => {
      const m = n.style.transform.match(/translateY\(([-\d.]+)px\)/);
      return m ? Number(m[1]) : NaN;
    });
    for (let i = 1; i < tops.length; i++) {
      expect(tops[i] - tops[i - 1]).toBe(ROW_HEIGHT); // strict lattice — no overlap
    }
    for (const row of rows) {
      expect(row.style.height).toBe(`${ROW_HEIGHT}px`);
    }
    const layer = container.querySelector('.terminal-content-layer') as HTMLElement;
    expect(layer.style.height).toBe(`${4 * ROW_HEIGHT}px`);
    // Full text survives (selection/copy/search still see the whole line).
    expect(rows[1].querySelector('.terminal-content')?.textContent).toBe(long);
  });

  it('clips embedded newlines inside the fixed row box (issue #9)', () => {
    // Multi-line TX input embeds \n in a single line; it must not paint a
    // second visual line over the next row. The content span is clipped to
    // the fixed row box (horizontal overflow is scrolled by the container).
    buf.append({ timestamp: 0, direction: 'TX', content: 'line1\nline2', isHex: false });
    renderer.render(buf, identityView({ followEnabled: false }));
    const content = container.querySelector('[data-seq="0"] .terminal-content') as HTMLElement;
    expect(content.style.maxHeight).toBe(`${ROW_HEIGHT}px`);
    expect(content.style.overflow).toBe('hidden');
    expect(content.textContent).toBe('line1\nline2'); // data intact
  });

  it('does not pin when a gesture is active', () => {
    fill(buf, Array.from({ length: 100 }, (_, i) => String(i)));
    renderer.render(buf, identityView({ gestureActive: true }));
    expect(container.scrollTop).toBe(0);
  });

  it('does not pin when follow is disabled (search open)', () => {
    fill(buf, Array.from({ length: 100 }, (_, i) => String(i)));
    renderer.render(buf, identityView({ followEnabled: false }));
    expect(container.scrollTop).toBe(0);
  });
});

describe('TerminalRenderer dirty tracking', () => {
  it('keeps the same DOM node and content for rows that did not change', () => {
    fill(buf, Array.from({ length: 30 }, (_, i) => String(i)));
    renderer.render(buf, identityView({ followEnabled: false }));
    const before = container.querySelector('[data-seq="5"]') as HTMLElement;
    expect(before).not.toBeNull();
    const beforeHtml = before.innerHTML;

    // Append 10 more lines and re-render — the pinned window shifts; seq 5
    // may leave the window. To force it to stay, scroll to the top.
    fill(buf, Array.from({ length: 10 }, (_, i) => `n${i}`));
    container.scrollTop = 0;
    renderer.render(buf, identityView({ followEnabled: false }));
    const after = container.querySelector('[data-seq="5"]') as HTMLElement;
    expect(after).not.toBeNull();
    expect(after).toBe(before);
    expect(after.innerHTML).toBe(beforeHtml);
  });

  it('writes content only for new rows (existing rows untouched)', () => {
    fill(buf, Array.from({ length: 30 }, (_, i) => String(i)));
    renderer.render(buf, identityView({ followEnabled: false }));
    // Force every existing row into the window (scroll top), capture content.
    container.scrollTop = 0;
    renderer.render(buf, identityView({ followEnabled: false }));
    const htmlBySeq = new Map<string, string>();
    for (const node of container.querySelectorAll('.terminal-line')) {
      htmlBySeq.set((node as HTMLElement).dataset.seq!, (node as HTMLElement).innerHTML);
    }
    fill(buf, Array.from({ length: 5 }, (_, i) => `x${i}`));
    renderer.render(buf, identityView({ followEnabled: false }));
    for (const node of container.querySelectorAll('.terminal-line')) {
      const el = node as HTMLElement;
      if (htmlBySeq.has(el.dataset.seq!)) {
        expect(el.innerHTML).toBe(htmlBySeq.get(el.dataset.seq!));
      }
    }
  });

  it('head trim does not recreate surviving rows', () => {
    const small = new TerminalBuffer({ maxLines: 20 });
    fill(small, Array.from({ length: 20 }, (_, i) => String(i)));
    renderer.render(small, identityView({ followEnabled: false }));
    container.scrollTop = 0;
    renderer.render(small, identityView({ followEnabled: false }));
    const nodeSeq15 = container.querySelector('[data-seq="15"]') as HTMLElement;
    expect(nodeSeq15).not.toBeNull();

    // Append 5 more → head trims 5 → seq 15 still alive.
    fill(small, Array.from({ length: 5 }, (_, i) => `n${i}`));
    renderer.render(small, identityView({ followEnabled: false }));
    const nodeSeq15After = container.querySelector('[data-seq="15"]') as HTMLElement;
    expect(nodeSeq15After).not.toBeNull();
    expect(nodeSeq15After).toBe(nodeSeq15);
  });

  it('head trim recycles trimmed rows — no DOM leak (issue #10)', () => {
    // 高频数据填满缓冲后每帧 trim：被裁行（seq < firstSeq）的 visIdx 字段停在
    // 旧窗口值，仅按 visIdx 判定 stale 永不触发 → 旧行残留、每帧新建窗口行 →
    // DOM 行数无限增长（e2e 实测 6669 行 vs 正常 27）→ 每帧 O(n) 渲染 → 输出
    // 区抖动。seq 窗口边界检查必须回收被裁行。
    const small = new TerminalBuffer({ maxLines: 20 });
    fill(small, Array.from({ length: 20 }, (_, i) => String(i)));
    // 底部窗口（follow）渲染 20 行。
    renderer.render(small, identityView({ followEnabled: true }));
    const domCountBefore = container.querySelectorAll('.terminal-line').length;
    expect(domCountBefore).toBeLessThanOrEqual(20);

    // 持续 append 触发持续 head trim——每次 append 5 行、head 前进 5。
    for (let round = 0; round < 10; round++) {
      fill(small, Array.from({ length: 5 }, (_, i) => `r${round}-${i}`));
      renderer.render(small, identityView({ followEnabled: true }));
    }
    // DOM 行数必须保持有界（窗口 + overscan，远小于累计 append 的 70 行）。
    const domCountAfter = container.querySelectorAll('.terminal-line').length;
    expect(domCountAfter).toBeLessThanOrEqual(domCountBefore + 2);
    expect(domCountAfter).toBeLessThan(40);
    // 被裁的早期 seq 必须已从 DOM 移除。
    expect(container.querySelector('[data-seq="0"]')).toBeNull();
    // 最新行仍在。
    const lastSeq = small.lastSeq;
    expect(container.querySelector(`[data-seq="${lastSeq}"]`)).not.toBeNull();
  });
});

describe('TerminalRenderer filtered rendering', () => {
  it('renders only the surviving seqs, positioned by list index', () => {
    fill(buf, Array.from({ length: 10 }, (_, i) => String(i)));
    renderer.render(buf, identityView({ visibleSeqs: [0, 2, 4, 6], followEnabled: false }));
    const rows = container.querySelectorAll('.terminal-line');
    expect(rows.length).toBe(4);
    const seqs = Array.from(rows).map((n) => (n as HTMLElement).dataset.seq);
    expect(seqs).toEqual(['0', '2', '4', '6']);
    const transforms = Array.from(rows).map((n) => (n as HTMLElement).style.transform);
    expect(transforms).toEqual([
      'translateY(0px)',
      'translateY(18px)',
      'translateY(36px)',
      'translateY(54px)',
    ]);
  });

  it('caps the rendered window at frozenSeq when paused', () => {
    fill(buf, Array.from({ length: 10 }, (_, i) => String(i)));
    renderer.render(buf, identityView({ frozenSeq: 4, followEnabled: false }));
    const layer = container.querySelector('.terminal-content-layer') as HTMLElement;
    expect(layer.style.height).toBe('90px'); // 5 rows × 18
    const maxSeq = Math.max(...Array.from(container.querySelectorAll('.terminal-line')).map((n) => Number((n as HTMLElement).dataset.seq)));
    expect(maxSeq).toBeLessThanOrEqual(4);
  });
});

describe('TerminalRenderer search + selection', () => {
  it('paints <mark> on hit rows and current-match on the active one', () => {
    buf.append({ timestamp: 0, direction: 'RX', content: 'hello world', isHex: false });
    buf.append({ timestamp: 0, direction: 'RX', content: 'hello', isHex: false });
    buf.append({ timestamp: 0, direction: 'RX', content: 'world peace', isHex: false });
    renderer.render(buf, identityView({
      matchSet: new Set([0, 2]),
      currentMatchSeq: 2,
      searchQuery: 'world',
      followEnabled: false,
    }));
    const row0 = container.querySelector('[data-seq="0"]') as HTMLElement;
    expect(row0.querySelector('.terminal-search-mark')).not.toBeNull();
    expect(row0.className).toContain('search-hit-line');
    const row2 = container.querySelector('[data-seq="2"]') as HTMLElement;
    expect(row2.className).toContain('current-match');
    const row1 = container.querySelector('[data-seq="1"]') as HTMLElement;
    expect(row1.querySelector('.terminal-search-mark')).toBeNull();
  });

  it('renders hex display from rawData', () => {
    const { container: hexContainer, renderer: hexRenderer } = mount(makeConfig({ displayFormat: 'hex' }));
    buf.append({ timestamp: 0, direction: 'RX', rawData: new Uint8Array([0x41, 0x42]), isHex: false });
    hexRenderer.render(buf, identityView({ followEnabled: false }));
    const content = hexContainer.querySelector('[data-seq="0"] .terminal-content') as HTMLElement;
    expect(content.textContent).toBe('41 42');
  });
});

describe('TerminalRenderer scroll + recycling', () => {
  it('scrollToSeq centers the target row', () => {
    fill(buf, Array.from({ length: 100 }, (_, i) => String(i)));
    renderer.render(buf, identityView({ followEnabled: false }));
    renderer.scrollToSeq(50, 'center', buf, identityView({ followEnabled: false }));
    // center: targetTop = 50*18 = 900; scrollTop = 900 - (200-18)/2 = 809
    expect(container.scrollTop).toBe(809);
    const rows = container.querySelectorAll('.terminal-line');
    expect(Array.from(rows).some((n) => (n as HTMLElement).dataset.seq === '50')).toBe(true);
  });

  it('recycles nodes when the window scrolls (bounded DOM)', () => {
    fill(buf, Array.from({ length: 2000 }, (_, i) => String(i)));
    renderer.render(buf, identityView({ followEnabled: false }));
    const initialCount = container.querySelectorAll('.terminal-line').length;
    expect(initialCount).toBeLessThan(100);
    // Scroll in steps; DOM size stays bounded AND the target rows materialize.
    for (let top = 0; top < 2000 * ROW_HEIGHT; top += 500) {
      container.scrollTop = top;
      renderer.render(buf, identityView({ followEnabled: false }));
      expect(container.querySelectorAll('.terminal-line').length).toBeLessThan(100);
      // The row under the viewport center must be present in the DOM.
      const centerSeq = Math.floor((top + CLIENT_HEIGHT / 2) / ROW_HEIGHT);
      expect(container.querySelector(`[data-seq="${centerSeq}"]`)).not.toBeNull();
    }
  });

  it('freezes row nodes during drag-selection and restores on release', () => {
    fill(buf, Array.from({ length: 200 }, (_, i) => String(i)));
    container.scrollTop = 100 * ROW_HEIGHT;
    renderer.render(buf, identityView({ followEnabled: false }));
    const before = container.querySelector('[data-seq="100"]') as HTMLElement;
    expect(before).not.toBeNull();
    const beforeHtml = before.innerHTML;

    // Drag-selection in progress: data keeps flowing and the viewport moves
    // (auto-scroll at the selection edge), but render() must NOT recycle,
    // re-acquire or rewrite the rows the live Range anchors to.
    renderer.setSelecting(true);
    fill(buf, Array.from({ length: 400 }, (_, i) => String(200 + i))); // append 200..599
    container.scrollTop = 300 * ROW_HEIGHT; // window shifted far away
    renderer.render(buf, identityView({ followEnabled: false }));
    const during = container.querySelector('[data-seq="100"]') as HTMLElement;
    expect(during).toBe(before); // same live node — selection Range intact
    expect(during.innerHTML).toBe(beforeHtml); // content untouched mid-drag
    // Window moved: rows outside it were not materialized while frozen, but
    // the rows that exist keep their positions.
    expect(during.style.transform).toBe(`translateY(${100 * ROW_HEIGHT}px)`);

    // Release: NO fullRedraw — rows that were already rendered (renderedSeq
    // === seq, seq <= lastRenderedSeq) keep their text nodes so a browser
    // selection Range anchored on them survives. New/skipped rows are picked
    // up by the dirty check. This is what makes selection-based copy work.
    renderer.setSelecting(false);
    renderer.render(buf, identityView({ followEnabled: false }));
    // The row at seq=100 was in the active set during freeze and is now stale
    // (window moved far away) — it should be recycled.
    expect(container.querySelector('[data-seq="100"]')).toBeNull(); // recycled
    // New window rows materialize.
    const centerSeq = Math.floor((300 * ROW_HEIGHT + CLIENT_HEIGHT / 2) / ROW_HEIGHT);
    expect(container.querySelector(`[data-seq="${centerSeq}"]`)).not.toBeNull();
  });

  it('keeps rows the live selection anchors to after release (issue #17)', () => {
    fill(buf, Array.from({ length: 200 }, (_, i) => String(i)));
    container.scrollTop = 100 * ROW_HEIGHT;
    renderer.render(buf, identityView({ followEnabled: false }));
    const anchor = container.querySelector('[data-seq="100"]') as HTMLElement;
    expect(anchor).not.toBeNull();
    const anchorContent = anchor.querySelector('.terminal-content') as HTMLElement;

    // 浏览器原生选区：起点锚在 seq=100 行、终点在 seq=105 行。
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    const range = document.createRange();
    range.setStart(anchorContent.firstChild!, 0);
    const end = container.querySelector('[data-seq="105"] .terminal-content') as HTMLElement;
    range.setEnd(end.firstChild!, 1);
    sel.addRange(range);
    expect(sel.toString()).toBeTruthy();

    // 拖选 + 释放（release 后正常回收路径）——但窗口移到远处，seq=100 行
    // 已滚出视口。修复前：recycle() 移除 Range 锚定节点 → Chromium 清空选区
    // （issue #17）。修复后：被活选区命中的行保留，未命中的行回收。
    renderer.setSelecting(true);
    renderer.setSelecting(false); // 释放
    container.scrollTop = 300 * ROW_HEIGHT; // 窗口移走
    renderer.render(buf, identityView({ followEnabled: false }));

    // 选区命中的行保留（DOM 仍在），选区文本不丢
    const kept = container.querySelector('[data-seq="100"]') as HTMLElement;
    expect(kept).not.toBeNull();
    expect(kept).toBe(anchor);
    expect(sel.toString()).toBeTruthy();

    // 未命中的视口外行正常回收（如 seq=90）
    expect(container.querySelector('[data-seq="90"]')).toBeNull();

    // 用户点击别处清选区 → 下一帧正常回收（自限）
    sel.removeAllRanges();
    renderer.render(buf, identityView({ followEnabled: false }));
    expect(container.querySelector('[data-seq="100"]')).toBeNull();
  });


  it('does not rewrite rows materialized during the freeze on release (issue #17)', () => {
    fill(buf, Array.from({ length: 200 }, (_, i) => String(i)));
    container.scrollTop = 100 * ROW_HEIGHT;
    renderer.render(buf, identityView({ followEnabled: false }));

    // 冻结期内灌入新数据 + 滚动到新行区域：新行以 isNew 路径物化+写入
    // （renderedSeq 已设），窗口也覆盖新行——它们是潜在 Range 锚点。
    renderer.setSelecting(true);
    fill(buf, Array.from({ length: 50 }, (_, i) => String(200 + i))); // 200..249
    container.scrollTop = 210 * ROW_HEIGHT; // 视口顶对齐 seq 210（visIdx=210，firstSeq=0）
    renderer.render(buf, identityView({ followEnabled: false }));
    const freshRow = container.querySelector('[data-seq="210"]') as HTMLElement;
    expect(freshRow).not.toBeNull();
    const freshHtml = freshRow.innerHTML;

    // 释放后渲染：冻结期已写行（renderedSeq === seq）不得被重写——重写会
    // 替换文本节点、破坏 Range 锚点。旧实现靠 `seq > lastRenderedSeq`
    // 误判（lastRenderedSeq 冻结在旧 lastSeq）导致无谓重写。
    renderer.setSelecting(false);
    renderer.render(buf, identityView({ followEnabled: false }));
    const after = container.querySelector('[data-seq="210"]') as HTMLElement;
    expect(after).not.toBeNull();
    expect(after.innerHTML).toBe(freshHtml); // 文本节点未被替换
  });
  it('materializes newly visible rows during drag-selection scroll (issue #12)', () => {
    fill(buf, Array.from({ length: 200 }, (_, i) => String(i)));
    container.scrollTop = 100 * ROW_HEIGHT;
    renderer.render(buf, identityView({ followEnabled: false }));
    // 拖选冻结进行中，向上滚动——新进视口的行必须物化且带内容。旧实现
    // `if (selecting) continue` 跳过创建 → 上方露出区域一片黑、选不到。
    renderer.setSelecting(true);
    container.scrollTop = 50 * ROW_HEIGHT;
    renderer.render(buf, identityView({ followEnabled: false }));
    const centerSeq = Math.floor((50 * ROW_HEIGHT + CLIENT_HEIGHT / 2) / ROW_HEIGHT);
    const newRow = container.querySelector(`[data-seq="${centerSeq}"]`) as HTMLElement;
    expect(newRow).not.toBeNull();
    expect(newRow.querySelector('.terminal-content')?.textContent).toBe(String(centerSeq));
    // 冻结的已有行（选区 Range 锚点）未被回收/重写。
    const anchor = container.querySelector('[data-seq="100"]') as HTMLElement;
    expect(anchor).not.toBeNull();
    const anchorHtml = anchor.innerHTML;
    const anchorTransform = anchor.style.transform;
    renderer.render(buf, identityView({ followEnabled: false }));
    expect(anchor.innerHTML).toBe(anchorHtml);
    expect(anchor.style.transform).toBe(anchorTransform);
    // 释放：不设 fullRedraw——已物化行（renderedSeq === seq）文本节点保留，
    // 期间跳过/新增的行由 dirty 检查补齐；窗口外行被回收。
    renderer.setSelecting(false);
    renderer.render(buf, identityView({ followEnabled: false }));
    const still = container.querySelector(`[data-seq="${centerSeq}"]`) as HTMLElement;
    expect(still).not.toBeNull();
    expect(still.querySelector('.terminal-content')?.textContent).toBe(String(centerSeq));
    expect(container.querySelector('[data-seq="100"]')).toBeNull(); // stale → recycled
  });

  it('drag-select disengages follow: viewport stays put while data streams (blank-output fix)', () => {
    fill(buf, Array.from({ length: 500 }, (_, i) => String(i)));
    // Follow locked at the bottom.
    renderer.render(buf, identityView({ followEnabled: true, locked: true }));
    const pinnedTop = container.scrollTop;
    expect(pinnedTop).toBeGreaterThan(0);
    const anchorSeq = Math.floor((pinnedTop + CLIENT_HEIGHT / 2) / ROW_HEIGHT);
    const anchorRow = container.querySelector(`[data-seq="${anchorSeq}"]`) as HTMLElement;
    expect(anchorRow).not.toBeNull();
    const anchorTransform = anchorRow.style.transform;
    const anchorHtml = anchorRow.innerHTML;

    // User starts a drag-select on a row. TerminalView calls setSelecting(true)
    // AND setLocked(false) — the drag must disengage follow so the frozen
    // viewport does not ride the growing content (old behavior: scrollTop
    // pinned to the growing bottom each frame, frozen rows left behind →
    // blank output).
    renderer.setSelecting(true);
    renderer.render(buf, identityView({ followEnabled: false, locked: false }));
    // Stream more data at high rate while frozen.
    fill(buf, Array.from({ length: 3000 }, (_, i) => String(500 + i)));
    for (let i = 0; i < 5; i++) {
      renderer.render(buf, identityView({ followEnabled: false, locked: false }));
    }
    // Viewport did NOT ride down — rows stayed in place, selection intact.
    expect(container.scrollTop).toBe(pinnedTop);
    const still = container.querySelector(`[data-seq="${anchorSeq}"]`) as HTMLElement;
    expect(still).toBe(anchorRow); // same live node
    expect(still.style.transform).toBe(anchorTransform);
    expect(still.innerHTML).toBe(anchorHtml);
    // The viewport still shows rows (not blank).
    const visible = Array.from(container.querySelectorAll('.terminal-line')).filter(
      (r) => {
        const top = Number(/translateY\((\d+)px\)/.exec((r as HTMLElement).style.transform)?.[1]);
        return top >= container.scrollTop && top < container.scrollTop + CLIENT_HEIGHT;
      },
    );
    expect(visible.length).toBeGreaterThan(0);
  });

  it('maintains DOM order == visIdx order after alternating scroll (insertRowInOrder min-visIdx fix)', () => {
    fill(buf, Array.from({ length: 3000 }, (_, i) => String(i)));
    // Scroll down, up, down, up — this jumbles the Map iteration order
    // (recycles delete middle entries, re-acquires append to Map end).
    // The old insertRowInOrder took the first Map-order match, not the
    // minimum visIdx, so DOM order diverged from visual order.
    const jumps = [200, 1000, 500, 1500, 300, 2000, 100, 2500, 50, 1800];
    for (const top of jumps) {
      container.scrollTop = top * ROW_HEIGHT;
      renderer.render(buf, identityView({ followEnabled: false }));
    }
    const rows = Array.from(container.querySelectorAll('.terminal-line')) as HTMLElement[];
    expect(rows.length).toBeGreaterThan(10);
    const seqs = rows.map((r) => Number(r.dataset.seq));
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  });

  it('follow pin shows the last row fully (padding-aware scrollTop)', () => {
    fill(buf, Array.from({ length: 500 }, (_, i) => String(i)));
    renderer.render(buf, identityView({ followEnabled: true }));
    // The last row must be fully inside the viewport — scrollTop + clientHeight
    // must reach the bottom of the content (including padding). The old
    // `totalHeight - clientHeight` left ~8px unscrolled, cutting off ~1/3 of
    // the last row.
    const lastSeq = buf.lastSeq;
    const lastRow = container.querySelector(`[data-seq="${lastSeq}"]`) as HTMLElement;
    expect(lastRow).not.toBeNull();
    const lastRowTop = Number(/translateY\((\d+)px\)/.exec(lastRow.style.transform)?.[1]);
    const lastRowBottom = lastRowTop + ROW_HEIGHT;
    const viewportBottom = container.scrollTop + container.clientHeight;
    // viewport bottom must reach at least the last row's bottom edge.
    expect(viewportBottom).toBeGreaterThanOrEqual(lastRowBottom);
  });

  it('keeps DOM order == visual order when scrolling up (drag-select fix)', () => {
    fill(buf, Array.from({ length: 2000 }, (_, i) => String(i)));
    // Land deep in the buffer (rows ~900..980 in view), then scroll UP so the
    // recycle/acquire pattern pulls head rows from the pool — the bug appends
    // them at the contentLayer tail, reversing DOM order vs visual order.
    container.scrollTop = 900 * ROW_HEIGHT;
    renderer.render(buf, identityView({ followEnabled: false }));
    container.scrollTop = 700 * ROW_HEIGHT;
    renderer.render(buf, identityView({ followEnabled: false }));
    container.scrollTop = 500 * ROW_HEIGHT;
    renderer.render(buf, identityView({ followEnabled: false }));
    // Every visible row's translateY must be monotonically increasing and the
    // DOM children must be sorted by their seq (== visual top-to-bottom).
    const rows = Array.from(container.querySelectorAll('.terminal-line')) as HTMLElement[];
    expect(rows.length).toBeGreaterThan(10);
    const seqs = rows.map((r) => Number(r.dataset.seq));
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
    const tops = rows.map((r) => Number(/translateY\((\d+)px\)/.exec(r.style.transform)?.[1]));
    for (let i = 1; i < tops.length; i++) {
      expect(tops[i]).toBeGreaterThan(tops[i - 1]);
    }
  });

  it('empty buffer renders zero rows', () => {
    renderer.render(buf, identityView());
    expect(container.querySelectorAll('.terminal-line').length).toBe(0);
  });

  it('survives a large head trim without stacked/overlapping rows (issue #14)', () => {
    // 复现 issue #14：一次 append 可裁掉缓冲半数（byte-budget drain），firstSeq
    // 大幅前移。旧行缓存的 visIdx 停在旧窗口值——若 1b 排序/insertRowInOrder
    // 仍信缓存值，trim 后渲染可能出现同 Y 重叠或 DOM 顺序错乱。本用例构造一个
    // 容量受限的 buffer，先填满并渲染（窗口在底部），再触发一次大 trim，然后
    // 向上滚动露出裁后头部，断言：所有 active 行 translateY 唯一 + DOM order
    // == seq 升序。
    const small = new TerminalBuffer({ maxLines: 60 });
    fill(small, Array.from({ length: 60 }, (_, i) => String(i)));
    // 渲染到底部（follow），窗口覆盖最新 ~24 行。
    renderer.render(small, identityView({ followEnabled: true }));
    const domBefore = container.querySelectorAll('.terminal-line').length;
    expect(domBefore).toBeGreaterThan(0);

    // 构造大 trim：继续 append 30 行 → head 前进 30（容量 60，覆盖最旧 30）。
    fill(small, Array.from({ length: 30 }, (_, i) => String(60 + i)));
    expect(small.firstSeq).toBe(30); // head 前移 30
    renderer.render(small, identityView({ followEnabled: true }));

    // 向上滚到裁后缓冲的头部，触发 recycle + 新行物化（insertRowInOrder 路径）。
    container.scrollTop = 0;
    renderer.render(small, identityView({ followEnabled: false }));
    const rows = Array.from(container.querySelectorAll('.terminal-line')) as HTMLElement[];
    expect(rows.length).toBeGreaterThan(10);

    // (a) translateY 唯一——无重叠/堆叠
    const tops = rows.map((r) => Number(/translateY\(([-\d.]+)px\)/.exec(r.style.transform)?.[1]));
    const uniqueTops = new Set(tops);
    expect(uniqueTops.size).toBe(tops.length);
    // (b) DOM 顺序 == seq 升序 == 视觉顺序
    const seqs = rows.map((r) => Number(r.dataset.seq));
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
    // (c) 每行的 visIdx（seq - firstSeq）与 translateY 一致
    for (let i = 0; i < rows.length; i++) {
      expect(tops[i]).toBe((Number(rows[i].dataset.seq) - small.firstSeq) * ROW_HEIGHT);
    }
  });
});

describe('TerminalRenderer large-trim anchor (issue #10)', () => {
  it('keeps the reading position across a large head trim (non-follow)', () => {
    // 非 follow（用户上滚读历史）状态下，字节预算大 drain 单帧前移 firstSeq
    // 数十万行：修复前 scrollTop 停在超界像素值（浏览器会把滚动位置夹到新内容
    // 底），视口被甩走、阅读位置丢失。修复后按上一帧视口顶部 seq 恢复锚点。
    const big = new TerminalBuffer({ maxLines: 500_000 });
    fill(big, Array.from({ length: 200_000 }, (_, i) => String(i)));
    renderer.render(big, identityView({ followEnabled: false }));
    container.scrollTop = 100_000 * ROW_HEIGHT;
    renderer.render(big, identityView({ followEnabled: false }));
    const anchorRow = container.querySelector('[data-seq="100000"]') as HTMLElement;
    expect(anchorRow).not.toBeNull();
    expect(anchorRow.style.transform).toBe(`translateY(${100_000 * ROW_HEIGHT}px)`);

    // 大 drain：收缩容量使 head 前移 50_000（模拟字节预算裁到一半）。
    big.setLimits({ maxLines: 150_000 });
    expect(big.firstSeq).toBe(50_000);
    renderer.render(big, identityView({ followEnabled: false }));

    // 锚点行（seq 100000）仍存活且回到视口顶部；scrollTop 重算到新位置——
    // 而不是停在超界值或浏览器夹取后的内容底部。
    const still = container.querySelector('[data-seq="100000"]') as HTMLElement;
    expect(still).not.toBeNull();
    expect(still.style.transform).toBe(`translateY(${50_000 * ROW_HEIGHT}px)`);
    expect(container.scrollTop).toBe(50_000 * ROW_HEIGHT);
  });

  it('clamps to the content top when the anchor row was trimmed (non-follow)', () => {
    const big = new TerminalBuffer({ maxLines: 500_000 });
    fill(big, Array.from({ length: 200_000 }, (_, i) => String(i)));
    renderer.render(big, identityView({ followEnabled: false }));
    container.scrollTop = 100_000 * ROW_HEIGHT;
    renderer.render(big, identityView({ followEnabled: false }));

    // 锚点行（100000）被大 drain 裁掉：视口应停在内容头部而不是被夹到底部。
    big.setLimits({ maxLines: 90_000 }); // firstSeq = 110_000 > anchor
    renderer.render(big, identityView({ followEnabled: false }));
    expect(container.scrollTop).toBe(0);
    expect(container.querySelector('[data-seq="110000"]')).not.toBeNull();
  });

  it('follow re-pins one-shot to the new bottom after a large trim', () => {
    const big = new TerminalBuffer({ maxLines: 500_000 });
    fill(big, Array.from({ length: 100_000 }, (_, i) => String(i)));
    renderer.render(big, identityView({ followEnabled: true }));
    expect(container.scrollTop).toBeGreaterThan(0);

    // 大 trim 后：follow 直接按新 totalHeight 一次到位钉底（视口内容即最新行，
    // 与 trim 前一致），不依赖逐帧回填。
    big.setLimits({ maxLines: 40_000 });
    renderer.render(big, identityView({ followEnabled: true }));
    const expected = Math.max(0, (big.lastSeq - big.firstSeq + 1) * ROW_HEIGHT - CLIENT_HEIGHT);
    expect(container.scrollTop).toBe(expected);
    const lastRow = container.querySelector(`[data-seq="${big.lastSeq}"]`) as HTMLElement;
    expect(lastRow).not.toBeNull();
  });
});

describe('TerminalRenderer.seqFromEventTarget', () => {
  it('extracts the seq from a nested row child', () => {
    fill(buf, Array.from({ length: 5 }, (_, i) => String(i)));
    renderer.render(buf, identityView({ followEnabled: false }));
    const content = container.querySelector('[data-seq="3"] .terminal-content') as HTMLElement;
    expect(TerminalRenderer.seqFromEventTarget(content)).toBe(3);
    expect(TerminalRenderer.seqFromEventTarget(container)).toBeNull();
    expect(TerminalRenderer.seqFromEventTarget(null)).toBeNull();
  });
});

describe('TerminalRenderer updateConfig', () => {
  it('redraws all rows with the new display format', () => {
    buf.append({ timestamp: 0, direction: 'RX', rawData: new Uint8Array([0x41, 0x42]), isHex: false });
    renderer.render(buf, identityView({ followEnabled: false }));
    const contentBefore = (container.querySelector('.terminal-content') as HTMLElement).textContent;
    expect(contentBefore).toBe('AB');

    renderer.updateConfig({ displayFormat: 'hex' });
    renderer.render(buf, identityView({ followEnabled: false }));
    const contentAfter = (container.querySelector('.terminal-content') as HTMLElement).textContent;
    expect(contentAfter).toBe('41 42');
  });

  it('row height change repositions rows', () => {
    fill(buf, Array.from({ length: 5 }, (_, i) => String(i)));
    renderer.render(buf, identityView({ followEnabled: false }));
    renderer.updateConfig({ rowHeight: 36 });
    renderer.render(buf, identityView({ followEnabled: false }));
    const row4 = container.querySelector('[data-seq="4"]') as HTMLElement;
    expect(row4.style.transform).toBe('translateY(144px)');
    expect(row4.style.height).toBe('36px');
  });
});

describe('TerminalRenderer over-wide lines (issue #15)', () => {
  it('content span carries the vertical clip and the no-shrink contract', () => {
    // 超宽行：white-space: pre 不换行，内容 span 内联 max-height + overflow:hidden
    // 负责垂直裁剪（内嵌 \n 的第二视觉行不叠到下一行）；横向不得裁——span 作为
    // .terminal-line（flex）的 flex item，必须 flex: none（0 0 auto，不收缩），
    // 否则内联 overflow:hidden 把自动最小尺寸归零后 flex-shrink 会把 span 压到
    // 行宽、超宽内容在 span 内部被裁，.terminal-view 的 overflow-x: auto 拿不到
    // 溢出 → 横向滚动条不出现（issue #15 回归）。
    const wide = 'X'.repeat(400);
    fill(buf, [wide]);
    renderer.render(buf, identityView({ followEnabled: false }));
    const span = container.querySelector('.terminal-content') as HTMLElement;
    expect(span).not.toBeNull();
    expect(span.style.maxHeight).toBe(`${ROW_HEIGHT}px`);
    expect(span.style.overflow).toBe('hidden');
    // 计算样式来自注入的 terminal-view.css（vite.config test.css）。
    expect(getComputedStyle(span).whiteSpace).toBe('pre');
    expect(getComputedStyle(span).flexShrink).toBe('0');
    expect(getComputedStyle(span).flexGrow).toBe('0');
    expect(getComputedStyle(span).flexBasis).toBe('auto');
  });

  it('row box width stays 100% (background coverage) with overflow visible (propagation)', () => {
    // .terminal-line 由引擎内联 width:100%（行背景/选中高亮铺满视口宽），overflow
    // 保持 visible——超宽 span 的盒子才能把溢出传播到 .terminal-view 滚动容器。
    const wide = 'Y'.repeat(400);
    fill(buf, [wide]);
    renderer.render(buf, identityView({ followEnabled: false }));
    const row = container.querySelector('.terminal-line') as HTMLElement;
    expect(row.style.width).toBe('100%');
    expect(getComputedStyle(row).overflowX).toBe('visible');
    expect(getComputedStyle(row).overflowY).toBe('visible');
  });
});
