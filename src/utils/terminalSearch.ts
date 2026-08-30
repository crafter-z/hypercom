/**
 * Terminal search helpers (pure, DOM-free).
 *
 * Extracted from TerminalView so search logic can be unit-tested under
 * vitest's `environment: 'node'` config (no jsdom required).
 *
 * P1-9：本文件原居 components/MainDisplay/，但它是零 React 依赖的纯文本工具，
 * 却被 utils/terminal 渲染引擎（TerminalRenderer/viewportManager）反向 import，
 * 造成 components↔utils 双向耦合。移入 utils/ 与 lineText/lineFilter 同层，
 * 消除反向依赖（底层引擎不再依赖 UI 目录）。
 */
import type { TerminalLine, DisplayFormat, Encoding } from '../types';
import { getLineText } from './lineText';

export interface FindMatchesOptions {
  query: string;
  caseSensitive: boolean;
  /** When 'hex', matches against the hex representation of rawData. */
  displayFormat?: DisplayFormat;
  /** Encoding for lazily decoding RX lines without `content` (issue #14). */
  encoding?: Encoding | string;
}

/**
 * Returns the searchable text for a single terminal line, mirroring the
 * rendering branch in TerminalView (hex display falls back to rawData,
 * everything else uses content, lazily decoded from rawData when absent —
 * issue #14: RX lines carry no decoded string).
 */
export function getSearchableText(
  line: TerminalLine,
  displayFormat?: DisplayFormat,
  encoding?: Encoding | string
): string {
  if (displayFormat === 'hex' && line.rawData) {
    return Array.from(line.rawData, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
  }
  return getLineText(line, encoding ?? 'UTF-8');
}

/**
 * Returns the list of line indices whose searchable text contains `query`.
 * Empty query returns `[]`. Case-insensitive by default.
 */
export function findMatches(
  lines: TerminalLine[],
  options: FindMatchesOptions
): number[] {
  const { query, caseSensitive, displayFormat, encoding } = options;
  if (!query) return [];
  const needle = caseSensitive ? query : query.toLowerCase();
  const result: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const text = getSearchableText(lines[i], displayFormat, encoding);
    const haystack = caseSensitive ? text : text.toLowerCase();
    if (haystack.includes(needle)) result.push(i);
  }
  return result;
}

// ==================== 增量匹配（issue #2-8 性能）====================

/** 上一次匹配计算的快照，供 findMatchesIncremental 做增量收窄。 */
export interface MatchCache {
  query: string;
  caseSensitive: boolean;
  displayFormat?: DisplayFormat;
  encoding?: Encoding | string;
  matches: number[];
  /** 计算时缓冲区的行数（之后新增的行需要补扫）。 */
  lineCount: number;
}

/**
 * 增量匹配：继续输入（新 query 以旧 query 为前缀）时，匹配结果只可能
 * 在「旧匹配 ∪ 新增行」中产生——扫描集从全缓冲缩到这两者，高频接收
 * 场景下每次按键的代价从 O(全部行) 降到 O(旧匹配数 + 新增行数)。
 * 前缀不成立（删字/改字）、大小写或显示格式或编码变化、缓冲被 maxLines
 * 裁剪（lineCount 回退）时自动退回全量 findMatches。
 */
export function findMatchesIncremental(
  lines: TerminalLine[],
  options: FindMatchesOptions,
  prev: MatchCache | null
): number[] {
  const { query, caseSensitive, displayFormat, encoding } = options;
  if (!query) return [];
  if (
    prev &&
    prev.query.length > 0 &&
    query.startsWith(prev.query) &&
    prev.caseSensitive === caseSensitive &&
    prev.displayFormat === displayFormat &&
    prev.encoding === encoding &&
    prev.lineCount <= lines.length
  ) {
    const needle = caseSensitive ? query : query.toLowerCase();
    const result: number[] = [];
    // prev.matches 升序且全部 < prev.lineCount；新增行索引 >= prev.lineCount，
    // 两者串接后依然升序，结果保持升序。
    for (const i of prev.matches) {
      const text = getSearchableText(lines[i], displayFormat, encoding);
      const haystack = caseSensitive ? text : text.toLowerCase();
      if (haystack.includes(needle)) result.push(i);
    }
    for (let i = prev.lineCount; i < lines.length; i++) {
      const text = getSearchableText(lines[i], displayFormat, encoding);
      const haystack = caseSensitive ? text : text.toLowerCase();
      if (haystack.includes(needle)) result.push(i);
    }
    return result;
  }
  return findMatches(lines, options);
}

