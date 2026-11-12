import { describe, expect, it } from 'vitest';
import { isLikelyAsciiNoise } from './asciiNoise';
import { linePassesFilter } from './lineFilter';
import type { TerminalLine } from '../types';

// Keep the optional benchmark Node-only without adding a Node type dependency to
// the DOM-only production tsconfig (the same local probe pattern as
// TerminalPerformance.test.ts).
const runtimeProcess = (globalThis as unknown as {
  process?: { env: Record<string, string | undefined> };
}).process;
const enabled = runtimeProcess?.env.HYPERCOM_ASCII_BENCH === '1';

const FIXTURE_COUNT = 256;
const LINE_LENGTHS = [64, 256, 4096] as const;
const MIN_BYTES_PER_SAMPLE = 8 * 1024 * 1024;
const ROUNDS = 7;
const NORMAL_TEXT = 'INFO ready packet status=OK count=123 source=serial ';
const PROTECTED_TEXT = 'PACKET READY DATA=OK seq=0001';

type FixtureClass = 'ascii' | 'noise' | 'mixed';
type Operation = 'isLikelyAsciiNoise' | 'linePassesFilter:noise=false' | 'linePassesFilter:noise=true';

type Fixture = {
  bytes: Uint8Array;
  line: TerminalLine;
};

type FixtureSet = {
  kind: FixtureClass;
  length: number;
  fixtures: Fixture[];
  bytesPerFixtureSet: number;
  repeatsPerSample: number;
  bytesPerSample: number;
};

const percentile = (values: number[], fraction: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
};

const makeAsciiFixture = (length: number, variant: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index++) {
    bytes[index] = NORMAL_TEXT.charCodeAt((index + variant * 11) % NORMAL_TEXT.length);
  }
  // Keep all variants printable while making every generated array distinct.
  bytes[0] = 0x21 + ((variant * 29) % 94);
  bytes[1] = 0x21 + ((variant * 47 + 7) % 94);
  return bytes;
};

const makeNoiseFixture = (length: number, variant: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index++) {
    // High bytes make the unreadable majority unambiguous. Every so often put
    // an isolated A/B/C in the stream, without introducing CR/LF.
    if ((index + variant * 3) % 19 === 0) {
      bytes[index] = 0x41 + ((index + variant) % 3);
    } else {
      bytes[index] = 0x80 + ((variant * 37 + index * 11) % 0x70);
    }
  }
  return bytes;
};

const makeMixedFixture = (length: number, variant: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index++) {
    bytes[index] = 0x80 + ((variant * 43 + index * 17) % 0x70);
  }
  const start = (variant * 7) % (length - PROTECTED_TEXT.length + 1);
  for (let index = 0; index < PROTECTED_TEXT.length; index++) {
    bytes[start + index] = PROTECTED_TEXT.charCodeAt(index);
  }
  return bytes;
};

const makeFixtureSet = (kind: FixtureClass, length: number): FixtureSet => {
  const makeBytes = kind === 'ascii'
    ? makeAsciiFixture
    : kind === 'noise'
      ? makeNoiseFixture
      : makeMixedFixture;
  const fixtures: Fixture[] = [];
  for (let variant = 0; variant < FIXTURE_COUNT; variant++) {
    const bytes = makeBytes(length, variant);
    fixtures.push({
      bytes,
      line: { timestamp: 0, direction: 'RX', rawData: bytes, isHex: false },
    });
  }
  const bytesPerFixtureSet = fixtures.reduce((total, fixture) => total + fixture.bytes.length, 0);
  const repeatsPerSample = Math.ceil(MIN_BYTES_PER_SAMPLE / bytesPerFixtureSet);
  return {
    kind,
    length,
    fixtures,
    bytesPerFixtureSet,
    repeatsPerSample,
    bytesPerSample: repeatsPerSample * bytesPerFixtureSet,
  };
};

const makeAllFixtureSets = (): FixtureSet[] => {
  const sets: FixtureSet[] = [];
  for (const length of LINE_LENGTHS) {
    for (const kind of ['ascii', 'noise', 'mixed'] as const) {
      sets.push(makeFixtureSet(kind, length));
    }
  }
  return sets;
};

