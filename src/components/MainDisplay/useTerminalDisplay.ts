/**
 * Terminal display pipeline hook — UI-local display modes backed by the
 * viewport manager (方案B, issue #14).
 *
 * Owns the direction + keyword filter inputs (debounced) and the pause
 * toggle. The actual filtering (incremental seq matching) lives in
 * `TerminalViewportManager` — the hook just pushes debounced values into it.
 *
 * This state is deliberately NOT in Zustand — it resets on tab remount.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DirectionFilter } from '../../utils/lineFilter';
import type { TerminalViewportManager } from '../../utils/terminal/viewportManager';

interface UseTerminalDisplayOptions {
  vm: TerminalViewportManager;
}

const KEYWORD_DEBOUNCE_MS = 200;

export function useTerminalDisplay({ vm }: UseTerminalDisplayOptions) {
  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>('all');
  const [keywordInput, setKeywordInput] = useState('');
  const [debouncedKeyword, setDebouncedKeyword] = useState('');
  const [paused, setPaused] = useState(false);
  const vmRef = useRef(vm);
  vmRef.current = vm;

  // Debounce keyword filter input — only refilter on the debounced value.
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedKeyword(keywordInput), KEYWORD_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [keywordInput]);

  // Push filter changes into the manager (full recompute, one render).
  useEffect(() => {
    vmRef.current.setFilter(directionFilter, debouncedKeyword);
  }, [directionFilter, debouncedKeyword]);

  // Pause freezes the rendered window at the current newest line; data keeps
  // accumulating in the ring buffer.
  const togglePause = useCallback(() => {
    setPaused((prev) => {
      vmRef.current.setPaused(!prev);
      return !prev;
    });
  }, []);

  return {
    directionFilter,
    setDirectionFilter,
    keywordInput,
    setKeywordInput,
    debouncedKeyword,
    paused,
    togglePause,
  };
}
