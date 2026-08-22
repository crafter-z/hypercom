/**
 * Terminal search hook — UI-local search state backed by the viewport
 * manager (方案B, issue #14).
 *
 * Holds the open flag / query input / case-sensitivity toggle; the manager
 * computes match seqs incrementally (matched once at append time — no
 * per-keystroke buffer rescans while RX flows) and owns match navigation.
 * Readouts (current index, match count) refresh via the manager's render-pass
 * subscription.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { TerminalViewportManager } from '../../utils/terminal/viewportManager';

interface UseTerminalSearchOptions {
  vm: TerminalViewportManager;
}

const QUERY_DEBOUNCE_MS = 150;

export function useTerminalSearch({ vm }: UseTerminalSearchOptions) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [, forceRender] = useState(0);
  const vmRef = useRef(vm);
  vmRef.current = vm;

  // Debounce query input — only recompute matches on the debounced value.
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedQuery(searchQuery), QUERY_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchQuery]);

  // Push open/query/case into the manager (full recompute).
  useEffect(() => {
    vmRef.current.setSearch(searchOpen, debouncedQuery, caseSensitive);
  }, [searchOpen, debouncedQuery, caseSensitive]);

  // Refresh readouts on manager render passes (match list changes as data
  // flows while the search bar is open).
  useEffect(() => {
    return vm.subscribe(() => forceRender((v) => v + 1));
  }, [vm]);

  const openSearch = useCallback(() => setSearchOpen(true), []);
  const toggleSearch = useCallback(() => setSearchOpen((prev) => !prev), []);
  const toggleCase = useCallback(() => setCaseSensitive((v) => !v), []);
  const closeSearch = useCallback(() => {
    // Keep the query so re-opening restores it; clear the debounced value so
    // the manager drops the stale match set immediately.
    setSearchOpen(false);
    setDebouncedQuery('');
  }, []);

  const nextMatch = useCallback(() => {
    vmRef.current.jumpToMatch(vmRef.current.getCurrentMatchIndex() + 1);
  }, []);

  const prevMatch = useCallback(() => {
    vmRef.current.jumpToMatch(vmRef.current.getCurrentMatchIndex() - 1);
  }, []);

  return {
    searchOpen,
    searchQuery,
    caseSensitive,
    currentMatch: vm.getCurrentMatchIndex(),
    searchMatchCount: vm.getMatchCount(),
    setSearchQuery,
    openSearch,
    toggleSearch,
    toggleCase,
    closeSearch,
    nextMatch,
    prevMatch,
  };
}
