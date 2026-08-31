// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import type { TerminalLine } from '../../types';
import { TerminalBuffer } from './TerminalBuffer';
import { TerminalRenderer, type RendererConfig, type TerminalViewState } from './TerminalRenderer';
import '../../styles/terminal-view.css';

/**
 * Soak invariants for the flow-layout + selection-pin renderer (issue #18).
 *
 * Property-style: a seeded PRNG drives ~300 mixed operations (append, scroll
 * jumps, filter toggles, full redraws, trim storms, occasional live
 * selection, clear) and after EVERY op the structural invariants are asserted
 * against the DOM — public API only, no renderer internals.
 *
 * jsdom has no real layout: scrollHeight/client rectangles are unreliable, so
 * window sizes are computed structurally from rowHeight/clientHeight/spacers.
 */

const ROW_HEIGHT = 18;
const CLIENT_HEIGHT = 200;
const OVERSCAN = 12;
const ITERATIONS = 300;

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

/** Deterministic PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ==================== Invariants ====================

const rows = (container: HTMLElement): HTMLElement[] =>
  Array.from(container.querySelectorAll('.terminal-line')) as HTMLElement[];

const parkedCount = (container: HTMLElement): number =>
  rows(container).filter((r) => r.style.display === 'none').length;

const spacerHeights = (container: HTMLElement): [number, number] => {
  const layer = container.querySelector('.terminal-content-layer') as HTMLElement;
  const children = Array.from(layer.children) as HTMLElement[];
  const head = children[0];
  const tail = children[children.length - 1];
  const headPx = Number.parseFloat(head.style.height) || 0;
  const tailPx = Number.parseFloat(tail.style.height) || 0;
  return [headPx, tailPx];
};

function assertInvariants(
  container: HTMLElement,
  buf: TerminalBuffer,
  view: TerminalViewState,
  ctx: string,
) {
  const all = rows(container);
  const parked = parkedCount(container);
  const layer = container.querySelector('.terminal-content-layer') as HTMLElement;

  // INV1: bounded DOM — window row estimate + parked + slack.
  const windowRows = Math.ceil(CLIENT_HEIGHT / ROW_HEIGHT) + 2 * OVERSCAN;
  const bound = windowRows + parked + 2;
  if (all.length > bound) {
    throw new Error(
      `${ctx}: INV1 violated — ${all.length} rows in DOM, bound ${bound} ` +
        `(window ${windowRows}, parked ${parked}). seqs: ` +
        all.map((r) => r.dataset.seq).join(','),
    );
  }

  // INV2: visible rows strictly ascending data-seq in DOM order (flow layout).
  const visible = all.filter((r) => r.style.display !== 'none');
  for (let i = 1; i < visible.length; i++) {
    const prev = Number(visible[i - 1].dataset.seq);
    const cur = Number(visible[i].dataset.seq);
    if (!(cur > prev)) {
      throw new Error(
        `${ctx}: INV2 violated — visible DOM order broken at index ${i}: ` +
          `${prev} -> ${cur}. seqs: ` + all.map((r) => r.dataset.seq).join(','),
      );
    }
  }

  // INV3: every row's seq is within the live buffer window OR parked.
  for (const r of all) {
    const seq = Number(r.dataset.seq);
    const inBuffer = seq >= buf.firstSeq && seq <= buf.lastSeq;
    if (!inBuffer && r.style.display !== 'none') {
      throw new Error(
        `${ctx}: INV3 violated — seq ${seq} outside buffer ` +
          `[${buf.firstSeq}..${buf.lastSeq}] but not parked ` +
          `(display='${r.style.display}').`,
      );
    }
  }

  // INV4: spacers non-negative; empty buffer → both 0.
  const [headPx, tailPx] = spacerHeights(container);
  if (headPx < 0 || tailPx < 0) {
    throw new Error(`${ctx}: INV4 violated — negative spacer heights ${headPx}/${tailPx}.`);
  }
  if (buf.length === 0 && (headPx !== 0 || tailPx !== 0)) {
    throw new Error(`${ctx}: INV4 violated — empty buffer but spacers ${headPx}/${tailPx}.`);
  }
  // Spacer/row consistency: head spacer + rows must not imply lost flow space.
  // (Cheap structural check: head spacer is a multiple of rowHeight.)
  if (headPx % ROW_HEIGHT !== 0 || tailPx % ROW_HEIGHT !== 0) {
    throw new Error(
      `${ctx}: INV4 violated — spacers not row-aligned: head ${headPx}, tail ${tailPx}.`,
    );
  }

  // INV5: data-seq present and unique across all layer rows.
  const seqs = all.map((r) => r.dataset.seq);
  if (seqs.some((s) => s === undefined || s === null || !Number.isFinite(Number(s)))) {
    throw new Error(`${ctx}: INV5 violated — row without a valid data-seq.`);
  }
  if (new Set(seqs).size !== seqs.length) {
    const dupes = seqs.filter((s, i) => seqs.indexOf(s) !== i);
    throw new Error(`${ctx}: INV5 violated — duplicate data-seq: ${dupes.join(',')}.`);
  }
  // Layer height is never inline-set in flow layout.
  if (layer.style.height !== '') {
    throw new Error(`${ctx}: INV5 violated — layer.style.height was set inline.`);
  }

  // Structural sanity: empty buffer must also mean zero rows.
  if (buf.length === 0 && all.length !== 0) {
    throw new Error(`${ctx}: INV5 violated — empty buffer but ${all.length} rows in DOM.`);
  }

  // Filter-mode consistency: with a filter list active, every visible seq is
  // a member of the surviving list (pinned parked rows are exempt).
  if (view.visibleSeqs !== null) {
    const set = new Set(view.visibleSeqs);
    for (const r of visible) {
      if (!set.has(Number(r.dataset.seq))) {
        throw new Error(
          `${ctx}: INV-filter violated — visible seq ${r.dataset.seq} not in ` +
            `the filter list.`,
        );
      }
    }
  }
}

// ==================== Soak ====================

describe('TerminalRenderer soak invariants (issue #18 flow + pins)', () => {
  it('holds all structural invariants across 300 randomized ops', () => {
    const rng = mulberry32(0xc0ffee);
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientHeight', { value: CLIENT_HEIGHT, configurable: true });
    document.body.appendChild(container);
    const renderer = new TerminalRenderer(makeConfig());
    renderer.attachToContainer(container);

    // Trim storm: small random maxLines with continuous appends.
    const buf = new TerminalBuffer({ maxLines: 50 + Math.floor(rng() * 500) });
    let nextContent = 0;
    const view = identityView();
    let filterList: number[] | null = null;
    let opCount = 0;

    const render = (why: string) => {
      if (filterList !== null) {
        view.visibleSeqs = filterList;
        view.visibleSeqsOffset = 0;
      } else {
        view.visibleSeqs = null;
      }
      renderer.render(buf, view);
      assertInvariants(
        container,
        buf,
        view,
        `op#${opCount} (${why}) maxLines=${buf.maxLines} buffer=[${buf.firstSeq}..${buf.lastSeq}]`,
      );
    };

    for (let iter = 0; iter < ITERATIONS; iter++) {
      opCount = iter + 1;
      const roll = rng();

      if (roll < 0.38) {
        // Append 1..500 lines.
        const n = 1 + Math.floor(rng() * 500);
        for (let i = 0; i < n; i++) buf.append(makeLine(`s${nextContent++}`));
        render(`append ${n}`);
      } else if (roll < 0.55) {
        // Random scroll jump (follow off while jumping).
        view.followEnabled = false;
        const maxTop = Math.max(0, (buf.lastSeq - buf.firstSeq + 1) * ROW_HEIGHT);
        container.scrollTop = Math.floor(rng() * (maxTop + 1));
        render(`scroll ${container.scrollTop}`);
      } else if (roll < 0.62) {
        // Follow re-engage.
        view.followEnabled = true;
        view.locked = true;
        render('follow on');
      } else if (roll < 0.7) {
        // Filter toggle: identity vs a survival subset.
        if (filterList === null && buf.length > 10) {
          const step = 1 + Math.floor(rng() * 4);
          filterList = [];
          for (let s = buf.firstSeq; s <= buf.lastSeq; s += step) filterList.push(s);
        } else {
          filterList = null;
        }
        renderer.bumpFilterVersion();
        render(filterList === null ? 'filter off' : `filter 1-in-${filterList.length}`);
      } else if (roll < 0.76) {
        // Full redraw via invalidate().
        renderer.invalidate();
        render('invalidate');
      } else if (roll < 0.86) {
        // Trim storm: shrink or grow capacity mid-stream.
        const newMax = 50 + Math.floor(rng() * 2000);
        buf.setLimits({ maxLines: newMax });
        render(`setLimits ${newMax}`);
      } else if (roll < 0.94 && buf.length > 30) {
        // Occasional live selection over current DOM rows.
        const els = rows(container).filter((r) => r.style.display !== 'none');
        if (els.length >= 4) {
          const i = Math.floor(rng() * (els.length - 3));
          const a = Number(els[i].dataset.seq);
          const b = Number(els[i + 3].dataset.seq);
          const sel = window.getSelection()!;
          sel.removeAllRanges();
          const range = document.createRange();
          range.setStart(els[i].firstChild!, 0);
          range.setEnd(els[i + 3].firstChild!, 0);
          sel.addRange(range);
          render(`select ${a}..${b}`);
        }
      } else if (roll < 0.97) {
        // Clear selection (fire the event jsdom never dispatches).
        window.getSelection()!.removeAllRanges();
        document.dispatchEvent(new Event('selectionchange'));
        render('deselect');
      } else {
        // Clear.
        buf.clear();
        renderer.clear();
        filterList = null;
        view.followEnabled = true;
        container.scrollTop = 0;
        render('clear');
      }
    }

    // Final steady-state check.
    render('final');
    renderer.dispose();
    expect(true).toBe(true);
  });

  it('holds invariants with a persistent live selection across appends and trims', () => {
    const rng = mulberry32(0xfeedbeef);
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientHeight', { value: CLIENT_HEIGHT, configurable: true });
    document.body.appendChild(container);
    const renderer = new TerminalRenderer(makeConfig());
    renderer.attachToContainer(container);

    const buf = new TerminalBuffer({ maxLines: 80 });
    for (let i = 0; i < 80; i++) buf.append(makeLine(`p${i}`));

    const view = identityView({ followEnabled: false });
    container.scrollTop = 0;
    renderer.render(buf, view);

    // Pin rows 4..9.
    const els = rows(container).filter((r) => r.style.display !== 'none');
    const a = els.find((r) => Number(r.dataset.seq) === 4)!;
    const b = els.find((r) => Number(r.dataset.seq) === 9)!;
    const sel = window.getSelection()!;
    sel.removeAllRanges(); // drop any range left over from the previous test
    const range = document.createRange();
    range.setStart(a.firstChild!, 0);
    range.setEnd(b.firstChild!, 0);
    sel.addRange(range);
    renderer.render(buf, view); // syncPins
    expect(renderer.pinnedCount()).toBe(6);


    // Stream data with continuous trims; the pinned span gets head-trimmed
    // out of the buffer — rows must park (never re-parent, never rewritten)
    // and invariants must keep holding.
    let next = 80;
    for (let i = 0; i < 60; i++) {
      const n = 1 + Math.floor(rng() * 20);
      for (let k = 0; k < n; k++) buf.append(makeLine(`t${next++}`));
      if (rng() < 0.4) {
        const top = Math.floor(rng() * Math.max(1, buf.length * ROW_HEIGHT));
        container.scrollTop = top;
      }
      renderer.render(buf, view);
      assertInvariants(
        container,
        buf,
        view,
        `pin-soak#${i} buffer=[${buf.firstSeq}..${buf.lastSeq}] top=${container.scrollTop}`,
      );
      // Pinned rows that survive stay in the DOM with node identity.
      if (4 >= buf.firstSeq) {
        const parked = container.querySelector('[data-seq="4"]') as HTMLElement | null;
        expect(parked).not.toBeNull();
        expect(parked!.style.display).toBe('none');
      }
    }

    // Selection clears → everything recycles.
    sel.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
    renderer.render(buf, view);
    assertInvariants(container, buf, view, 'pin-soak final');
    expect(container.querySelector('[data-seq="4"]')).toBeNull();
    renderer.dispose();
  });
});
