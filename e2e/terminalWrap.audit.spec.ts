import { expect, test } from '@playwright/test';

// Isolated renderer harness: no application IPC mock, no production algorithm
// reproduced here. Vite serves the actual modules and terminal CSS. Playwright
// owns the configured server lifecycle.
test.beforeEach(async ({ page }) => {
  await page.route('http://localhost:1420/', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head></head><body></body></html>' }));
  await page.goto('/');
  await page.addStyleTag({ url: '/src/styles/terminal-view.css' });
  await page.addStyleTag({ content: ':root { --space-2:4px; --space-3:6px; --space-6:24px; --font-size-terminal:14px; --weight-semibold:600 } * { box-sizing:border-box }' });
});

test('audit: reported center/end anchors agree with actual rows during compressed scrolling', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const root = '/src/';
    const { TerminalRenderer } = await import(root + 'utils/terminal/TerminalRenderer.ts');
    const samples = [];
    for (const count of [600, 1_000_000]) {
      const container = document.createElement('div'); container.className = 'terminal-view';
      Object.assign(container.style, { position: 'fixed', top: '0', left: '0', width: '360px', height: '240px', font: '14px monospace' }); document.body.append(container);
      const source = { length: count, firstSeq: 0, lastSeq: count - 1, getBySeq: (seq: number) => ({ timestamp: seq, direction: 'RX', content: `${seq}:` + 'word '.repeat(seq % 7 === 0 ? 80 : 9), isHex: false }), snapshot: () => { throw new Error('history scan'); } };
      const renderer = new TerminalRenderer({ rowHeight: 21, wordWrap: true, showTimestamp: false, displayFormat: 'string', encoding: 'UTF-8', timestampFormat: 'absolute', timestampMode: 'perLine', connectedAt: null, highlightRuleSets: [] });
      renderer.attachToContainer(container);
      const view = { visibleSeqs: null, visibleSeqsOffset: 0, frozenSeq: null, matchSet: null, currentMatchSeq: -1, searchQuery: '', searchCaseSensitive: false, selectedRange: null, locked: false, gestureActive: true, followEnabled: false };
      try {
        renderer.render(source, view);
        for (const fraction of [0, .2, .5, .8, 1, .6, .1]) {
          container.scrollTop = (container.scrollHeight - container.clientHeight) * fraction;
          for (let i = 0; i < 5; i++) renderer.render(source, view);
          const cr = container.getBoundingClientRect();
          const rows = [...container.querySelectorAll<HTMLElement>('.terminal-line')].filter(row => row.style.display !== 'none');
          for (const align of ['center', 'end'] as const) {
            const y = cr.top + (align === 'center' ? container.clientHeight / 2 : container.clientHeight - 1);
            const actual = rows.find(row => { const r = row.getBoundingClientRect(); return r.top <= y && r.bottom > y; });
            if (actual) samples.push({ count, fraction, align, actual: Number(actual.dataset.seq), reported: renderer.readGeometryAnchor(source, view, align)?.seq });
          }
        }
      } finally { renderer.dispose(); container.remove(); }
    }
    return samples;
  });
  expect(result.length).toBeGreaterThan(15);
  for (const sample of result) expect(sample.reported, JSON.stringify(sample)).toBe(sample.actual);
});

test('audit: filtered compaction preserves a paused intra-record anchor and split-highlight search reveals its mark', async ({ page }) => {
  const sample = await page.evaluate(async () => {
    const root = '/src/';
    const { TerminalBuffer } = await import(root + 'utils/terminal/TerminalBuffer.ts');
    const { TerminalRenderer } = await import(root + 'utils/terminal/TerminalRenderer.ts');
    const container = document.createElement('div'); container.className = 'terminal-view';
    Object.assign(container.style, { position: 'fixed', top: '0', left: '0', width: '260px', height: '240px', font: '14px monospace' }); document.body.append(container);
    const source = new TerminalBuffer({ maxLines: 500 });
    const query = 'α🙂 needle中';
    for (let i = 0; i < 500; i++) source.append({ timestamp: i, direction: 'RX', rawData: new TextEncoder().encode(`${i}:` + 'prefix '.repeat(150) + query + '\r\nTAIL'), isHex: false });
    const renderer = new TerminalRenderer({ rowHeight: 21, wordWrap: true, showTimestamp: true, displayFormat: 'string', encoding: 'UTF-8', timestampFormat: 'absolute', timestampMode: 'perLine', connectedAt: null, highlightRuleSets: [{ id: 'audit', isEnabled: true, rules: [{ id: 'r', pattern: 'needle', isRegex: false, color: '#ff0000', bold: true }] }] }); renderer.attachToContainer(container);
    const seqs = Array.from({ length: 250 }, (_, i) => i * 2);
    let view = { visibleSeqs: seqs, visibleSeqsOffset: 20, frozenSeq: 300 as number | null, matchSet: null as Set<number> | null, currentMatchSeq: -1, searchQuery: '', searchCaseSensitive: false, selectedRange: null, locked: true, gestureActive: false, followEnabled: true };
    try {
      renderer.render(source, view); renderer.scrollToSeq(200, 'start', source, view);
      container.scrollTop += 63; renderer.render(source, view);
      const before = renderer.readGeometryAnchor(source, view, 'start');
      seqs.splice(0, 20); view = { ...view, visibleSeqsOffset: 0 }; renderer.bumpFilterVersion();
      for (let i = 0; i < 3; i++) renderer.render(source, view);
      const after = renderer.readGeometryAnchor(source, view, 'start');
      view = { ...view, followEnabled: false, searchQuery: query, matchSet: new Set([200]), currentMatchSeq: 200 };
      renderer.scrollToSeq(200, 'center', source, view, true);
      for (let i = 0; i < 3; i++) renderer.render(source, view);
      const marks = [...container.querySelectorAll<HTMLElement>('[data-seq="200"] .terminal-search-mark')];
      const cr = container.getBoundingClientRect(), rect = marks[0]?.getClientRects()[0];
      const visible = !!rect && rect.top >= cr.top && rect.bottom <= cr.bottom;
      return { before, after, visible, markText: marks.map(mark => mark.textContent).join(''), count: marks.length, retainedRaw: source.getBySeq(200)!.rawData!.length, bufferedText: source.getBySeq(200)!.content };
    } finally { renderer.dispose(); container.remove(); }
  });
  expect(sample.before).toMatchObject({ seq: 200, offsetPx: 63 });
  expect(sample.after).toMatchObject({ seq: 200, offsetPx: 63 });
  expect(sample.count).toBeGreaterThan(1);
  expect(sample.markText).toBe('α🙂 needle中'); expect(sample.visible).toBe(true);
  expect(sample.retainedRaw).toBeGreaterThan(1000); expect(sample.bufferedText).toBeUndefined();
});

