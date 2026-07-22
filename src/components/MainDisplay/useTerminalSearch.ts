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
import { findMatches } from './terminalSearch';

export interface SearchJumpContext {
  /** Original line index → rendered (filtered) row index. */
  originalToFiltered: Map<number, number>;
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

  const matchIndices = useMemo(
    () => findMatches(lines, {
      query: debouncedQuery,
      caseSensitive,
      displayFormat,
    }),
    [lines, debouncedQuery, caseSensitive, displayFormat]
  );

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
    const { originalToFiltered, lineCount, scrollToFilteredIndex } = getJumpContext();
    let clamped = ((idx % matches.length) + matches.length) % matches.length;
    // Search runs over the FULL view, but the jump must land on a rendered
    // row: if the target match is hidden by an active filter, advance to the
    // nearest visible match instead. If NO match survives the filter, leave
    // state unchanged so the UI never points at a hidden line.
    if (originalToFiltered.size < lineCount) {
      if (!originalToFiltered.has(matches[clamped])) {
        let foundVisible = false;
        for (let step = 1; step < matches.length; step++) {
          const candidate = (clamped + step) % matches.length;
          if (originalToFiltered.has(matches[candidate])) {
            clamped = candidate;
            foundVisible = true;
            break;
          }
        }
        if (!foundVisible) return;
      }
    }
    const virtIdx = originalToFiltered.get(matches[clamped]);
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
