import { expect, type Page } from '@playwright/test';

/** Real-browser layout probes; never use jsdom as proof of wrapping or FPS. */
export async function runTerminalWrapChecks(page: Page) {
  const result = await page.evaluate(async () => {
    const root = '/src/';
    const { TerminalBuffer } = await import(root + 'utils/terminal/TerminalBuffer.ts');
    const { TerminalRenderer } = await import(root + 'utils/terminal/TerminalRenderer.ts');
    const { selectionText } = await import(root + 'components/MainDisplay/terminalContextMenu.ts');
    const container = document.createElement('div'); container.className = 'terminal-view';
    Object.assign(container.style, { position: 'fixed', top: '0', left: '0', width: '420px', height: '260px', fontSize: '14px', lineHeight: '21px', fontFamily: 'Consolas, monospace', zIndex: '99999' });
    document.body.append(container);
    const buffer = new TerminalBuffer({ maxLines: 1000 });
    const text = (i: number) => i === 210 ? 'X'.repeat(12000) + ' needle-tail' : `${i}: 中英文🙂\t  ` + 'ABC 123 xyz '.repeat(i % 7 ? 10 : 320);
    for (let i = 0; i < 1000; i++) buffer.append({ timestamp: i, direction: i % 2 ? 'TX' : 'RX', content: text(i), isHex: false });
    const config = { rowHeight: 21, wordWrap: true, showTimestamp: true, displayFormat: 'string', encoding: 'UTF-8', timestampFormat: 'absolute', timestampMode: 'perLine', connectedAt: null, highlightRuleSets: [{ id: 'test', isEnabled: true, rules: [{ id: 'r', pattern: 'ABC', isRegex: false, color: '#ff0000', bold: true }] }] };
    const renderer = new TerminalRenderer(config); renderer.attachToContainer(container);
    let needed = true;
    renderer.onRenderNeeded = () => { needed = true; };
    let view = { visibleSeqs: null as number[] | null, visibleSeqsOffset: 0, frozenSeq: null as number | null, matchSet: null as Set<number> | null, currentMatchSeq: -1, searchQuery: '', searchCaseSensitive: false, selectedRange: null, locked: false, gestureActive: false, followEnabled: false };
    const render = () => { for (let i = 0; i < 6; i++) { needed = false; renderer.render(buffer, view); if (!needed) break; } };
    const anchor = () => renderer.readGeometryAnchor(buffer, view, 'start');
    const rows = () => [...container.querySelectorAll<HTMLElement>('.terminal-line')].filter(row => row.style.display !== 'none');
    const layout = () => {
      const list = rows();
      return { count: list.length, overflow: container.scrollWidth - container.clientWidth,
        overlap: list.slice(1).some((row, i) => row.getBoundingClientRect().top < list[i].getBoundingClientRect().bottom - 1),
        ordered: list.slice(1).every((row, i) => Number(row.dataset.seq) > Number(list[i].dataset.seq)),
        tall: list.some(row => row.offsetHeight > 21), height: container.scrollHeight };
    };
    try {
      render(); const initial = layout();
      renderer.scrollToSeq(120, 'start', buffer, view); render();
      const before = anchor();
      container.style.width = '260px'; render(); const narrow = anchor(), narrowLayout = layout();
      container.style.width = '150px'; render();
      const tinyLayout = layout(), tinyContentWidth = rows()[0].querySelector<HTMLElement>('.terminal-content')!.offsetWidth;
      container.style.width = '260px'; render();
      renderer.updateConfig({ fontFamily: 'Arial' }); container.style.fontFamily = 'Arial'; render(); const font = anchor();
      renderer.updateConfig({ showTimestamp: false }); render(); const timestamp = anchor();
      // One giant record: navigation must reveal the match, not merely the row.
      view = { ...view, searchQuery: 'needle-tail', matchSet: new Set([210]), currentMatchSeq: 210 };
      renderer.bumpFilterVersion();
      renderer.scrollToSeq(210, 'center', buffer, view, true); render();
      const mark = container.querySelector<HTMLElement>('.terminal-search-mark')!;
      const mr = mark.getBoundingClientRect(), cr = container.getBoundingClientRect();
      const matchVisible = mr.top >= cr.top && mr.bottom <= cr.bottom;
      const longLayout = layout();
      // Copy is the original text, with no synthetic newline from soft wraps.
      const content = container.querySelector('[data-seq="210"] .terminal-content')!;
      const selection = window.getSelection()!; selection.removeAllRanges();
      const range = document.createRange(); range.selectNodeContents(content); selection.addRange(range);
      const selectedText = selectionText(), firstChild = content.firstChild;
      container.style.width = '310px'; render();
      const selectionPreserved = content.firstChild === firstChild && selectionText() === selectedText;
      renderer.scrollToSeq(500, 'start', buffer, view); render();
      const parkedCopy = selectionText() === selectedText;
      selection.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')); render();
      const pinsReleased = !container.querySelector('[data-seq="210"]');
      view = { ...view, searchQuery: '', matchSet: null, currentMatchSeq: -1 };
      renderer.bumpFilterVersion(); renderer.scrollToSeq(500, 'start', buffer, view); render();
      const trimBefore = anchor();
      for (let i = 1000; i < 1200; i++) buffer.append({ timestamp: i, direction: 'RX', content: text(i), isHex: false });
      render(); const trimAfter = anchor();
      view = { ...view, followEnabled: true, frozenSeq: 600 }; render(); const paused = anchor();
      view = { ...view, frozenSeq: null }; render(); const bottom = Math.abs(container.scrollHeight - container.clientHeight - container.scrollTop);
      renderer.updateConfig({ displayFormat: 'hex' }); renderer.render(buffer, view);
      const hex = !container.classList.contains('terminal-word-wrap') && rows().every(row => row.style.height === '21px');
      renderer.updateConfig({ displayFormat: 'string', wordWrap: false }); renderer.render(buffer, view);
      const fixed = !container.classList.contains('terminal-word-wrap');
      return { initial, before, narrow, narrowLayout, tinyLayout, tinyContentWidth, font, timestamp, matchVisible, longLayout, copyExact: selectedText === text(210), selectionPreserved, parkedCopy, pinsReleased, trimBefore, trimAfter, paused, bottom, hex, fixed };
    } finally { window.getSelection()?.removeAllRanges(); renderer.dispose(); container.remove(); }
  });
  expect(result.initial.tall).toBe(true);
  expect(result.tinyContentWidth).toBeGreaterThan(10);
  for (const layout of [result.initial, result.narrowLayout, result.tinyLayout, result.longLayout]) {
    expect(layout.overlap, JSON.stringify(result)).toBe(false);
    expect(layout.overflow, JSON.stringify(result)).toBeLessThanOrEqual(1);
    expect(layout.ordered).toBe(true); expect(layout.count).toBeLessThan(70);
  }
  for (const anchor of [result.before, result.narrow, result.font, result.timestamp]) expect(anchor?.seq, JSON.stringify(result)).toBe(120);
  expect(result.matchVisible, JSON.stringify(result)).toBe(true);
  expect(result.copyExact).toBe(true); expect(result.selectionPreserved).toBe(true);
  expect(result.parkedCopy).toBe(true); expect(result.pinsReleased).toBe(true);
  expect(result.trimAfter?.seq, JSON.stringify(result)).toBe(result.trimBefore?.seq);
  expect(result.paused?.seq, JSON.stringify(result)).toBe(result.trimBefore?.seq);
  expect(result.bottom, JSON.stringify(result)).toBeLessThanOrEqual(1);
  expect(result.hex).toBe(true); expect(result.fixed).toBe(true);
}

