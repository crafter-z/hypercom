import { isValidHexInput, parseHexBytes } from '../../hexUtils';
import { tryCreateSafeRegex, isSafeRegexPattern, MAX_SAFE_REGEX_PATTERN_LENGTH } from '../../safeRegex';
import { bytesToSpacedHex } from '../../hexFormat';
import { SEARCH_MAX_LINES, SEARCH_MAX_TEXT_BYTES, SEARCH_MAX_QUERY_LENGTH, SEARCH_MAX_FUZZY_QUERY_LENGTH, type SearchHit, type SearchRecord, type SearchSpec, type SearchSpan } from './searchTypes';

export { DEFAULT_SEARCH_SPEC } from './searchTypes';
const WORD = /[\p{L}\p{N}_]/u;
const MAX_SPANS = 256;
export interface MatcherSpan { start: number; end: number }
export interface RecordMatch { spans: MatcherSpan[]; score?: number; incomplete?: boolean }

/** Admission only: user regex execution is confined to the search Worker. */
export function validateSearchSpec(spec: SearchSpec): string | null {
  if (!spec || typeof spec.query !== 'string') return 'terminal.search.error.invalidSpec';
  if (!['literal', 'regex', 'fuzzy', 'hex'].includes(spec.mode)) return 'terminal.search.error.invalidMode';
  if (!['buffer', 'visible'].includes(spec.scope)) return 'terminal.search.error.invalidScope';
  if (!Array.isArray(spec.directions) || spec.directions.some(value => !['RX', 'TX', 'TOOL', 'NOTE'].includes(value))) return 'terminal.search.error.invalidDirections';
  const limit = spec.mode === 'fuzzy' ? SEARCH_MAX_FUZZY_QUERY_LENGTH : spec.mode === 'regex' ? MAX_SAFE_REGEX_PATTERN_LENGTH : SEARCH_MAX_QUERY_LENGTH;
  if (spec.query.length > limit) return 'terminal.search.error.queryTooLong';
  if (spec.mode === 'hex' && (!isValidHexInput(spec.query) || !parseHexBytes(spec.query).length)) return 'terminal.search.error.invalidHex';
  if (spec.mode === 'hex' && spec.multiline) return 'terminal.search.error.hexMultiline';
  if (spec.mode === 'regex' && !isSafeRegexPattern(spec.query)) return 'terminal.search.error.invalidRegex';
  return null;
}

function boundaryOk(text: string, start: number, end: number): boolean {
  const previous = start > 0 ? String.fromCodePoint(text.codePointAt(start - (start > 1 && /[\uDC00-\uDFFF]/.test(text[start - 1]) ? 2 : 1))!) : '';
  const next = end < text.length ? String.fromCodePoint(text.codePointAt(end)!) : '';
  return !WORD.test(previous) && !WORD.test(next);
}

/** Case folding with an offset map only for expansion cases (e.g. İ). */
function folded(text: string, sensitive: boolean) {
  const value = sensitive ? text : text.toLowerCase();
  if (value.length === text.length) return { value, start: (at: number) => at, end: (at: number) => at };
  const starts: number[] = [], ends: number[] = [];
  let offset = 0;
  for (const point of text) {
    const lower = point.toLowerCase();
    for (let index = 0; index < lower.length; index++) { starts.push(offset); ends.push(offset + point.length); }
    offset += point.length;
  }
  return { value, start: (at: number) => starts[at] ?? text.length, end: (at: number) => at > 0 ? ends[at - 1] ?? text.length : 0 };
}
function literalMatches(text: string, spec: SearchSpec): RecordMatch | null {
  if (!spec.query) return null;
  const source = folded(text, spec.caseSensitive);
  const query = spec.caseSensitive ? spec.query : spec.query.toLowerCase();
  const spans: MatcherSpan[] = [];
  let cursor = 0;
  while (cursor <= source.value.length - query.length) {
    const at = source.value.indexOf(query, cursor);
    if (at < 0) break;
    const start = source.start(at), end = source.end(at + query.length);
    if (!spec.wholeWord || boundaryOk(text, start, end)) spans.push({ start, end });
    cursor = at + Math.max(1, query.length);
    if (spans.length >= MAX_SPANS) return { spans, incomplete: cursor < source.value.length };
  }
  return spans.length ? { spans } : null;
}

