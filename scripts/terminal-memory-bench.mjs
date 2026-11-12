#!/usr/bin/env node
/** Opt-in retained-memory/CPU observations, not a CI timing assertion or WebView FPS claim.
 * node --expose-gc scripts/terminal-memory-bench.mjs --output node_modules/.cache/hypercom/terminal-current.json
 * --baseline-dir may contain committed copies of TerminalBuffer.ts,
 * TerminalTimeIndex.ts and viewportManager.ts, loaded under their original URLs.
 * Each sample runs in a fresh process, warms up first, and measures heap + arrayBuffers
 * after explicit GC. external is reported separately (it includes arrayBuffers).
 * Node >=22.15 is needed for registerHooks; installed TypeScript transpiles source.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const flags = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i];
  if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`);
  flags.set(key.slice(2), process.argv[i + 1]?.startsWith('--') || i + 1 === process.argv.length ? 'true' : process.argv[++i]);
}
const cases = [
  { kind: 'index', count: 100_000, clock: 'monotonic' },
  { kind: 'index', count: 1_000_000, clock: 'monotonic' },
  { kind: 'index', count: 100_000, clock: 'rollback' },
  { kind: 'index', count: 1_000_000, clock: 'rollback' },
  { kind: 'buffer', count: 100_000, bytes: 24 },
  { kind: 'buffer', count: 1_000_000, bytes: 24 },
  { kind: 'buffer', count: 100_000, bytes: 128 },
  { kind: 'buffer', count: 100_000, bytes: 4096 },
  { kind: 'manager', count: 100_000, bytes: 24, timeline: 'off' },
  { kind: 'manager', count: 1_000_000, bytes: 24, timeline: 'off' },
  { kind: 'manager', count: 100_000, bytes: 24, timeline: 'on' },
  { kind: 'manager', count: 1_000_000, bytes: 24, timeline: 'on' },
  { kind: 'manager', count: 100_000, bytes: 24, timeline: 'off', ports: 3 },
  { kind: 'manager', count: 100_000, bytes: 24, timeline: 'on', ports: 3 },
  { kind: 'manager', count: 100_000, bytes: 24, timeline: 'join' },
  { kind: 'manager', count: 1_000_000, bytes: 24, timeline: 'join' },
  { kind: 'allocation', count: 100_000, shape: 'metadata' },
  { kind: 'allocation', count: 100_000, bytes: 24, shape: 'bytes' },
];
const caseId = item => [item.kind, item.count, item.clock ?? item.bytes, item.timeline, item.ports ? `ports${item.ports}` : item.shape].filter(value => value !== undefined).join('-');
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

if (!flags.has('worker')) {
  const selected = cases.filter(item => !flags.has('case') || caseId(item).includes(flags.get('case')));
  assert.ok(selected.length, 'No matching benchmark cases');
  const repeats = Number(flags.get('repeats') ?? 3);
  assert.ok(Number.isInteger(repeats) && repeats >= 1 && repeats <= 10);
  const output = path.resolve(root, flags.get('output') ?? 'node_modules/.cache/hypercom/terminal-memory-bench.json');
  mkdirSync(path.dirname(output), { recursive: true });
  const samples = [];
  for (const item of selected) {
    for (let repetition = 0; repetition < repeats; repetition++) {
      const sampleFile = `${output}.${caseId(item)}.${repetition}.json`;
      const args = ['--expose-gc', fileURLToPath(import.meta.url), '--worker', '--case', caseId(item), '--output', sampleFile];
      if (flags.has('baseline-dir')) args.push('--baseline-dir', flags.get('baseline-dir'));
      // Inherit stdio: no child-process named pipes (Windows sandbox compatible).
      const child = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
      if (child.error) throw child.error;
      assert.equal(child.status, 0, `Benchmark worker failed: ${caseId(item)}`);
      samples.push({ ...JSON.parse(readFileSync(sampleFile, 'utf8')), repetition });
    }
  }
  const summary = selected.map(item => {
    const matching = samples.filter(sample => sample.id === caseId(item));
    const result = { id: caseId(item) };
    for (const key of Object.keys(matching[0])) {
      if (typeof matching[0][key] === 'number' && key !== 'repetition') result[key] = median(matching.map(sample => sample[key]));
    }
    return result;
  });
  const report = { node: process.version, platform: `${process.platform}/${process.arch}`, baselineDir: flags.get('baseline-dir') ?? null, repeats, note: 'GC-retained Node/V8 samples, not OS RSS or browser frame-time guarantees; compare repeated medians on the same machine.', summary, samples };
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.table(summary);
  console.log(`Saved ${output}`);
  process.exit(0);
}

assert.equal(typeof globalThis.gc, 'function', 'Run with --expose-gc');
const baselineDir = flags.has('baseline-dir') ? path.resolve(root, flags.get('baseline-dir')) : null;
const terminalDir = path.join(root, 'src/utils/terminal');
registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
        for (const suffix of ['.ts', '.tsx', '/index.ts']) {
          const url = new URL(specifier + suffix, context.parentURL);
          if (existsSync(fileURLToPath(url))) return nextResolve(url.href, context);
        }
      }
      throw error;
    }
  },
  load(url, context, nextLoad) {
    if (!url.startsWith('file:') || !/\.tsx?$/.test(url)) return nextLoad(url, context);
    const filename = fileURLToPath(url);
    const snapshot = baselineDir && path.dirname(filename) === terminalDir ? path.join(baselineDir, path.basename(filename)) : null;
    const source = readFileSync(snapshot && existsSync(snapshot) ? snapshot : filename, 'utf8').replaceAll('import.meta.env', '({ DEV: false, MODE: "test" })');
    return { format: 'module', source: ts.transpileModule(source, { fileName: filename, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, useDefineForClassFields: true } }).outputText, shortCircuit: true };
  },
});
const { TerminalTimeIndex } = await import(pathToFileURL(path.join(terminalDir, 'TerminalTimeIndex.ts')).href);
const { TerminalBuffer } = await import(pathToFileURL(path.join(terminalDir, 'TerminalBuffer.ts')).href);
const item = cases.find(value => caseId(value) === flags.get('case'));
assert.ok(item);
const epoch = 1_800_000_000_000;
const timestamp = (seq, clock = 'monotonic', count = item.count) => epoch + (clock === 'rollback' ? (seq * 7919 % count) : Math.floor(seq / 3));
const row = (seq, bytes) => ({ timestamp: timestamp(seq), direction: 'RX', rawData: new Uint8Array(bytes).fill(seq & 255), isHex: false });
const gc = () => { for (let i = 0; i < 3; i++) globalThis.gc(); };
const memory = () => { gc(); const usage = process.memoryUsage(); return { heap: usage.heapUsed, arrayBuffers: usage.arrayBuffers, external: usage.external }; };
const delta = (before, after) => ({ heapMiB: (after.heap - before.heap) / 2 ** 20, arrayBufferMiB: (after.arrayBuffers - before.arrayBuffers) / 2 ** 20, externalMiB: (after.external - before.external) / 2 ** 20, retainedMiB: (after.heap + after.arrayBuffers - before.heap - before.arrayBuffers) / 2 ** 20 });
const time = fn => { const start = performance.now(); fn(); return performance.now() - start; };
let result = { id: caseId(item), count: item.count };
let sink = 0;

if (item.kind === 'index') {
  const warm = new TerminalTimeIndex();
  for (let i = 0; i < 20_000; i++) warm.add(i, timestamp(i, item.clock));
  for (let i = 0; i < 20_000; i++) { sink += warm.lookup(timestamp(i, item.clock))?.entry.seq ?? 0; warm.delete(i); }
  warm.clear();
  const before = memory();
  const index = new TerminalTimeIndex(); globalThis.__terminalBenchRoot = index;
  const buildMs = time(() => { for (let seq = 0; seq < item.count; seq++) index.add(seq, timestamp(seq, item.clock)); });
  const after = memory();
  assert.equal(index.size, item.count);
  const querySamples = [];
  for (let pass = 0; pass < 9; pass++) querySamples.push(time(() => {
    for (let i = 0; i < 20_000; i++) sink += index.lookup(timestamp(i * 7919 % item.count, item.clock))?.entry.seq ?? 0;
  }));
  const churn = Math.min(item.count, 100_000);
  const rollingMs = time(() => { for (let i = 0; i < churn; i++) { index.delete(i); index.add(item.count + i, timestamp(item.count + i, item.clock)); } });
  const halfEvictMs = time(() => { for (let seq = churn; seq < churn + item.count / 2; seq++) index.delete(seq); });
  const afterHalf = memory();
  const entriesAfterHalf = index.size;
  assert.equal(entriesAfterHalf, item.count / 2);
  index.clear(); const afterClear = memory();
  result = { ...result, ...delta(before, after), buildMs, lookup20000Ms: median(querySamples), rolling100kMs: rollingMs, halfEvictMs, entriesAfterHalf, halfRetainedMiB: delta(before, afterHalf).retainedMiB, clearRetainedMiB: delta(before, afterClear).retainedMiB };
} else if (item.kind === 'buffer') {
  const warm = new TerminalBuffer({ maxLines: 20_000 });
  for (let i = 0; i < 20_000; i++) warm.append(row(i, item.bytes));
  warm.clear();
  const before = memory();
  const buffer = new TerminalBuffer({ maxLines: item.count }); globalThis.__terminalBenchRoot = buffer;
  const buildMs = time(() => { for (let seq = 0; seq < item.count; seq++) buffer.append(row(seq, item.bytes)); });
  const after = memory();
  const scanMs = time(() => { for (let seq = buffer.firstSeq; seq <= buffer.lastSeq; seq++) sink += buffer.getBySeq(seq)?.rawData?.[0] ?? 0; });
  const churn = Math.min(item.count, 100_000);
  const rollingMs = time(() => { for (let i = 0; i < churn; i++) buffer.append(row(item.count + i, item.bytes)); });
  buffer.clear(); const afterClear = memory();
  result = { ...result, bytesPerLine: item.bytes, ...delta(before, after), buildMs, scanMs, rolling100kMs: rollingMs, clearRetainedMiB: delta(before, afterClear).retainedMiB };
} else if (item.kind === 'allocation') {
  const make = seq => item.shape === 'metadata'
    ? { timestamp: timestamp(seq), direction: 'RX', rawData: undefined, isHex: false }
    : new Uint8Array(item.bytes).fill(seq & 255);
  let values = Array.from({ length: 20_000 }, (_, seq) => make(seq));
  values = null;
  const before = memory();
  const buildMs = time(() => { values = Array.from({ length: item.count }, (_, seq) => make(seq)); });
  globalThis.__terminalBenchRoot = values;
  const after = memory();
  result = { ...result, ...delta(before, after), buildMs, retainedBytesPerEntry: delta(before, after).retainedMiB * 2 ** 20 / item.count };
} else {
  const { TerminalViewportManager } = await import(pathToFileURL(path.join(terminalDir, 'viewportManager.ts')).href);
  const warm = new TerminalViewportManager('warm', { maxLines: 20_000 });
  if (item.timeline === 'on') warm.setTimelineGrouped(true);
  for (let i = 0; i < 20_000; i++) warm.appendLine(row(i, item.bytes));
  warm.dispose();
  const before = memory();
  const managers = Array.from({ length: item.ports ?? 1 }, (_, port) => new TerminalViewportManager(`bench-${port}`, { maxLines: item.count }));
  globalThis.__terminalBenchRoot = managers;
  if (item.timeline === 'on') for (const manager of managers) manager.setTimelineGrouped(true);
  const buildMs = time(() => {
    for (let seq = 0; seq < item.count; seq += 1000) for (const manager of managers) {
      manager.appendLines(Array.from({ length: Math.min(1000, item.count - seq) }, (_, i) => row(seq + i, item.bytes)));
    }
  });
  const after = memory();
  for (const manager of managers) {
    assert.equal(manager.getVisibleCount(), item.count);
    if (item.timeline === 'on') assert.equal(manager.lookupTime(epoch).seq, 2);
  }
  let joinMetrics = {};
  if (item.timeline === 'join') {
    const originalSetTimeout = globalThis.setTimeout;
    const chunks = [];
    globalThis.setTimeout = (callback, delay, ...args) => originalSetTimeout(() => {
      const start = performance.now();
      try { callback(...args); } finally { chunks.push(performance.now() - start); }
    }, delay);
    const start = performance.now();
    try {
      for (const manager of managers) manager.setTimelineGrouped(true);
      while (managers.some(manager => manager.isLoading)) await new Promise(resolve => originalSetTimeout(resolve, 1));
    } finally { globalThis.setTimeout = originalSetTimeout; }
    const sorted = [...chunks].sort((a, b) => a - b);
    joinMetrics = { firstJoinWallMs: performance.now() - start, firstJoinChunkCount: chunks.length, firstJoinChunkP95Ms: sorted[Math.floor(sorted.length * .95)] ?? 0, firstJoinChunkMaxMs: sorted.at(-1) ?? 0, firstJoinChunkTotalMs: chunks.reduce((sum, value) => sum + value, 0), joinedRetainedMiB: delta(before, memory()).retainedMiB };
    for (const manager of managers) assert.equal(manager.lookupTime(epoch).seq, 2);
  }
  const churn = Math.min(item.count, 100_000);
  const rollingMs = time(() => {
    for (let i = 0; i < churn; i += 1000) for (const manager of managers) manager.appendLines(Array.from({ length: Math.min(1000, churn - i) }, (_, j) => row(item.count + i + j, item.bytes)));
  });
  for (const manager of managers) manager.setTimelineGrouped(false);
  const afterUngroup = memory();
  for (const manager of managers) manager.clear();
  const afterClear = memory();
  for (const manager of managers) manager.dispose();
  result = { ...result, ports: managers.length, ...delta(before, after), ...joinMetrics, buildMs, rolling100kMs: rollingMs, ungroupRetainedMiB: delta(before, afterUngroup).retainedMiB, clearRetainedMiB: delta(before, afterClear).retainedMiB };
}
result.checksum = sink;
writeFileSync(flags.get('output'), JSON.stringify(result, null, 2) + '\n');
console.log('TERMINAL_MEMORY_BENCH', JSON.stringify(result));
