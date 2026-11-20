import { makeHit, matchRecord, matchWindow, validateSearchSpec } from './searchMatcher';
import { SEARCH_MAX_LINES, SEARCH_MAX_TEXT_BYTES, type SearchHit, type SearchRecord, type SearchWorkerRequest, type SearchWorkerResponse } from './searchTypes';

interface WorkerSource { generation: number; configKey?: string; tail: SearchRecord[]; emitted: Set<number>; bytes: number }

/** Pure runtime factory shared by the real Worker and protocol tests. State is
 * bounded by a single 32-record / 16 KiB tail for each active source. */
export function createSearchWorkerHandler(): (request: SearchWorkerRequest) => SearchWorkerResponse | null {
  const sources = new Map<string, WorkerSource>();
  return request => {
    if (request.type === 'dispose' || request.type === 'clear') { sources.clear(); return null; }
    if (request.type === 'reset') { sources.delete(request.sourceId); return null; }
    if (request.type === 'trim') {
      const source = sources.get(request.sourceId);
      if (source?.generation === request.generation) {
        source.tail = source.tail.filter(record => record.seq >= request.firstSeq);
        source.bytes = source.tail.reduce((sum, record) => sum + record.text.length * 2 + 2, 0);
        for (const seq of source.emitted) if (seq < request.firstSeq) source.emitted.delete(seq);
      }
      return null;
    }
    const error = validateSearchSpec(request.spec);
    if (error) return { type: 'error', error };
    let source = sources.get(request.sourceId);
    if (!source || source.generation !== request.generation || source.configKey !== request.configKey) {
      source = { generation: request.generation, configKey: request.configKey, tail: [], emitted: new Set(), bytes: 0 };
      sources.set(request.sourceId, source);
    }
    const hits: SearchHit[] = [];
    let incomplete = false;
    for (const record of request.records) {
      const tooLong = !!record && (record.oversized || (request.spec.mode === 'hex'
        ? (record.rawData?.byteLength ?? 0) > SEARCH_MAX_TEXT_BYTES
        : record.text.length * 2 > (request.spec.mode === 'fuzzy' ? 8192 : SEARCH_MAX_TEXT_BYTES)));
      if (!record || !request.spec.directions.includes(record.direction) || tooLong) {
        source.tail = []; source.emitted.clear(); source.bytes = 0;
        incomplete ||= tooLong;
        continue;
      }
      if (!request.spec.multiline || request.spec.mode === 'hex') {
        const match = matchWindow([record], request.spec);
        if (match) {
          const hit = makeHit(request.sourceId, request.generation, [record], match, request.spec.mode === 'hex' ? 'hex' : 'text');
          if (hit) hits.push(hit);
          incomplete ||= !!match.incomplete;
        }
        continue;
      }
      const previous = source.tail[source.tail.length - 1];
      if (previous && previous.seq + 1 !== record.seq) { source.tail = []; source.emitted.clear(); source.bytes = 0; }
      source.tail.push(record); source.bytes += record.text.length * 2 + 2;
      while (source.tail.length > SEARCH_MAX_LINES || source.bytes - 2 > SEARCH_MAX_TEXT_BYTES) {
        const removed = source.tail.shift()!; source.bytes -= removed.text.length * 2 + 2; source.emitted.delete(removed.seq);
      }
      // All emitted-start state follows this tiny tail, not the full history.
      const first = source.tail[0]?.seq ?? record.seq;
      for (const seq of source.emitted) if (seq < first) source.emitted.delete(seq);
      // Subsequence matching is monotone: if the entire bounded tail cannot
      // match, none of its suffix windows can. This avoids 32 repeated scans
      // per row for the common no-hit fuzzy query during a history search.
      if (request.spec.mode === 'fuzzy' && !matchRecord({ ...record, text: source.tail.map(item => item.text).join('\n') }, request.spec)) continue;
      for (let start = 0; start < source.tail.length; start++) {
        const candidate = source.tail.slice(start);
        if (source.emitted.has(candidate[0].seq)) continue;
        const match = matchWindow(candidate, request.spec);
        if (!match) continue;
        const hit = makeHit(request.sourceId, request.generation, candidate, match);
        if (hit) { source.emitted.add(candidate[0].seq); hits.push(hit); }
        incomplete ||= !!match.incomplete;
      }
    }
    return { type: 'hits', sourceId: request.sourceId, generation: request.generation, configKey: request.configKey, hits, incomplete };
  };
}

if (typeof self !== 'undefined' && typeof document === 'undefined') {
  const scope = self as unknown as { onmessage: ((event: MessageEvent<SearchWorkerRequest>) => void) | null; postMessage(response: SearchWorkerResponse): void };
  const handle = createSearchWorkerHandler();
  scope.onmessage = event => {
    try { const response = handle(event.data); if (response) scope.postMessage(response); }
    catch { scope.postMessage({ type: 'error', error: 'terminal.search.error.workerFailed' }); }
  };
}
