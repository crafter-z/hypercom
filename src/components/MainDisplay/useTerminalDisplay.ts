/**
 * Terminal display pipeline hook — extracted from TerminalView.
 *
 * Owns the UI-local display modes (direction + keyword filtering with
 * debounce, pause/freeze) and derives the index structures the virtualizer
 * renders from: `filteredIndices` (original line indices that survive the
 * filters) and `originalToFiltered` (the reverse map search jumps use).
 *
 * This state is deliberately NOT in Zustand — it resets on tab remount.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TerminalLine } from '../../types';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { filterLines, type DirectionFilter } from '../../utils/lineFilter';

interface UseTerminalDisplayOptions {
  portId: string;
  lines: TerminalLine[];
}

export function useTerminalDisplay({ portId, lines }: UseTerminalDisplayOptions) {
  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>('all');
  const [keywordInput, setKeywordInput] = useState('');
  const [debouncedKeyword, setDebouncedKeyword] = useState('');

  // While paused, lines keep accumulating in the store; the view renders only
  // the snapshot prefix lines.slice(0, frozenCount) — a prefix slice preserves
  // original indices, so filteredIndices still maps into `lines` correctly.
  const [paused, setPaused] = useState(false);
  const [frozenCount, setFrozenCount] = useState<number | null>(null);

  // Debounce keyword filter input (200ms) — only refilter on debounced value
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedKeyword(keywordInput), 200);
    return () => clearTimeout(handle);
  }, [keywordInput]);

  // Pause snapshots the LIVE line count from the store (the render closure
  // may lag a few events behind); resume clears it so accumulated lines show.
  const togglePause = useCallback(() => {
    if (paused) {
      setFrozenCount(null);
      setPaused(false);
    } else {
      const live = useTerminalStore.getState().terminals[portId]?.lines.length ?? 0;
      setFrozenCount(live);
      setPaused(true);
    }
  }, [paused, portId]);

  const visibleLines = useMemo(
    () => (paused && frozenCount !== null ? lines.slice(0, frozenCount) : lines),
    [lines, paused, frozenCount]
  );

  // Data-level filtering: original indices into `lines` that pass both the
  // direction and keyword filters — the virtualizer renders exactly
  // filteredIndices.length rows, never hidden DOM nodes.
  const filteredIndices = useMemo(
    () => filterLines(visibleLines, { direction: directionFilter, keyword: debouncedKeyword }),
    [visibleLines, directionFilter, debouncedKeyword]
  );

  // Reverse map: original line index → filtered row index (identity when no filter).
  const originalToFiltered = useMemo(() => {
    const m = new Map<number, number>();
    for (let i = 0; i < filteredIndices.length; i++) m.set(filteredIndices[i], i);
    return m;
  }, [filteredIndices]);

  return {
    directionFilter,
    setDirectionFilter,
    keywordInput,
    setKeywordInput,
    debouncedKeyword,
    paused,
    togglePause,
    filteredIndices,
    originalToFiltered,
  };
}
