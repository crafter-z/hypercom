/** Public contracts for the terminal advanced-search engine. */

export type SearchMode = 'literal' | 'regex' | 'fuzzy' | 'hex';
export type SearchDirection = 'RX' | 'TX' | 'TOOL' | 'NOTE';

export interface SearchSpec {
  query: string;
  mode: SearchMode;
  multiline: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  scope: 'buffer' | 'visible';
  directions: Array<SearchDirection>;
}

export interface SearchSpan {
  seq: number;
  /** UTF-16 offsets in displayed text; HEX uses spaced-HEX character offsets. */
  start: number;
  end: number;
}

export interface SearchHit {
  sourceId: string;
  generation: number;
  startSeq: number;
  endSeq: number;
  spans: SearchSpan[];
  timestamp: number;
  direction: SearchDirection;
  score?: number;
}

export interface SearchRecord {
  seq: number;
  text: string;
  rawData?: Uint8Array;
  timestamp: number;
  direction: SearchDirection;
  /** Skipped without decoding/copying: breaks adjacency and reports partial results. */
  oversized?: boolean;
}

export interface SearchSourceState {
  generation: number;
  revision: number;
  firstSeq: number;
  lastSeq: number;
  configKey: string;
  available: boolean;
}

export interface SearchSource {
  id: string;
  getState(): SearchSourceState;
  readRecord(seq: number, spec: SearchSpec): SearchRecord | null;
}

export interface SearchSnapshot {
  status: 'scanning' | 'ready' | 'cancelled' | 'error';
  hits: readonly SearchHit[];
  scanned: number;
  truncated: boolean;
  incomplete: boolean;
  error?: string;
}

export const DEFAULT_SEARCH_SPEC: SearchSpec = Object.freeze({
  query: '',
  mode: 'literal',
  multiline: false,
  caseSensitive: false,
  wholeWord: false,
  scope: 'buffer',
  directions: ['RX', 'TX', 'TOOL', 'NOTE'] as SearchDirection[],
}) as SearchSpec;

export const SEARCH_RESULT_CAP = 10_000;
export const SEARCH_MAX_QUERY_LENGTH = 4096;
export const SEARCH_MAX_FUZZY_QUERY_LENGTH = 128;
export const SEARCH_MAX_LINES = 32;
export const SEARCH_MAX_TEXT_BYTES = 16 * 1024;
export const SEARCH_BATCH_RECORDS = 128;
export const SEARCH_BATCH_BYTES = 128 * 1024;

export type SearchWorkerRequest =
  | { type: 'batch'; sourceId: string; generation: number; configKey?: string; records: Array<SearchRecord | null>; spec: SearchSpec }
  | { type: 'reset'; sourceId: string; generation: number }
  | { type: 'trim'; sourceId: string; generation: number; firstSeq: number }
  | { type: 'clear' }
  | { type: 'dispose' };

export type SearchWorkerResponse =
  | { type: 'hits'; sourceId: string; generation: number; configKey?: string; hits: SearchHit[]; incomplete?: boolean }
  | { type: 'error'; error: string };
