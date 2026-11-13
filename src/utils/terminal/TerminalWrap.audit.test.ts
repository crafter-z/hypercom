// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalBuffer } from './TerminalBuffer';
import { TerminalRenderer, type RendererConfig, type TerminalViewState } from './TerminalRenderer';

const config: RendererConfig = { rowHeight: 20, wordWrap: true, showTimestamp: false, displayFormat: 'string', encoding: 'UTF-8', timestampFormat: 'absolute', timestampMode: 'perLine', highlightRuleSets: [], connectedAt: null };
const view = (patch: Partial<TerminalViewState> = {}): TerminalViewState => ({ visibleSeqs: null, visibleSeqsOffset: 0, frozenSeq: null, matchSet: null, currentMatchSeq: -1, searchQuery: '', searchCaseSensitive: false, selectedRange: null, locked: false, gestureActive: false, followEnabled: false, ...patch });
let container: HTMLDivElement, renderer: TerminalRenderer, buffer: TerminalBuffer;
let width: number, reads: number, tall: number;
const append = (target: TerminalBuffer, from: number, count: number) => {
  for (let i = from; i < from + count; i++) target.append({ timestamp: i, direction: 'RX', content: `record-${i}`, isHex: false });
};
const anchor = (v = view()) => renderer.readGeometryAnchor(buffer, v, 'start');
const render = (v = view()) => renderer.render(buffer, v);
const seqs = () => [...container.querySelectorAll<HTMLElement>('.terminal-line')].filter(row => row.style.display !== 'none').map(row => Number(row.dataset.seq));
beforeEach(() => {
  window.getSelection()?.removeAllRanges(); width = 400; reads = 0; tall = 160;
  container = document.createElement('div'); container.style.padding = '0px';
  Object.defineProperties(container, { clientWidth: { get: () => width }, clientHeight: { get: () => 100 } });
  document.body.append(container);
  // These are external measurement samples, not a text-width/production layout oracle.
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    if (!this.classList.contains('terminal-line')) return 100;
    reads++;
    return Number(this.dataset.seq) % 5 === 0 ? tall : 20;
  });
  buffer = new TerminalBuffer({ maxLines: 200 }); append(buffer, 0, 200);
  renderer = new TerminalRenderer({ ...config }); renderer.attachToContainer(container);
});
afterEach(() => { window.getSelection()?.removeAllRanges(); renderer.dispose(); container.remove(); vi.restoreAllMocks(); });

