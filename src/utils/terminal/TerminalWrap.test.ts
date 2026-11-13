// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalBuffer } from './TerminalBuffer';
import { TerminalRenderer, type RendererConfig, type TerminalViewState } from './TerminalRenderer';
import type { TerminalSource } from './TerminalSource';
import '../../styles/terminal-view.css';

const config: RendererConfig = { rowHeight: 18, wordWrap: true, showTimestamp: false, displayFormat: 'string', encoding: 'UTF-8', timestampFormat: 'absolute', timestampMode: 'perLine', highlightRuleSets: [], connectedAt: null };
const view = (patch: Partial<TerminalViewState> = {}): TerminalViewState => ({ visibleSeqs: null, visibleSeqsOffset: 0, frozenSeq: null, matchSet: null, currentMatchSeq: -1, searchQuery: '', searchCaseSensitive: false, selectedRange: null, locked: false, gestureActive: false, followEnabled: false, ...patch });
const line = (i: number) => ({ timestamp: i, direction: 'RX' as const, content: `${i}:` + 'x'.repeat(i % 3 ? 10 : 200), isHex: false });
let buffer: TerminalBuffer, renderer: TerminalRenderer, container: HTMLDivElement, width: number, columns: number, reads: number;
function render(v = view()) { renderer.render(buffer, v); }
function top(v = view()) { return renderer.readGeometryAnchor(buffer, v, 'start'); }
beforeEach(() => {
  window.getSelection()?.removeAllRanges();
  width = 300; columns = 20; reads = 0;
  container = document.createElement('div'); container.className = 'terminal-view';
  container.style.padding = '0px';
  Object.defineProperties(container, {
    clientWidth: { get: () => width }, clientHeight: { get: () => 180 },
    scrollHeight: { get: () => [...container.querySelector('.terminal-content-layer')!.children].reduce((sum, node) => sum + ((node as HTMLElement).style.display === 'none' ? 0 : node.classList.contains('terminal-line') ? (node as HTMLElement).offsetHeight : parseFloat((node as HTMLElement).style.height) || 0), 0) },
  });
  document.body.append(container);
  // jsdom has no layout. Supply deterministic measured record heights; real CSS
  // wrapping/rectangles/selection serialization are covered in Playwright.
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    if (!this.classList.contains('terminal-line')) return 180;
    reads++;
    return Math.max(18, Math.ceil((this.querySelector('.terminal-content')?.textContent?.length ?? 0) / columns) * 18);
  });
  buffer = new TerminalBuffer({ maxLines: 100 });
  for (let i = 0; i < 100; i++) buffer.append(line(i));
  renderer = new TerminalRenderer({ ...config }); renderer.attachToContainer(container);
});
afterEach(() => { renderer.dispose(); container.remove(); vi.restoreAllMocks(); window.getSelection()?.removeAllRanges(); });