export async function runMillionWrapChecks(page: Page) {
  const samples = await page.evaluate(async () => {
    const root = '/src/';
    const { TerminalRenderer } = await import(root + 'utils/terminal/TerminalRenderer.ts');
    const line = { timestamp: 1700000000000, direction: 'RX', content: '宽行🙂 ' + '0123456789 '.repeat(40), isHex: false };
    let visits = 0;
    const source = { length: 1_000_000, firstSeq: 0, lastSeq: 999_999, getBySeq: () => { visits++; return line; }, snapshot: () => { throw new Error('unexpected full history scan'); } };
    const results = [];
    for (const rowHeight of [12, 72]) for (const zoom of [.8, 2]) {
      const container = document.createElement('div'); container.className = 'terminal-view';
      Object.assign(container.style, { position: 'fixed', left: '0', top: '0', width: '500px', height: '360px', fontSize: `${rowHeight / 1.5}px`, lineHeight: `${rowHeight}px`, zoom: String(zoom), zIndex: '99999' });
      document.body.append(container);
      const renderer = new TerminalRenderer({ rowHeight, wordWrap: true, showTimestamp: false, displayFormat: 'string', encoding: 'UTF-8', timestampFormat: 'absolute', timestampMode: 'perLine', connectedAt: null, highlightRuleSets: [] });
      renderer.attachToContainer(container);
      const view = { visibleSeqs: null, visibleSeqsOffset: 0, frozenSeq: null, matchSet: null, currentMatchSeq: -1, searchQuery: '', searchCaseSensitive: false, selectedRange: null, locked: false, gestureActive: true, followEnabled: false };
      try {
        renderer.render(source, view);
        const positions = [];
        for (const fraction of [0, .25, .5, .75, 1]) {
          container.scrollTop = (container.scrollHeight - container.clientHeight) * fraction;
          for (let i = 0; i < 4; i++) renderer.render(source, view);
          const rows = [...container.querySelectorAll<HTMLElement>('.terminal-line')].filter(row => row.style.display !== 'none');
          positions.push({ first: Number(rows[0]?.dataset.seq), last: Number(rows[rows.length - 1]?.dataset.seq), count: rows.length, height: container.scrollHeight,
            overlap: rows.slice(1).some((row, i) => row.getBoundingClientRect().top < rows[i].getBoundingClientRect().bottom - .5) });
        }
        results.push({ rowHeight, zoom, positions });
      } finally { renderer.dispose(); container.remove(); }
    }
    return { results, visits };
  });
  for (const sample of samples.results) {
    expect(sample.positions[0].first, JSON.stringify(sample)).toBe(0);
    expect(sample.positions.at(-1)!.last, JSON.stringify(sample)).toBe(999_999);
    for (let i = 1; i < sample.positions.length; i++) expect(sample.positions[i].first, JSON.stringify(sample)).toBeGreaterThan(sample.positions[i - 1].first);
    for (const position of sample.positions) {
      expect(position.count).toBeGreaterThan(0); expect(position.count).toBeLessThan(70);
      expect(position.overlap).toBe(false); expect(position.height).toBeLessThanOrEqual(8_000_040);
    }
  }
  expect(samples.visits).toBeLessThan(10000);
}