// A Worker serves one query at a time; avoid re-parsing the regex for every
// candidate window, without retaining a growing process-wide expression cache.
let regexKey = '', cachedRegex: RegExp | null = null;
function regexMatches(text: string, spec: SearchSpec): RecordMatch | null {
  const flags = `${spec.caseSensitive ? '' : 'i'}g${spec.multiline ? 'm' : ''}u`;
  const key = JSON.stringify([spec.query, flags]);
  if (key !== regexKey) { regexKey = key; cachedRegex = tryCreateSafeRegex(spec.query, flags); }
  const expression = cachedRegex;
  if (!expression) return null;
  expression.lastIndex = 0;
  const spans: MatcherSpan[] = [];
  let match: RegExpExecArray | null;
  while ((match = expression.exec(text)) !== null) {
    const start = match.index, end = start + match[0].length;
    if (end > start && (!spec.wholeWord || boundaryOk(text, start, end))) spans.push({ start, end });
    if (end === start) {
      // Advance by a code point with /u. Advancing one surrogate half can make
      // RegExp rewind to the same empty match indefinitely.
      expression.lastIndex = start + ((text.codePointAt(start) ?? 0) > 0xffff ? 2 : 1);
    }
    if (spans.length >= MAX_SPANS) return { spans, incomplete: expression.lastIndex < text.length };
  }
  return spans.length ? { spans } : null;
}
function fuzzyMatch(text: string, spec: SearchSpec): RecordMatch | null {
  if (!spec.query) return null;
  const source = folded(text, spec.caseSensitive);
  const query = spec.caseSensitive ? spec.query : spec.query.toLowerCase();
  const spans: MatcherSpan[] = [];
  let cursor = 0, contiguous = 0, wordStarts = 0, previousEnd = -1;
  for (const point of query) {
    const at = source.value.indexOf(point, cursor);
    if (at < 0) return null;
    const start = source.start(at), end = source.end(at + point.length);
    if (start === previousEnd) contiguous++;
    if (start === 0 || !WORD.test(text[start - 1])) wordStarts++;
    const previous = spans[spans.length - 1];
    if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
    else spans.push({ start, end });
    previousEnd = end; cursor = at + point.length;
  }
  if (!spans.length) return null;
  const width = spans[spans.length - 1].end - spans[0].start;
  return { spans, score: query.length * 10 + contiguous * 4 + wordStarts * 2 - (width - query.length) };
}
function textMatches(text: string, spec: SearchSpec): RecordMatch | null {
  return spec.mode === 'literal' ? literalMatches(text, spec) : spec.mode === 'regex' ? regexMatches(text, spec) : fuzzyMatch(text, spec);
}
let hexKey = '', hexQuery: number[] = [];
export function matchRecord(record: SearchRecord, spec: SearchSpec): RecordMatch | null {
  if (!spec.directions.includes(record.direction)) return null;
  if (spec.mode !== 'hex') return textMatches(record.text, spec);
  if (hexKey !== spec.query) { hexKey = spec.query; hexQuery = parseHexBytes(spec.query); }
  const bytes = record.rawData;
  if (!bytes || !hexQuery.length) return null;
  const spans: MatcherSpan[] = [];
  for (let at = 0; at <= bytes.length - hexQuery.length; at++) {
    let equal = true;
    for (let index = 0; index < hexQuery.length; index++) if (bytes[at + index] !== hexQuery[index]) { equal = false; break; }
    if (equal) spans.push({ start: at, end: at + hexQuery.length });
    if (spans.length >= MAX_SPANS) return { spans, incomplete: at < bytes.length - hexQuery.length };
  }
  return spans.length ? { spans } : null;
}

/** One hit per start record, using the shortest arriving window that matches.
 * Candidate matches must actually touch both endpoint records; independent
 * single-line occurrences must never turn into a spurious cross-line hit. */
export function matchWindow(input: Array<SearchRecord | null>, spec: SearchSpec): RecordMatch | null {
  if (input.some(record => !record)) return null;
  const records = input as SearchRecord[];
  if (!records.length || records.length > SEARCH_MAX_LINES) return null;
  if (records.some((record, index) => !record || !spec.directions.includes(record.direction) || (index > 0 && record.seq !== records[index - 1].seq + 1))) return null;
  if (records.length === 1) return matchRecord(records[0], spec);
  if (!spec.multiline || spec.mode === 'hex') return null;
  const text = records.map(record => record.text).join('\n');
  if (text.length * 2 > SEARCH_MAX_TEXT_BYTES) return null;
  const match = textMatches(text, spec);
  if (!match) return null;
  const lastStart = text.length - records[records.length - 1].text.length;
  if (spec.mode === 'fuzzy') return match.spans[0].start < records[0].text.length && match.spans[match.spans.length - 1].end > lastStart ? match : null;
  const spans = match.spans.filter(span => span.start < records[0].text.length && span.end > lastStart);
  return spans.length ? { ...match, spans } : null;
}

export function splitSpans(records: SearchRecord[], match: RecordMatch, mode: 'text' | 'hex' = 'text'): SearchSpan[] {
  const spans: SearchSpan[] = [];
  let base = 0;
  for (const record of records) {
    const width = mode === 'hex' ? record.rawData?.length ?? 0 : record.text.length;
    for (const span of match.spans) {
      const start = Math.max(span.start, base), end = Math.min(span.end, base + width);
      if (start < end) spans.push({ seq: record.seq, start: mode === 'hex' ? (start - base) * 3 : start - base, end: mode === 'hex' ? (end - base) * 3 - 1 : end - base });
    }
    base += width + (mode === 'hex' ? 0 : 1);
  }
  return spans.slice(0, MAX_SPANS);
}
export function makeHit(sourceId: string, generation: number, records: SearchRecord[], match: RecordMatch, mode: 'text' | 'hex' = 'text'): SearchHit | null {
  const spans = splitSpans(records, match, mode);
  if (!spans.length) return null;
  const first = records.find(record => record.seq === spans[0].seq)!;
  return { sourceId, generation, startSeq: spans[0].seq, endSeq: spans[spans.length - 1].seq, spans, timestamp: first.timestamp,
    direction: first.direction, ...(match.score === undefined ? {} : { score: match.score }) };
}
export function formatHexPreview(bytes: ArrayLike<number>): string { return bytesToSpacedHex(bytes); }