describe('optional terminal soft wrap', () => {
  it('keeps fixed/HEX paths measurement-free and restores the text preference', () => {
    renderer.updateConfig({ wordWrap: false }); render();
    expect(reads).toBe(0); expect(container.classList.contains('terminal-word-wrap')).toBe(false);
    renderer.updateConfig({ wordWrap: true, displayFormat: 'hex' }); render();
    expect(reads).toBe(0); expect(container.classList.contains('terminal-word-wrap')).toBe(false);
    renderer.updateConfig({ displayFormat: 'string' }); render();
    expect(reads).toBeGreaterThan(0); expect(container.classList.contains('terminal-word-wrap')).toBe(true);
    expect(container.querySelector<HTMLElement>('.terminal-line')!.style.height).toBe('');
  });
  it('measures only changed window rows and never modifies buffered text', () => {
    const original = buffer.getBySeq(0)!.content;
    render(); const initial = reads; render();
    expect(reads).toBe(initial);
    expect(buffer.getBySeq(0)!.content).toBe(original);
    expect(container.querySelectorAll('.terminal-line').length).toBeLessThan(40);
    expect(container.querySelector('.terminal-content')!.textContent).toBe(original);
  });
  it('preserves a record and intra-record anchor through resize, font and rolling trim', () => {
    render(); renderer.scrollToSeq(60, 'start', buffer, view());
    container.scrollTop += 72; render();
    expect(top()).toMatchObject({ seq: 60, offsetPx: 72 });
    width = 200; columns = 12; render();
    expect(top()).toMatchObject({ seq: 60, offsetPx: 72 });
    renderer.updateConfig({ fontFamily: 'serif' }); render();
    expect(top()).toMatchObject({ seq: 60, offsetPx: 72 });
    for (let i = 100; i < 120; i++) buffer.append(line(i));
    render(); expect(top()).toMatchObject({ seq: 60, offsetPx: 72 });
  });
  it('handles filtered offsets, in-place compaction, empty results and frozen follow', () => {
    const seqs = Array.from({ length: 50 }, (_, i) => i * 2);
    let v = view({ visibleSeqs: seqs }); render(v);
    renderer.scrollToSeq(60, 'start', buffer, v); expect(top(v)?.seq).toBe(60);
    v = { ...v, visibleSeqsOffset: 5 }; render(v); expect(top(v)?.seq).toBe(60);
    seqs.splice(0, 5); v = { ...v, visibleSeqsOffset: 0 }; render(v); expect(top(v)?.seq).toBe(60);
    v = { ...v, frozenSeq: 70, followEnabled: true }; render(v); expect(top(v)?.seq).toBe(60);
    v = { ...v, visibleSeqs: [] }; render(v);
    expect(top(v)).toBeNull(); expect(container.querySelectorAll('.terminal-line').length).toBe(0);
    expect([...container.querySelector('.terminal-content-layer')!.children].every(n => (n as HTMLElement).style.height === '0px')).toBe(true);
  });
  it('preserves native Range text nodes during resize and streams, including parked pins', () => {
    render();
    const node = container.querySelector('[data-seq="0"] .terminal-content')!;
    const range = document.createRange(); range.selectNodeContents(node);
    const selection = window.getSelection()!; selection.addRange(range);
    const text = selection.toString(), textNode = node.firstChild;
    width = 180; columns = 10; renderer.updateConfig({ showTimestamp: true }); render();
    expect(node.firstChild).toBe(textNode); expect(selection.toString()).toBe(text);
    renderer.scrollToSeq(80, 'start', buffer, view());
    expect(container.querySelector('[data-seq="0"]')).not.toBeNull();
    expect(selection.toString()).toBe(text);
    selection.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')); render();
    expect(container.querySelector('[data-seq="0"]')).toBeNull();
  });
  it('defers pinned content updates until selection clears instead of losing them between layout passes', () => {
    render();
    const node = container.querySelector('[data-seq="0"] .terminal-content')!;
    const range = document.createRange(); range.selectNodeContents(node);
    window.getSelection()!.addRange(range);
    renderer.updateConfig({ showTimestamp: true }); render();
    expect(container.querySelector('[data-seq="0"] .terminal-timestamp')).toBeNull();
    window.getSelection()!.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')); render();
    expect(container.querySelector('[data-seq="0"] .terminal-timestamp')).not.toBeNull();
  });
  it('retires a queued seek when detached, keeping the established reading anchor', () => {
    render(); renderer.scrollToSeq(60, 'start', buffer, view());
    renderer.positionToSeq(90, 'start', buffer, view());
    renderer.detach(); renderer.attachToContainer(container); render();
    expect(top()?.seq).toBe(60);
  });
  it('does not measure hidden tabs and resumes on reveal without losing the anchor', () => {
    render(); renderer.scrollToSeq(60, 'start', buffer, view());
    width = 0; const before = reads; render(); expect(reads).toBe(before);
    width = 300; render(); expect(top()?.seq).toBe(60);
    renderer.detach(); renderer.attachToContainer(container); render(); expect(top()?.seq).toBe(60);
  });
  it('only visits window records for million-row sources and uses bounded physical heights', () => {
    let visits = 0;
    const source: TerminalSource = { length: 1_000_000, firstSeq: 0, lastSeq: 999_999,
      getBySeq: seq => { visits++; return line(seq); }, snapshot: () => { throw new Error('history scan'); } };
    const v = view(); renderer.render(source, v);
    for (const seq of [0, 500_000, 999_999]) {
      renderer.scrollToSeq(seq, seq === 999_999 ? 'end' : 'start', source, v);
      expect(container.querySelector(`[data-seq="${seq}"]`)).not.toBeNull();
      expect(renderer.readGeometryAnchor(source, v, seq === 999_999 ? 'end' : 'start')?.seq).toBe(seq);
    }
    expect(visits).toBeLessThan(1000);
    expect(container.scrollHeight).toBeLessThanOrEqual(8_000_001);
  });
});
