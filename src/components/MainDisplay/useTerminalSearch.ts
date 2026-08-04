/**
 * Terminal search state hook — extracted from TerminalView.
 *
 * Owns the UI-local search state (open / query / case-sensitivity / current
 * match), the debounced match computation, and match-jump navigation.
 *
 * Jump navigation is filter-aware: search runs over the FULL line buffer,
 * but a jump must land on a rendered row, so when the target match is hidden
 * by an active direction/keyword filter it advances to the nearest visible
 * match instead (see jumpToMatch).
 *
 * The scroll target is supplied lazily via `getJumpContext` so every returned
 * callback keeps a stable identity across renders — the same stabilization
 * pattern TerminalView uses for the virtualizer (churned function references
 * trigger useVirtualizer's internal memos → notify() during render → loop).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TerminalLine, DisplayFormat } from '../../types';
import { findMatchesIncremental, type MatchCache } from './terminalSearch';

export interface SearchJumpContext {
  /** Original line index → rendered (filtered) row index; `null` when no
   *  filter is active (identity — the original index IS the rendered row). */
  originalToFiltered: Map<number, number> | null;
  /** Number of rows currently rendered (the frozen prefix length while paused). */
  visibleCount: number;
  /** Total line count of the unfiltered buffer. */
  lineCount: number;
  /** Scroll the virtualizer so the given filtered row index is centered. */
  scrollToFilteredIndex: (filteredIndex: number) => void;
}

interface UseTerminalSearchOptions {
  lines: TerminalLine[];
  displayFormat?: DisplayFormat;
  getJumpContext: () => SearchJumpContext;
}

export function useTerminalSearch({
  lines,
  displayFormat,
  getJumpContext,
}: UseTerminalSearchOptions) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [currentMatch, setCurrentMatch] = useState(0); // index into matchIndices

  // 增量匹配缓存（issue #2-8 性能）：继续输入时只重扫旧匹配∪新增行。
  // ref 在 memo 内更新是幂等的（同输入重算结果相同，StrictMode 双渲染安全）。
  const matchCacheRef = useRef<MatchCache | null>(null);

  // 性能关键点：匹配计算**只在搜索栏打开时**进行。关闭状态下即使残留
  // query，高频 RX 批写（lines 身份每批变化）也不再触发全缓冲扫描。
  const matchIndices = useMemo(() => {
    if (!searchOpen) {
      matchCacheRef.current = null;
      return [];
    }
    if (!debouncedQuery) {
      matchCacheRef.current = null;
      return [];
    }
    const matches = findMatchesIncremental(
      lines,
      { query: debouncedQuery, caseSensitive, displayFormat },
      matchCacheRef.current
    );
    matchCacheRef.current = {
      query: debouncedQuery,
      caseSensitive,
      displayFormat,
      matches,
      lineCount: lines.length,
    };
    return matches;
  }, [lines, debouncedQuery, caseSensitive, displayFormat, searchOpen]);

  // Debounce search input (~150ms) — only recompute matches on debounced value
  useEffect(() => {
    const handle = setTimeout(() => {
      setDebouncedQuery(searchQuery);
      setCurrentMatch(0);
    }, 150);
    return () => clearTimeout(handle);
  }, [searchQuery]);

  // Clamp currentMatch when matchIndices shrinks
  useEffect(() => {
    if (matchIndices.length === 0) {
      if (currentMatch !== 0) setCurrentMatch(0);
      return;
    }
    if (currentMatch >= matchIndices.length) {
      setCurrentMatch(matchIndices.length - 1);
    }
  }, [matchIndices, currentMatch]);

  // Refs keep jump/next/prev callback identities stable across renders.
  const matchIndicesRef = useRef(matchIndices);
  matchIndicesRef.current = matchIndices;
  const currentMatchRef = useRef(currentMatch);
  currentMatchRef.current = currentMatch;

  const jumpToMatch = useCallback((idx: number) => {
    const matches = matchIndicesRef.current;
    if (matches.length === 0) return;
    const { originalToFiltered, visibleCount, lineCount, scrollToFilteredIndex } = getJumpContext();
    let clamped = ((idx % matches.length) + matches.length) % matches.length;
    // Search runs over the FULL view, but the jump must land on a rendered
    // row. A match is rendered iff it survives the active filter (map lookup)
    // or — when no filter is active (map === null, identity) — iff it lies
    // within the visible prefix (matches[i] < visibleCount), which also keeps
    // paused views from jumping past the frozen prefix. If the target match
    // is hidden, advance to the nearest visible match; if NO match is
    // visible, leave state unchanged so the UI never points at a hidden line.
    const map = originalToFiltered;
    const isVisible = (origIdx: number): boolean =>
      map !== null ? map.has(origIdx) : origIdx < visibleCount;
    if ((map !== null ? map.size : visibleCount) < lineCount) {
      if (!isVisible(matches[clamped])) {
        let foundVisible = false;
        for (let step = 1; step < matches.length; step++) {
          const candidate = (clamped + step) % matches.length;
          if (isVisible(matches[candidate])) {
            clamped = candidate;
            foundVisible = true;
            break;
          }
        }
        if (!foundVisible) return;
      }
    }
    // Rendered row index: map lookup when filtered, identity otherwise.
    const virtIdx = map !== null ? map.get(matches[clamped]) : matches[clamped];
    if (virtIdx === undefined) return;
    setCurrentMatch(clamped);
    scrollToFilteredIndex(virtIdx);
  }, [getJumpContext]);

  const nextMatch = useCallback(() => {
    jumpToMatch(currentMatchRef.current + 1);
  }, [jumpToMatch]);

  const prevMatch = useCallback(() => {
    jumpToMatch(currentMatchRef.current - 1);
  }, [jumpToMatch]);

  const openSearch = useCallback(() => setSearchOpen(true), []);
  const toggleSearch = useCallback(() => setSearchOpen((prev) => !prev), []);
  const toggleCase = useCallback(() => setCaseSensitive((v) => !v), []);
  const closeSearch = useCallback(() => {
    // Keep query so re-opening restores it; clear debounced to stop recompute churn
    setSearchOpen(false);
  }, []);

  return {
    searchOpen,
    searchQuery,
    debouncedQuery,
    caseSensitive,
    currentMatch,
    matchIndices,
    setSearchQuery,
    openSearch,
    toggleSearch,
    toggleCase,
    closeSearch,
    jumpToMatch,
    nextMatch,
    prevMatch,
  };
}
