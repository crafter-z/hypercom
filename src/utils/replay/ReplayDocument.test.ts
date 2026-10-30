import { describe, expect, it } from 'vitest';
import { ReplayDocument, REPLAY_LIMITS, type ReplayImportOptions } from './ReplayDocument';
const options: ReplayImportOptions = { encoding: 'UTF-8', format: 'text', timezoneOffsetMinutes: 0 };
async function* chunks(...values: string[]) { yield* values; }
const signal = () => new AbortController().signal;
describe('ReplayDocument', () => {
  it('retains all records beyond a realtime ring limit and keeps unknown timestamps null', async () => {
    const document = await ReplayDocument.fromChunks(chunks('RX unknown\r', '\n[2026-01-01 00:00:01Z] RX one\n\nTX tail'), options, signal());
    expect(document.length).toBe(4); expect(document.firstSeq).toBe(0); expect(document.lastSeq).toBe(3);
    expect(document.getTimeMs(0)).toBeNull(); expect(Number.isNaN(document.getBySeq(0)!.timestamp)).toBe(true);
    expect(document.getBySeq(2)?.content).toBe(''); expect(document.snapshot().map(line => line.content)).toEqual(['unknown', 'one', '', 'tail']);
    expect(document.getBySeq(5)).toBeNull(); expect(document.getBySeq(0.5)).toBeNull();
  });
  it('marks clock rollback as a new ordered segment without sorting records', async () => {
    const document = await ReplayDocument.fromChunks(chunks('[2026-01-01 00:00:02Z] RX a\n[2026-01-01 00:00:02Z] RX b\nunknown\n[2026-01-01 00:00:01Z] RX c'), options, signal());
    expect(document.segments.map(segment => [segment.firstSeq, segment.lastSeq])).toEqual([[0, 2], [3, 3]]);
    expect(document.snapshot().map(line => line.content)).toEqual(['a', 'b', 'unknown', 'c']);
    expect(document.knownTimeCount).toBe(3);
  });
  it('decodes explicit HEX records but rejects malformed HEX', async () => {
    const document = await ReplayDocument.fromChunks(chunks('RX 48 65'), { ...options, format: 'hex' }, signal());
    expect(document.getBySeq(0)?.rawData).toEqual(new Uint8Array([0x48, 0x65]));
    await expect(ReplayDocument.fromChunks(chunks('RX 4'), { ...options, format: 'hex' }, signal())).rejects.toThrow('Invalid HEX');
  });
  it('rejects whole imports on budgets instead of trimming history', async () => {
    await expect(ReplayDocument.fromChunks(chunks('hello'), options, signal(), { records: REPLAY_LIMITS.records, decodedBytes: 0 })).rejects.toThrow('no records were imported');
    await expect(ReplayDocument.fromChunks(chunks('hello'), options, signal(), { records: 0, decodedBytes: REPLAY_LIMITS.decodedBytes })).rejects.toThrow('no records were imported');
    await expect(ReplayDocument.fromChunks(chunks('x'.repeat(REPLAY_LIMITS.lineChars + 1)), options, signal())).rejects.toThrow('256 Ki');
  });
  it('cooperatively cancels between chunks and in a parsing batch', async () => {
    const controller = new AbortController();
    async function* cancelled() { yield 'RX first\n'; controller.abort(); yield 'RX late\n'; }
    await expect(ReplayDocument.fromChunks(cancelled(), options, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    const already = new AbortController(); already.abort();
    await expect(ReplayDocument.fromChunks(chunks('a'), options, already.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('parses a large complete document in yielded batches without maxDisplayLines trimming', async () => {
    const document = await ReplayDocument.fromChunks(chunks('RX line\n'.repeat(10_005)), options, signal());
    expect(document.length).toBe(10_005); expect(document.getBySeq(10_004)?.content).toBe('line');
  });
});
