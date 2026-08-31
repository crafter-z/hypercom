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

const range1000 = (from: number): string[] =>
  Array.from({ length: 1000 }, (_, i) => String(from + i));

/** Build a live browser selection anchored to rows [a..b] (must be in DOM). */
function selectRows(a: number, b: number): Selection {
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  const range = document.createRange();
  const startEl = container.querySelector(`[data-seq="${a}"] .terminal-content`) as HTMLElement;
  const endEl = container.querySelector(`[data-seq="${b}"] .terminal-content`) as HTMLElement;
  range.setStart(startEl.firstChild!, 0);
  range.setEnd(endEl.firstChild!, 1);
  sel.addRange(range);
  return sel;
}

/** Clear the selection and fire the event jsdom never dispatches itself. */
function clearSelection() {
  window.getSelection()!.removeAllRanges();
  document.dispatchEvent(new Event('selectionchange'));
}

const rowSeqs = (root: ParentNode): number[] =>
  Array.from(root.querySelectorAll('.terminal-line')).map((n) =>
    Number((n as HTMLElement).dataset.seq),
  );

/** Flow layer children are [headSpacer][rows…][tailSpacer] — spacers are
 *  the permanent first/last children of the layer. */
const layerSpacers = (root: ParentNode): [HTMLElement, HTMLElement] => {
  const layer = root.querySelector('.terminal-content-layer') as HTMLElement;
  const children = Array.from(layer.children) as HTMLElement[];
  return [children[0], children[children.length - 1]];
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
    // 置顶 render。detach 清空 active，全量重建（flow 布局下 insertBefore
    // 锚点永远活着，此路径不再有脱链风险，保留为回归防线）。
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

  it('clear empties the layer leaving only the two spacers', () => {
    fill(buf, ['a', 'b', 'c']);
    renderer.render(buf, identityView());
    expect(container.querySelectorAll('.terminal-line').length).toBeGreaterThan(0);
    renderer.clear();
    expect(container.querySelectorAll('.terminal-line').length).toBe(0);
    // Flow layout: layer height is no longer set; spacers reset to 0.
    const layer = container.querySelector('.terminal-content-layer') as HTMLElement;
    expect(layer.style.height).toBe('');
    const spacers = Array.from(layer.children) as HTMLElement[];
    expect(spacers.length).toBe(2);
    expect(spacers[0].style.height).toBe('0px');
    expect(spacers[1].style.height).toBe('0px');
  });
});