for (const change of ['width', 'font'] as const) {
test(`audit: near-tail ${change} reflow preserves the reading record rather than accepting native clamp as a gesture`, async ({ page }) => {
  const samples = await page.evaluate(async change => {
    const root = '/src/';
    const { TerminalBuffer } = await import(root + 'utils/terminal/TerminalBuffer.ts');
    const { TerminalRenderer } = await import(root + 'utils/terminal/TerminalRenderer.ts');
    const container = document.createElement('div'); container.className = 'terminal-view';
    Object.assign(container.style, { position: 'fixed', top: '0', left: '0', width: '180px', height: '240px', font: '14px monospace' }); document.body.append(container);
    const source = new TerminalBuffer({ maxLines: 300 });
    for (let i = 0; i < 300; i++) source.append({ timestamp: i, direction: 'RX', content: `${i}:` + 'word '.repeat(i >= 290 ? 600 : 20), isHex: false });
    const renderer = new TerminalRenderer({ rowHeight: 21, wordWrap: true, showTimestamp: false, displayFormat: 'string', encoding: 'UTF-8', timestampFormat: 'absolute', timestampMode: 'perLine', connectedAt: null, highlightRuleSets: [] }); renderer.attachToContainer(container);
    const view = { visibleSeqs: null, visibleSeqsOffset: 0, frozenSeq: null, matchSet: null, currentMatchSeq: -1, searchQuery: '', searchCaseSensitive: false, selectedRange: null, locked: false, gestureActive: false, followEnabled: false };
    const samples = [];
    try {
      renderer.render(source, view);
      for (const target of [295, 299]) {
        container.style.width = '180px'; container.style.fontSize = '14px';
        renderer.updateConfig({ rowHeight: 21 }); renderer.render(source, view);
        renderer.scrollToSeq(target, 'start', source, view); container.scrollTop += 84; renderer.render(source, view);
        const before = renderer.readGeometryAnchor(source, view, 'start');
        const beforeTop = container.scrollTop, beforeHeight = container.scrollHeight;
        const beforeTarget = container.querySelector<HTMLElement>(`[data-seq="${target}"]`)!;
        const beforeActualOffset = container.getBoundingClientRect().top - beforeTarget.getBoundingClientRect().top;
        if (change === 'width') container.style.width = '1000px';
        else {
          container.style.fontSize = '8px';
          renderer.updateConfig({ rowHeight: 12 });
        }
        // Force the same real layout that a ResizeObserver sees before render.
        const nativeTop = container.scrollTop, nativeHeight = container.scrollHeight;
        for (let i = 0; i < 5; i++) renderer.render(source, view);
        const after = renderer.readGeometryAnchor(source, view, 'start');
        const y = container.getBoundingClientRect().top + 1;
        const actual = [...container.querySelectorAll<HTMLElement>('.terminal-line')].find(row => {
          const rect = row.getBoundingClientRect(); return rect.top <= y && rect.bottom > y;
        });
        const targetHeight = container.querySelector<HTMLElement>(`[data-seq="${target}"]`)?.offsetHeight;
        samples.push({ target, beforeTop, beforeHeight, beforeActualOffset, nativeTop, nativeHeight, before, after, actual: actual?.dataset.seq, actualOffset: actual ? y - 1 - actual.getBoundingClientRect().top : null, targetHeight });
      }
    } finally { renderer.dispose(); container.remove(); }
    return samples;
  }, change);
  await test.info().attach('near-tail-reflow.json', { body: JSON.stringify(samples, null, 2), contentType: 'application/json' });
  expect(samples.some(sample => sample.nativeTop < sample.beforeTop), 'exercise actual browser scrollTop clamping').toBe(true);
  for (const sample of samples) {
    expect(Number(sample.actual), JSON.stringify(sample)).toBe(sample.target);
    expect(Math.abs((sample.actualOffset ?? Infinity) - sample.beforeActualOffset), JSON.stringify(sample)).toBeLessThanOrEqual(2);
    expect(sample.after?.seq, JSON.stringify(sample)).toBe(sample.before?.seq);
    expect(sample.after?.offsetPx, JSON.stringify(sample)).toBeCloseTo(sample.before?.offsetPx ?? 0, 0);
    expect((sample.targetHeight ?? 0) - (sample.before?.offsetPx ?? Infinity), 'the original point fits in the new viewport').toBeGreaterThanOrEqual(240);
  }
});
}
