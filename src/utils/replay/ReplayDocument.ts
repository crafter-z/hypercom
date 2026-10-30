import type { TerminalLine } from '../../types';
import type { TerminalSource } from '../terminal/TerminalSource';
import { parseReplayRecord, type LogParseOptions } from '../logReplay';
import { parseHexBytes, hexInputError } from '../sendUtils';

export const REPLAY_LIMITS = Object.freeze({ maxFiles: 16, fileBytes: 32 * 1024 * 1024, sessionBytes: 64 * 1024 * 1024, decodedBytes: 192 * 1024 * 1024, records: 500_000, lineChars: 256 * 1024, chunkRecords: 1000 });
export interface ReplayImportOptions extends LogParseOptions { format: 'text' | 'hex'; encoding: 'UTF-8' }
export interface ReplaySegment { id: string; firstSeq: number; lastSeq: number; startTimeMs: number | null; endTimeMs: number | null }
export interface ReplayBudget { records: number; decodedBytes: number }
/** Immutable full history. No ring and no maxDisplayLines trimming. */
export class ReplayDocument implements TerminalSource {
  readonly firstSeq = 0;
  readonly version = 1;
  readonly segments: readonly ReplaySegment[];
  readonly knownTimeCount: number;
  readonly startTimeMs: number | null;
  readonly endTimeMs: number | null;
  private constructor(private readonly lines: readonly TerminalLine[], private readonly times: readonly (number | null)[], segments: ReplaySegment[]) {
    this.segments = segments;
    let start = Infinity, end = -Infinity, count = 0;
    for (const time of times) if (time !== null) { start = Math.min(start, time); end = Math.max(end, time); count++; }
    this.knownTimeCount = count; this.startTimeMs = count ? start : null; this.endTimeMs = count ? end : null;
  }
  get length(): number { return this.lines.length; }
  get lastSeq(): number { return this.lines.length - 1; }
  getBySeq(seq: number): TerminalLine | null { return Number.isInteger(seq) ? this.lines[seq] ?? null : null; }
  getTimeMs(seq: number): number | null { return this.times[seq] ?? null; }
  snapshot(fromSeq = this.firstSeq, toSeq = this.lastSeq): TerminalLine[] { return this.lines.slice(Math.max(0, fromSeq), Math.min(this.length, toSeq + 1)); }

  /** Parsing yields every bounded batch and checks cancellation before publishing. */
  static async fromChunks(chunks: AsyncIterable<string>, options: ReplayImportOptions, signal: AbortSignal, budget: ReplayBudget = { records: 0, decodedBytes: 0 }): Promise<ReplayDocument> {
    const lines: TerminalLine[] = [], times: Array<number | null> = [], segments: ReplaySegment[] = [];
    let tail = '', previousTime: number | null = null, segment: ReplaySegment | undefined, batch = 0;
    const check = () => { if (signal.aborted) throw new DOMException('Import cancelled', 'AbortError'); };
    const record = (text: string) => {
      check();
      if (text.length > REPLAY_LIMITS.lineChars) throw new Error('Replay line exceeds 256 Ki characters');
      const parsed = parseReplayRecord(text, options);
      const seq = lines.length;
      if (!segment || (parsed.time !== null && previousTime !== null && parsed.time < previousTime)) {
        segment = { id: `segment-${segments.length}`, firstSeq: seq, lastSeq: seq, startTimeMs: parsed.time, endTimeMs: parsed.time };
        segments.push(segment);
      }
      segment.lastSeq = seq;
      if (parsed.time !== null) { if (segment.startTimeMs === null) segment.startTimeMs = parsed.time; segment.endTimeMs = parsed.time; previousTime = parsed.time; }
      let rawData: Uint8Array | undefined;
      if (options.format === 'hex') { if (hexInputError(parsed.content)) throw new Error(`Invalid HEX record ${seq + 1}`); rawData = new Uint8Array(parseHexBytes(parsed.content)); }
      budget.records++; budget.decodedBytes += parsed.content.length * 2 + (rawData?.length ?? 0) + 160;
      if (budget.records > REPLAY_LIMITS.records || budget.decodedBytes > REPLAY_LIMITS.decodedBytes) throw new Error('Replay exceeds 500,000 records or 192 MiB decoded memory budget; no records were imported');
      lines.push({ timestamp: parsed.time ?? Number.NaN, direction: parsed.direction, content: options.format === 'text' ? parsed.content : undefined, rawData, isHex: options.format === 'hex' });
      times.push(parsed.time);
    };
    for await (const chunk of chunks) {
      check(); tail += chunk;
      let start = 0;
      for (let i = 0; i < tail.length; i++) {
        const char = tail[i];
        if (char !== '\n' && char !== '\r') continue;
        if (char === '\r' && i === tail.length - 1) break;
        record(tail.slice(start, i));
        if (char === '\r' && tail[i + 1] === '\n') i++;
        start = i + 1;
        if (++batch >= REPLAY_LIMITS.chunkRecords) { batch = 0; await new Promise<void>(resolve => setTimeout(resolve, 0)); check(); }
      }
      tail = tail.slice(start);
      if (tail.length > REPLAY_LIMITS.lineChars) throw new Error('Replay line exceeds 256 Ki characters');
    }
    if (tail.endsWith('\r')) { record(tail.slice(0, -1)); tail = ''; }
    if (tail) record(tail);
    check(); return new ReplayDocument(lines, times, segments);
  }
}