describe('TerminalRenderer identity rendering', () => {
  it('renders the pinned bottom window with flow spacers', () => {
    fill(buf, Array.from({ length: 100 }, (_, i) => String(i)));
    renderer.render(buf, identityView());
    // locked + followEnabled → scrollTop = 1800 - 200 = 1600 → rows 76..99
    expect(container.scrollTop).toBe(1600);
    // Window: firstVisIdx = floor(1600/18) - 12 = 76, lastVisIdx = min(99, 111) = 99.
    const [head, tail] = layerSpacers(container);
    expect(head.style.height).toBe(`${76 * ROW_HEIGHT}px`); // 1368px
    expect(tail.style.height).toBe('0px');
    expect(
      (container.querySelector('.terminal-content-layer') as HTMLElement).style.height,
    ).toBe(''); // not set in flow layout
    const rows = container.querySelectorAll('.terminal-line');
    expect(rows.length).toBe(24);
    const last = rows[rows.length - 1] as HTMLElement;
    expect(last.dataset.seq).toBe('99');
    // Flow rows carry no positioning styles.
    expect(last.style.transform).toBe('');
    expect(last.style.top).toBe('');
    expect(last.style.left).toBe('');
    expect(last.style.width).toBe('');
  });

  it('keeps one fixed-height row per line for over-wide lines (issue #9)', () => {
    // An over-wide line must stay ONE fixed-height row: with CSS wrapping the
    // row painted a second visual line over the next row (fixed rowHeight +
    // pre-wrap). Flow layout + the clipped content span make overlap impossible.
    const long = 'X'.repeat(5000);
    fill(buf, ['a', long, 'b', 'c']);
    renderer.render(buf, identityView({ followEnabled: false }));
    const rows = Array.from(container.querySelectorAll('.terminal-line')) as HTMLElement[];
    expect(rows.length).toBe(4); // exactly one row per line — no wrapped rows
    // Flow order == seq order, one row per line.
    expect(rows.map((r) => Number(r.dataset.seq))).toEqual([0, 1, 2, 3]);
    for (const row of rows) {
      expect(row.style.height).toBe(`${ROW_HEIGHT}px`);
      expect(row.style.transform).toBe('');
    }
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
    // DOM 行数无限增长。seq 窗口边界检查必须回收被裁行。
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
  it('renders only the surviving seqs in flow order', () => {
    fill(buf, Array.from({ length: 10 }, (_, i) => String(i)));
    renderer.render(buf, identityView({ visibleSeqs: [0, 2, 4, 6], followEnabled: false }));
    const rows = container.querySelectorAll('.terminal-line');
    expect(rows.length).toBe(4);
    // Flow layout: DOM order == list order, no transform positioning.
    const seqs = Array.from(rows).map((n) => (n as HTMLElement).dataset.seq);
    expect(seqs).toEqual(['0', '2', '4', '6']);
    for (const n of rows) {
      expect((n as HTMLElement).style.transform).toBe('');
    }
  });

  it('caps the rendered window at frozenSeq when paused', () => {
    fill(buf, Array.from({ length: 10 }, (_, i) => String(i)));
    renderer.render(buf, identityView({ frozenSeq: 4, followEnabled: false }));
    const maxSeq = Math.max(...Array.from(container.querySelectorAll('.terminal-line')).map((n) => Number((n as HTMLElement).dataset.seq)));
    expect(maxSeq).toBeLessThanOrEqual(4);
    // Spacers: 5 rows × 18 → tail = 0, head = 0 (all rows visible in window).
    const [head, tail] = layerSpacers(container);
    expect(head.style.height).toBe('0px');
    expect(tail.style.height).toBe('0px');
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

describe('TerminalRenderer selection pins (issue #18)', () => {
  it('pins rows under a live selection: not recycled, not rewritten, unpinned rows recycle', () => {
    fill(buf, range1000(0));
    container.scrollTop = 100 * ROW_HEIGHT;
    renderer.render(buf, identityView({ followEnabled: false }));

    // Live Range anchored to rows 100..105.
    const sel = selectRows(100, 105);
    expect(sel.toString()).toBeTruthy();
    renderer.render(buf, identityView({ followEnabled: false })); // syncPins
    expect(renderer.pinnedCount()).toBe(6);
    const pinned = Array.from({ length: 6 }, (_, i) =>
      container.querySelector(`[data-seq="${100 + i}"]`) as HTMLElement,
    );
    const pinnedHtml = pinned.map((n) => n.innerHTML);

    // Drag-selection in progress: data keeps flowing and the viewport moves,
    // but pinned rows must NOT be recycled, re-acquired or rewritten.
    fill(buf, Array.from({ length: 400 }, (_, i) => String(1000 + i)));
    container.scrollTop = 300 * ROW_HEIGHT; // window shifted far away
    renderer.render(buf, identityView({ followEnabled: false }));
    // Rows 100..105 still in DOM with node identity intact (parked).
    for (let i = 0; i < 6; i++) {
      const node = container.querySelector(`[data-seq="${100 + i}"]`) as HTMLElement;
      expect(node).toBe(pinned[i]);
      expect(node.style.display).toBe('none'); // parked outside the window
      expect(node.innerHTML).toBe(pinnedHtml[i]); // content untouched while pinned
    }
    // Unpinned rows (e.g. 90) recycled when the window moved away.
    expect(container.querySelector('[data-seq="90"]')).toBeNull();

    // Release: clear the selection + fire the event jsdom doesn't auto-fire,
    // then render — parked rows recycle (row 100 gone from the DOM).
    clearSelection();
    renderer.render(buf, identityView({ followEnabled: false }));
    expect(container.querySelector('[data-seq="100"]')).toBeNull();
    expect(container.querySelector('[data-seq="105"]')).toBeNull();
    // New window rows materialize.
    const centerSeq = Math.floor((300 * ROW_HEIGHT + CLIENT_HEIGHT / 2) / ROW_HEIGHT);
    expect(container.querySelector(`[data-seq="${centerSeq}"]`)).not.toBeNull();
  });

  it('keeps rows the live selection anchors to after release (issue #17)', () => {
    fill(buf, range1000(0));
    container.scrollTop = 100 * ROW_HEIGHT;
    renderer.render(buf, identityView({ followEnabled: false }));
    const anchor = container.querySelector('[data-seq="100"]') as HTMLElement;
    expect(anchor).not.toBeNull();

    // 浏览器原生选区：起点锚在 seq=100 行、终点在 seq=105 行。
    const sel = selectRows(100, 105);
    expect(sel.toString()).toBeTruthy();
    renderer.render(buf, identityView({ followEnabled: false })); // syncPins

    // 释放路径（清选区前的最后一帧）：窗口移到远处，seq=100 行已滚出视口。
    // 修复前：recycle() 移除 Range 锚定节点 → Chromium 清空选区（issue #17）。
    // 修复后：被活选区命中的行保留（parked），未命中的行回收。
    container.scrollTop = 300 * ROW_HEIGHT; // 窗口移走
    renderer.render(buf, identityView({ followEnabled: false }));

    // 选区命中的行保留（DOM 仍在，parked），选区文本不丢
    const kept = container.querySelector('[data-seq="100"]') as HTMLElement;
    expect(kept).not.toBeNull();
    expect(kept).toBe(anchor);
    expect(kept.style.display).toBe('none');
    expect(sel.toString()).toBeTruthy();

    // 未命中的视口外行正常回收（如 seq=90）
    expect(container.querySelector('[data-seq="90"]')).toBeNull();

    // 用户点击别处清选区 + selectionchange → 下一帧正常回收（自限）
    clearSelection();
    renderer.render(buf, identityView({ followEnabled: false }));
    expect(container.querySelector('[data-seq="100"]')).toBeNull();
  });

  it('materializes newly visible rows during selection scroll (issue #12)', () => {
    fill(buf, range1000(0));
    container.scrollTop = 100 * ROW_HEIGHT;
    renderer.render(buf, identityView({ followEnabled: false }));
    // 选区进行中向上滚动——新进视口的行（未 pin）必须正常物化且带内容；
    // 无全局冻结。pin 住的行保持内容。
    selectRows(100, 102);
    renderer.render(buf, identityView({ followEnabled: false })); // syncPins
    container.scrollTop = 50 * ROW_HEIGHT;
    renderer.render(buf, identityView({ followEnabled: false }));
    const centerSeq = Math.floor((50 * ROW_HEIGHT + CLIENT_HEIGHT / 2) / ROW_HEIGHT);
    const newRow = container.querySelector(`[data-seq="${centerSeq}"]`) as HTMLElement;
    expect(newRow).not.toBeNull();
    expect(newRow.querySelector('.terminal-content')?.textContent).toBe(String(centerSeq));
    // Pin 住的行未被重写（innerHTML 不变）。
    const pinned = container.querySelector('[data-seq="100"]') as HTMLElement;
    expect(pinned).not.toBeNull();
    const pinnedHtml = pinned.innerHTML;
    renderer.render(buf, identityView({ followEnabled: false }));
    expect((container.querySelector('[data-seq="100"]') as HTMLElement).innerHTML).toBe(pinnedHtml);
    // 选区清除后：pin 住的窗口外行回收。
    clearSelection();
    renderer.render(buf, identityView({ followEnabled: false }));
    expect(container.querySelector('[data-seq="100"]')).toBeNull();
  });

  it('drag-select keeps the viewport put while data streams (follow disengage)', () => {
    // Renderer-side contract: with locked=false + followEnabled=false the
    // viewport never rides the growing bottom while rows stream in. (The
    // setSelecting call itself lives in TerminalView now — pin-based.)
    fill(buf, Array.from({ length: 500 }, (_, i) => String(i)));
    // Follow locked at the bottom.
    renderer.render(buf, identityView({ followEnabled: true, locked: true }));
    const pinnedTop = container.scrollTop;
    expect(pinnedTop).toBeGreaterThan(0);
    const anchorSeq = Math.floor((pinnedTop + CLIENT_HEIGHT / 2) / ROW_HEIGHT);
    const anchorRow = container.querySelector(`[data-seq="${anchorSeq}"]`) as HTMLElement;
    expect(anchorRow).not.toBeNull();
    const anchorHtml = anchorRow.innerHTML;

    // User drag-selects a row (live selection) and follow disengages.
    selectRows(anchorSeq, anchorSeq + 2);
    renderer.render(buf, identityView({ followEnabled: false, locked: false })); // syncPins
    // Stream more data at high rate while the user reads/drags.
    fill(buf, Array.from({ length: 3000 }, (_, i) => String(3500 + i)));
    for (let i = 0; i < 5; i++) {
      renderer.render(buf, identityView({ followEnabled: false, locked: false }));
    }
    // Viewport did NOT ride down — rows stayed in place, selection intact.
    expect(container.scrollTop).toBe(pinnedTop);
    const still = container.querySelector(`[data-seq="${anchorSeq}"]`) as HTMLElement;
    expect(still).toBe(anchorRow); // same live node
    expect(still.innerHTML).toBe(anchorHtml); // pinned → not rewritten
    // The viewport still shows rows (not blank).
    const visible = Array.from(container.querySelectorAll('.terminal-line')).filter(
      (r) => (r as HTMLElement).style.display !== 'none',
    );
    expect(visible.length).toBeGreaterThan(0);
  });

  it('pinned row head-trimmed out of the buffer parks with stale content until the selection clears', () => {
    const small = new TerminalBuffer({ maxLines: 40 });
    fill(small, Array.from({ length: 40 }, (_, i) => String(i)));
    container.scrollTop = 0;
    renderer.render(small, identityView({ followEnabled: false }));

    // Pin rows 5..8 (in window).
    selectRows(5, 8);
    renderer.render(small, identityView({ followEnabled: false }));
    expect(renderer.pinnedCount()).toBe(4);
    const parkedNode = container.querySelector('[data-seq="5"]') as HTMLElement;
    expect(parkedNode).not.toBeNull();

    // Append past capacity → head trim evicts seqs 0..4 (and more later).
    fill(small, Array.from({ length: 40 }, (_, i) => String(40 + i)));
    renderer.render(small, identityView({ followEnabled: false }));
    // seq 5 < firstSeq now; the pinned node must still be in the DOM (parked,
    // display:none) with its stale content — never re-parented mid-selection.
    const parked = container.querySelector('[data-seq="5"]') as HTMLElement;
    expect(parked).toBe(parkedNode);
    expect(parked.style.display).toBe('none');
    expect(parked.textContent).toContain('5');

    // Selection clears → parked rows recycle on the next pass.
    clearSelection();
    renderer.render(small, identityView({ followEnabled: false }));
    expect(container.querySelector('[data-seq="5"]')).toBeNull();
  });

  it('clears pins when the selection spans more than MAX_PINNED_ROWS (600)', () => {
    fill(buf, range1000(0));
    container.scrollTop = 0;
    renderer.render(buf, identityView({ followEnabled: false }));
    // Build a live selection anchored at row 0. Then scroll far and extend
    // the range's endpoint to a row whose seq makes the span 0..630 = 631
    // rows > 600 → the renderer must drop pins entirely (rows recycle
    // normally). Chromium's wheel-during-drag extends the range the same way.
    const sel = window.getSelection()!;
    const range = document.createRange();
    const a = container.querySelector('[data-seq="0"] .terminal-content') as HTMLElement;
    const b = container.querySelector('[data-seq="10"] .terminal-content') as HTMLElement;
    range.setStart(a.firstChild!, 0);
    range.setEnd(b.firstChild!, 1);
    sel.addRange(range);
    renderer.render(buf, identityView({ followEnabled: false })); // syncPins: 0..10
    expect(renderer.pinnedCount()).toBe(11);

    container.scrollTop = 620 * ROW_HEIGHT;
    renderer.render(buf, identityView({ followEnabled: false }));
    // Row 0 is parked (pinned); re-anchor the range end deep below.
    const c = container.querySelector('[data-seq="630"] .terminal-content') as HTMLElement;
    range.setEnd(c.firstChild!, 1);
    sel.removeAllRanges();
    sel.addRange(range);
    renderer.render(buf, identityView({ followEnabled: false }));
    // Span 0..630 = 631 rows > 600 → pins cleared entirely.
    expect(renderer.pinnedCount()).toBe(0);
    // Rows recycle normally: nothing parked.
    const parked = Array.from(container.querySelectorAll('.terminal-line')).filter(
      (r) => (r as HTMLElement).style.display === 'none',
    );
    expect(parked.length).toBe(0);
    // And a normal selection still pins afterwards.
    clearSelection();
    renderer.render(buf, identityView({ followEnabled: false }));
    selectRows(620, 625);
    renderer.render(buf, identityView({ followEnabled: false }));
    expect(renderer.pinnedCount()).toBe(6);
  });

  it('pinnedCount reflects the active pinned rows and drops to zero after clear', () => {
    fill(buf, Array.from({ length: 50 }, (_, i) => String(i)));
    container.scrollTop = 0;
    renderer.render(buf, identityView({ followEnabled: false }));
    expect(renderer.pinnedCount()).toBe(0);
    selectRows(3, 9);
    renderer.render(buf, identityView({ followEnabled: false }));
    expect(renderer.pinnedCount()).toBe(7);
    renderer.clearPins();
    expect(renderer.pinnedCount()).toBe(0);
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

  it('maintains DOM order == visIdx order after alternating scroll', () => {
    // Flow layout makes this structural; kept as a cheap sanity check.
    fill(buf, Array.from({ length: 3000 }, (_, i) => String(i)));
    const jumps = [200, 1000, 500, 1500, 300, 2000, 100, 2500, 50, 1800];
    for (const top of jumps) {
      container.scrollTop = top * ROW_HEIGHT;
      renderer.render(buf, identityView({ followEnabled: false }));
    }
    const seqs = rowSeqs(container);
    expect(seqs.length).toBeGreaterThan(10);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  });

  it('follow pin shows the last row fully (padding-aware scrollTop)', () => {
    fill(buf, Array.from({ length: 500 }, (_, i) => String(i)));
    renderer.render(buf, identityView({ followEnabled: true }));
    // The last row must be fully inside the viewport — scrollTop + clientHeight
    // must reach the bottom of the content (including padding). jsdom computes
    // padding = 0, so scrollTop = totalHeight - clientHeight exactly; the last
    // row's bottom edge must be reachable.
    const lastSeq = buf.lastSeq;
    const lastRow = container.querySelector(`[data-seq="${lastSeq}"]`) as HTMLElement;
    expect(lastRow).not.toBeNull();
    const viewportBottom = container.scrollTop + container.clientHeight;
    const totalHeight = buf.length * ROW_HEIGHT;
    expect(viewportBottom).toBeGreaterThanOrEqual(totalHeight);
  });

  it('keeps DOM order == visual order when scrolling up', () => {
    fill(buf, Array.from({ length: 2000 }, (_, i) => String(i)));
    // Land deep in the buffer (rows ~900..980 in view), then scroll UP —
    // flow layout makes DOM order == seq order structural; sanity check.
    container.scrollTop = 900 * ROW_HEIGHT;
    renderer.render(buf, identityView({ followEnabled: false }));
    container.scrollTop = 700 * ROW_HEIGHT;
    renderer.render(buf, identityView({ followEnabled: false }));
    container.scrollTop = 500 * ROW_HEIGHT;
    renderer.render(buf, identityView({ followEnabled: false }));
    const seqs = rowSeqs(container);
    expect(seqs.length).toBeGreaterThan(10);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  });

  it('empty buffer renders zero rows', () => {
    renderer.render(buf, identityView());
    expect(container.querySelectorAll('.terminal-line').length).toBe(0);
  });

  it('survives a large head trim without stacked/overlapping rows (issue #14)', () => {
    // Flow layout: no transforms to overlap — assert DOM order == seq order,
    // no duplicates after trim + scroll, spacers consistent with the window.
    const small = new TerminalBuffer({ maxLines: 60 });
    fill(small, Array.from({ length: 60 }, (_, i) => String(i)));
    // 渲染到底部（follow），窗口覆盖最新 ~24 行。
    renderer.render(small, identityView({ followEnabled: true }));
    expect(container.querySelectorAll('.terminal-line').length).toBeGreaterThan(0);

    // 构造大 trim：继续 append 30 行 → head 前进 30（容量 60，覆盖最旧 30）。
    fill(small, Array.from({ length: 30 }, (_, i) => String(60 + i)));
    expect(small.firstSeq).toBe(30); // head 前移 30
    renderer.render(small, identityView({ followEnabled: true }));

    // 向上滚到裁后缓冲的头部，触发 recycle + 新行物化。
    container.scrollTop = 0;
    renderer.render(small, identityView({ followEnabled: false }));
    const rows = Array.from(container.querySelectorAll('.terminal-line')) as HTMLElement[];
    expect(rows.length).toBeGreaterThan(10);

    // (a) DOM 顺序 == seq 升序 == 视觉顺序（flow 布局的结构保证）
    const seqs = rows.map((r) => Number(r.dataset.seq));
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
    // (b) 无重复 seq
    expect(new Set(seqs).size).toBe(seqs.length);
    // (c) spacer 高度与窗口一致：scrollTop 0 → firstVisIdx 0 → head 0px；
    //     tail = (count - 1 - lastVisIdx) × rowHeight
    const [head, tail] = layerSpacers(container);
    expect(head.style.height).toBe('0px');
    const count = small.lastSeq - small.firstSeq + 1; // 90
    const lastVisIdx = Math.min(count - 1, Math.ceil((0 + CLIENT_HEIGHT) / ROW_HEIGHT) + 12);
    expect(tail.style.height).toBe(`${(count - 1 - lastVisIdx) * ROW_HEIGHT}px`);
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
    expect(container.querySelector('[data-seq="100000"]')).not.toBeNull();

    // 大 drain：收缩容量使 head 前移 50_000（模拟字节预算裁到一半）。
    big.setLimits({ maxLines: 150_000 });
    expect(big.firstSeq).toBe(50_000);
    renderer.render(big, identityView({ followEnabled: false }));

    // 锚点行（seq 100000）仍存活且回到视口顶部；scrollTop 重算到新位置——
    // 而不是停在超界值或浏览器夹取后的内容底部。
    expect(container.querySelector('[data-seq="100000"]')).not.toBeNull();
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

  it('row height change re-lays rows via row height and spacers', () => {
    fill(buf, Array.from({ length: 5 }, (_, i) => String(i)));
    renderer.render(buf, identityView({ followEnabled: false }));
    renderer.updateConfig({ rowHeight: 36 });
    renderer.render(buf, identityView({ followEnabled: false }));
    const row4 = container.querySelector('[data-seq="4"]') as HTMLElement;
    expect(row4.style.height).toBe('36px');
    expect(row4.style.transform).toBe('');
    // 5 rows × 36 = 180 total; scrollTop 0 → all 5 in window → tail 0.
    const [, tail] = layerSpacers(container);
    expect(tail.style.height).toBe('0px');
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
    // .terminal-line 由 CSS width:100%（行背景/选中高亮铺满视口宽），overflow
    // 保持 visible——超宽 span 的盒子才能把溢出传播到 .terminal-view 滚动容器。
    // Flow layout (issue #18): createRowNode no longer sets width inline —
    // width comes from the stylesheet (terminalNoWrap.test.ts pins that CSS).
    const wide = 'Y'.repeat(400);
    fill(buf, [wide]);
    renderer.render(buf, identityView({ followEnabled: false }));
    const row = container.querySelector('.terminal-line') as HTMLElement;
    expect(row.style.width).toBe('');
    expect(getComputedStyle(row).overflowX).toBe('visible');
    expect(getComputedStyle(row).overflowY).toBe('visible');
  });
});