// ==================== 字符级高亮（issue #2-8）====================

/** 已命名实体表——escapeHtml 只产生前三个，其余是防御性兼容。 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

const ENTITY_RE = /&(?:#x([0-9a-fA-F]+)|#(\d+)|([a-zA-Z]+));/g;

/**
 * 解码 HTML 文本段为纯文本，同时记录每个解码字符对应的**原文偏移**，
 * 以便把纯文本上的匹配区间精确映射回已转义的原文（高亮引擎/协议渲染
 * 的输出含 `&amp;`/`&lt;`/`&gt;` 实体与 `<span>` 标签）。
 */
function decodeWithOffsets(raw: string): { decoded: string; rawOffsets: number[] } {
  const rawOffsets: number[] = [];
  if (!raw.includes('&')) {
    for (let i = 0; i < raw.length; i++) rawOffsets.push(i);
    return { decoded: raw, rawOffsets };
  }
  let decoded = '';
  let last = 0;
  ENTITY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ENTITY_RE.exec(raw)) !== null) {
    for (let i = last; i < m.index; i++) {
      rawOffsets.push(i);
      decoded += raw[i];
    }
    let ch: string;
    if (m[1] !== undefined) ch = String.fromCodePoint(parseInt(m[1], 16));
    else if (m[2] !== undefined) ch = String.fromCodePoint(parseInt(m[2], 10));
    else ch = NAMED_ENTITIES[m[3]] ?? m[0]; // 未知实体原样保留
    // 代理对（如 emoji）解码为 2 个 UTF-16 单元，均指向实体起始偏移
    for (let k = 0; k < ch.length; k++) rawOffsets.push(m.index);
    decoded += ch;
    last = m.index + m[0].length;
  }
  for (let i = last; i < raw.length; i++) {
    rawOffsets.push(i);
    decoded += raw[i];
  }
  return { decoded, rawOffsets };
}

/** 在纯文本中找 query 的全部不重叠出现区间。 */
function findTextOccurrences(
  plain: string,
  query: string,
  caseSensitive: boolean
): Array<{ start: number; end: number }> {
  const result: Array<{ start: number; end: number }> = [];
  if (!plain || !query || query.length > plain.length) return result;
  if (caseSensitive) {
    let idx = plain.indexOf(query);
    while (idx !== -1) {
      result.push({ start: idx, end: idx + query.length });
      idx = plain.indexOf(query, idx + query.length);
    }
    return result;
  }
  const lowerPlain = plain.toLowerCase();
  const lowerQuery = query.toLowerCase();
  if (lowerPlain.length === plain.length && lowerQuery.length === query.length) {
    let idx = lowerPlain.indexOf(lowerQuery);
    while (idx !== -1) {
      result.push({ start: idx, end: idx + lowerQuery.length });
      idx = lowerPlain.indexOf(lowerQuery, idx + lowerQuery.length);
    }
    return result;
  }
  // 罕见：toLowerCase 改变了长度（如 'İ' → 'i̇'）—— 退化为逐字符比较
  for (let s = 0; s + query.length <= plain.length; s++) {
    let ok = true;
    for (let k = 0; k < query.length; k++) {
      if (plain[s + k].toLowerCase() !== query[k].toLowerCase()) { ok = false; break; }
    }
    if (ok) {
      result.push({ start: s, end: s + query.length });
      s += query.length - 1;
    }
  }
  return result;
}