const runOperation = (fixtureSet: FixtureSet, operation: Operation): number => {
  let sink = 0;
  for (let repeat = 0; repeat < fixtureSet.repeatsPerSample; repeat++) {
    for (let index = 0; index < fixtureSet.fixtures.length; index++) {
      const fixture = fixtureSet.fixtures[index];
      if (operation === 'isLikelyAsciiNoise') {
        sink += isLikelyAsciiNoise(fixture.bytes) ? 1 : 0;
      } else {
        sink += linePassesFilter(
          fixture.line,
          'all',
          '',
          'UTF-8',
          operation === 'linePassesFilter:noise=true',
        ) ? 1 : 0;
      }
    }
  }
  return sink;
};

const report = (fixtureSet: FixtureSet, operation: Operation, timesMs: number[], sink: number): void => {
  const p50Ms = percentile(timesMs, 0.5);
  const p95Ms = percentile(timesMs, 0.95);
  const mib = fixtureSet.bytesPerSample / (1024 * 1024);
  console.log('ASCII_CLASSIFIER_BENCH', JSON.stringify({
    operation,
    fixtureClass: fixtureSet.kind,
    lineLengthBytes: fixtureSet.length,
    p50Ms,
    p95Ms,
    p50MsPerMiB: p50Ms / mib,
    p95MsPerMiB: p95Ms / mib,
    p50NsPerByte: (p50Ms * 1_000_000) / fixtureSet.bytesPerSample,
    p95NsPerByte: (p95Ms * 1_000_000) / fixtureSet.bytesPerSample,
    bytesPerSample: fixtureSet.bytesPerSample,
    samples: timesMs.length,
    fixtureCount: fixtureSet.fixtures.length,
    fixturePassesPerSample: fixtureSet.repeatsPerSample,
    sink,
    units: {
      p50MsPerMiB: 'milliseconds per MiB processed',
      p95MsPerMiB: 'milliseconds per MiB processed',
      p50NsPerByte: 'nanoseconds per byte processed',
      p95NsPerByte: 'nanoseconds per byte processed',
      bytesPerSample: 'input bytes processed by each timed sample',
    },
  }));
};

describe.skipIf(!enabled)('ASCII classifier performance observations', () => {
  it('keeps ASCII, hides noise, and protects mixed English runs', () => {
    for (const fixtureSet of makeAllFixtureSets()) {
      expect(fixtureSet.fixtures).toHaveLength(FIXTURE_COUNT);
      const expectedNoise = fixtureSet.kind === 'noise';
      for (const fixture of fixtureSet.fixtures) {
        expect(isLikelyAsciiNoise(fixture.bytes)).toBe(expectedNoise);
        expect(linePassesFilter(fixture.line, 'all', '', 'UTF-8', false)).toBe(true);
        expect(linePassesFilter(fixture.line, 'all', '', 'UTF-8', true)).toBe(!expectedNoise);
      }
    }
  });

  it('reports interleaved classifier and filter timings', { timeout: 120_000 }, () => {
    const fixtureSets = makeAllFixtureSets();
    const operations: Operation[] = [
      'isLikelyAsciiNoise',
      'linePassesFilter:noise=false',
      'linePassesFilter:noise=true',
    ];

    // Warm every fixture, size, and operation before collecting observations.
    for (const fixtureSet of fixtureSets) {
      for (const operation of operations) runOperation(fixtureSet, operation);
    }

    for (const fixtureSet of fixtureSets) {
      const times = new Map<Operation, number[]>(operations.map(operation => [operation, []]));
      const sinks = new Map<Operation, number>(operations.map(operation => [operation, 0]));
      for (let round = 0; round < ROUNDS; round++) {
        // Alternate the filter switch order so hide=false/true do not always
        // occupy the same position in a warmed-up round.
        const filterFirst = round % 2 === 0;
        const order: Operation[] = filterFirst
          ? [operations[0], operations[1], operations[2]]
          : [operations[2], operations[0], operations[1]];
        for (const operation of order) {
          const start = performance.now();
          const sink = runOperation(fixtureSet, operation);
          const elapsedMs = performance.now() - start;
          times.get(operation)?.push(elapsedMs);
          sinks.set(operation, (sinks.get(operation) ?? 0) + sink);
        }
      }
      for (const operation of operations) {
        report(fixtureSet, operation, times.get(operation) ?? [], sinks.get(operation) ?? 0);
      }
    }
  });
});

export {};