describe('TerminalWrap independent lifecycle audit', () => {
  it('preserves nonzero intra-record offsets across fresh-container attach and wrap/fixed/wrap', () => {
    render(); renderer.scrollToSeq(100, 'start', buffer, view()); container.scrollTop += 60; render();
    expect(anchor()).toMatchObject({ seq: 100, offsetPx: 60 });
    const next = document.createElement('div');
    Object.defineProperties(next, { clientWidth: { get: () => width }, clientHeight: { get: () => 100 } });
    next.style.padding = '0px'; document.body.append(next);
    renderer.detach(); container.remove(); container = next; renderer.attachToContainer(container); render();
    expect(anchor()).toMatchObject({ seq: 100, offsetPx: 60 });
    renderer.updateConfig({ wordWrap: false }); render(); const fixedReads = reads; render();
    expect(reads).toBe(fixedReads);
    expect(anchor()?.seq).toBe(100);
    renderer.updateConfig({ wordWrap: true }); render(); expect(anchor()?.seq).toBe(100);
  });

  it('does not resurrect stale geometry or queued seeks after clear and replacement', () => {
    render(); renderer.scrollToSeq(150, 'start', buffer, view());
    renderer.positionToSeq(190, 'center', buffer, view());
    renderer.clear(); buffer.clear(); append(buffer, 200, 8); render();
    // jsdom does not clamp scrollTop when clear removes all DOM height.
    // Assert source/seek retirement here; real browser clamping is separate.
    expect(anchor()?.seq).toBeGreaterThanOrEqual(buffer.firstSeq);
    expect(anchor()?.seq).toBeLessThanOrEqual(buffer.lastSeq);
    expect(seqs().every(seq => seq >= buffer.firstSeq && seq <= buffer.lastSeq)).toBe(true);
    const replacement = new TerminalBuffer({ maxLines: 30 }); append(replacement, 0, 30);
    tall = 40; renderer.invalidate(); buffer = replacement; render();
    expect(anchor()?.seq).toBeGreaterThanOrEqual(replacement.firstSeq);
    expect(anchor()?.seq).toBeLessThanOrEqual(replacement.lastSeq);
    expect(seqs().every(seq => seq >= 0 && seq < 30)).toBe(true);
    expect(container.querySelectorAll('[data-seq="190"]').length).toBe(0);
    renderer.scrollToSeq(0, 'start', buffer, view()); expect(anchor()?.seq).toBe(0);
  });

  it('cancels queued seeks even when a replacement source reuses the requested sequence key', () => {
    render(); renderer.positionToSeq(190, 'start', buffer, view());
    renderer.clear();
    buffer = new TerminalBuffer({ maxLines: 200 }); append(buffer, 0, 200); tall = 40;
    render(); expect(anchor()?.seq).toBe(0);
    renderer.positionToSeq(150, 'center', buffer, view()); renderer.invalidate(); render();
    expect(anchor()?.seq).toBe(0);
  });

  it('bounds visible records by both filtered offset and frozen sequence after rolling trim', () => {
    const filtered = Array.from({ length: 100 }, (_, i) => i * 2);
    let v = view({ visibleSeqs: filtered, visibleSeqsOffset: 20, frozenSeq: 120, followEnabled: true });
    render(v); renderer.scrollToSeq(100, 'start', buffer, v);
    expect(anchor(v)?.seq).toBe(100);
    append(buffer, 200, 50); v = { ...v, visibleSeqsOffset: 25 }; render(v);
    expect(anchor(v)?.seq).toBe(100);
    expect(seqs().every(seq => seq >= 50 && seq <= 120 && seq % 2 === 0)).toBe(true);
    filtered.splice(0, 25); v = { ...v, visibleSeqsOffset: 0 }; renderer.bumpFilterVersion(); render(v);
    expect(anchor(v)?.seq).toBe(100);
    expect(new Set(seqs()).size).toBe(seqs().length);
    v = { ...v, frozenSeq: 49 }; render(v);
    expect(anchor(v)).toBeNull(); expect(seqs()).toEqual([]);
    v = { ...v, frozenSeq: null, followEnabled: false }; render(v);
    expect(seqs().length).toBeGreaterThan(0);
    expect(seqs().every(seq => seq >= 50 && seq % 2 === 0)).toBe(true);
    renderer.scrollToSeq(50, 'start', buffer, v); expect(anchor(v)?.seq).toBe(50);
  });

  it('remeasures deferred selected text after several config changes, without changing its text node', () => {
    render(); const row = container.querySelector<HTMLElement>('[data-seq="0"]')!;
    const content = row.querySelector('.terminal-content')!, textNode = content.firstChild;
    const range = document.createRange(); range.selectNodeContents(content); window.getSelection()!.addRange(range);
    renderer.updateConfig({ showTimestamp: true }); render();
    renderer.updateConfig({ displayFormat: 'hex' }); render();
    renderer.updateConfig({ displayFormat: 'string', encoding: 'ASCII' }); render(); render();
    expect(content.firstChild).toBe(textNode); expect(row.querySelector('.terminal-timestamp')).toBeNull();
    window.getSelection()!.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')); render();
    expect(row.querySelector('.terminal-timestamp')).not.toBeNull();
    expect(row.querySelector('.terminal-content')!.textContent).toBe('record-0');
  });

  it.each(['width', 'config'] as const)('does not reinterpret native scrollTop clamping during %s reflow', change => {
    render(); renderer.scrollToSeq(100, 'start', buffer, view());
    container.scrollTop += 60; render();
    expect(anchor()).toMatchObject({ seq: 100, offsetPx: 60 });
    if (change === 'width') width = 700;
    else renderer.updateConfig({ fontFamily: 'serif' });
    // jsdom does not implement native clamping. Supply the changed scrollTop
    // observed by the real-browser resize regression, before the next render.
    container.scrollTop -= 140;
    render();
    expect(anchor()).toMatchObject({ seq: 100, offsetPx: 60 });
  });

  it('accepts a changed scrollTop under stable geometry and preserves it during later reflow', () => {
    render(); renderer.scrollToSeq(100, 'start', buffer, view());
    container.scrollTop += 60; render();
    expect(anchor()).toMatchObject({ seq: 100, offsetPx: 60 });
    container.scrollTop += 40; render(view({ gestureActive: true }));
    expect(anchor()).toMatchObject({ seq: 100, offsetPx: 100 });
    width = 700; render();
    expect(anchor()).toMatchObject({ seq: 100, offsetPx: 100 });
  });

  it('explicit seeks and live follow take precedence over the saved reflow anchor', () => {
    render(); renderer.scrollToSeq(100, 'start', buffer, view());
    container.scrollTop += 60; render();
    width = 700; container.scrollTop -= 140;
    renderer.scrollToSeq(150, 'start', buffer, view());
    expect(anchor()).toMatchObject({ seq: 150, offsetPx: 0 });
    width = 300; render(view({ followEnabled: true }));
    expect(renderer.readGeometryAnchor(buffer, view(), 'end')?.seq).toBe(buffer.lastSeq);
    const paused = view({ followEnabled: true, frozenSeq: buffer.lastSeq });
    const before = anchor(paused); width = 650; container.scrollTop -= 40; render(paused);
    expect(anchor(paused)).toMatchObject({ seq: before!.seq, offsetPx: before!.offsetPx });
  });

  it('keeps an established anchor while hidden even if the source is trimmed and width changes', () => {
    render(); renderer.scrollToSeq(100, 'start', buffer, view());
    width = 0; const before = reads; append(buffer, 200, 40); renderer.updateConfig({ showTimestamp: true }); render();
    expect(reads).toBe(before);
    width = 220; render(); expect(anchor()?.seq).toBe(100);
    expect(seqs().every(seq => seq >= buffer.firstSeq)).toBe(true);
  });
});