/**
 * 在已渲染的行 HTML（高亮引擎或协议渲染的输出）上叠加搜索字符级
 * `<mark>` 高亮。感知 HTML 标签与实体：只在**文本节点**里匹配，绝不
 * 改动标签/属性；跨越高亮 span 边界的匹配会被拆分到各段分别包裹。
 *
 * 只在命中行上调用（TerminalRow 按 matchSet 过滤），每屏仅 ~50 行，
 * 大缓冲下无全量渲染开销。isCurrentLine 为 true 时叠加 current 样式。
 */
export function markSearchMatchesInHtml(
  html: string,
  query: string,
  caseSensitive: boolean,
  isCurrentLine: boolean
): string {
  if (!html || !query) return html;

  // 1) 切段：<...> 为标签段，其余为文本段
  const segments: Array<{ raw: string; isTag: boolean; decoded: string; rawOffsets: number[] }> = [];
  let i = 0;
  while (i < html.length) {
    if (html[i] === '<') {
      const end = html.indexOf('>', i);
      const tagEnd = end === -1 ? html.length : end + 1;
      segments.push({ raw: html.slice(i, tagEnd), isTag: true, decoded: '', rawOffsets: [] });
      i = tagEnd;
    } else {
      let j = i;
      while (j < html.length && html[j] !== '<') j++;
      const raw = html.slice(i, j);
      const { decoded, rawOffsets } = decodeWithOffsets(raw);
      segments.push({ raw, isTag: false, decoded, rawOffsets });
      i = j;
    }
  }

  // 2) 拼接纯文本并记录 全局字符 → (段, 段内字符) 映射
  const charSeg: number[] = [];
  const charLocal: number[] = [];
  let plain = '';
  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    const seg = segments[segIdx];
    if (seg.isTag) continue;
    for (let k = 0; k < seg.decoded.length; k++) {
      charSeg.push(segIdx);
      charLocal.push(k);
      plain += seg.decoded[k];
    }
  }

  // 3) 找匹配区间，按段归并成 段内 [start,end) 列表
  const occurrences = findTextOccurrences(plain, query, caseSensitive);
  if (occurrences.length === 0) return html;
  const segMarks = new Map<number, Array<{ start: number; end: number }>>();
  for (const { start, end } of occurrences) {
    let c = start;
    while (c < end) {
      const segIdx = charSeg[c];
      const localStart = charLocal[c];
      let localEnd = localStart;
      let d = c;
      while (d < end && charSeg[d] === segIdx && charLocal[d] === localEnd) {
        d++;
        localEnd++;
      }
      let list = segMarks.get(segIdx);
      if (!list) { list = []; segMarks.set(segIdx, list); }
      list.push({ start: localStart, end: localEnd });
      c = d;
    }
  }

  // 4) 重建 HTML：文本段的匹配区间包 <mark>，其余原样输出
  const markClass = `terminal-search-mark${isCurrentLine ? ' current' : ''}`;
  let out = '';
  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    const seg = segments[segIdx];
    if (seg.isTag) { out += seg.raw; continue; }
    const marks = segMarks.get(segIdx);
    if (!marks || marks.length === 0 || seg.decoded.length === 0) { out += seg.raw; continue; }
    let pos = 0;
    for (const r of marks) {
      out += seg.raw.slice(seg.rawOffsets[pos], seg.rawOffsets[r.start]);
      const rawStart = seg.rawOffsets[r.start];
      const rawEnd = r.end < seg.decoded.length ? seg.rawOffsets[r.end] : seg.raw.length;
      out += `<mark class="${markClass}">${seg.raw.slice(rawStart, rawEnd)}</mark>`;
      pos = r.end;
    }
    if (pos < seg.decoded.length) out += seg.raw.slice(seg.rawOffsets[pos]);
  }
  return out;
}

export function formatLineForCopy(line: TerminalLine, encoding?: Encoding | string): string {
  const d = new Date(line.timestamp);
  const ts = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  return `[${ts}] ${line.direction} ${getLineText(line, encoding ?? 'UTF-8')}`;
}
