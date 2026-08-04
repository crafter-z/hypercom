/**
 * TerminalView — thin orchestrator for one port's terminal: virtualizer
 * setup, scroll/wheel/keyboard handling, row rendering, selection state.
 * Display modes (filter/pause) → useTerminalDisplay · search →
 * useTerminalSearch + TerminalSearchBar · strip UI + replay →
 * TerminalFilterBar · rows → TerminalRow · menu → buildTerminalContextMenuItems.
 *
 * SCROLL-LOCK DESIGN: `scrollLocked` (per-tab, in useTerminalStore) changes
 * ONLY via explicit user intent — the pin toggle, the quick-jump buttons, or
 * the settle() evaluation that runs ~120ms after a user scroll gesture ends.
 * There is deliberately NO onScroll handler: raw scroll events also fire for
 * programmatic scrolls, mount-at-top, virtualizer measurement lag, content
 * growth and maxLines-trim clamping, and letting them write scrollLocked was
 * the root cause of the implicit-unlock bugs.
 */
import React, { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import type { TerminalState } from '../../types';
import ContextMenu, { type ContextMenuEntry } from '../shared/ContextMenu';
import { useAppStore } from '../../stores/useAppStore';
import { useRuleStore } from '../../stores/useRuleStore';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowUpToLine, ArrowDownToLine } from 'lucide-react';
import { isSameRound } from '../../utils/timeFormat';
import { useTranslation } from 'react-i18next';
import { useTerminalDisplay } from './useTerminalDisplay';
import { useTerminalSearch, type SearchJumpContext } from './useTerminalSearch';
import TerminalSearchBar from './TerminalSearchBar';
import TerminalFilterBar from './TerminalFilterBar';
import TerminalRow from './TerminalRow';
import { buildTerminalContextMenuItems } from './terminalContextMenu';

interface TerminalViewProps {
  portId: string;
  terminal: TerminalState | undefined;
}

const TerminalView: React.FC<TerminalViewProps> = ({ portId, terminal }) => {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; items: ContextMenuEntry[] } | null>(null);
  const lines = terminal?.lines ?? [];
  const highlightRuleSets = useRuleStore((s) => s.highlightRuleSets);
  const protocolTemplates = useRuleStore((s) => s.protocolTemplates);
  const protocolTemplateId = useAppStore((s) => s.ports.find(p => p.id === portId)?.protocolTemplateId);
  const timestampFormat = useAppStore((s) => s.config.timestampFormat);
  const timestampMode = useAppStore((s) => s.config.timestampMode);
  const terminalFontSize = useAppStore((s) => s.config.terminalFontSize);
  const setTerminalConfig = useTerminalStore((s) => s.setTerminalConfig);

  // Mirrors terminal.scrollLocked — the single follow-flag read by the
  // auto-follow effect. Written only by the sync effect below (store-driven).
  const followRef = useRef(true);
  // Current rendered row count — scrollToBottom reads it through this ref so
  // its identity stays stable (STABILIZATION pattern).
  const countRef = useRef(0);

  // Gesture system: explicit user-scroll detection. While a gesture is
  // active, auto-follow is suppressed; when it settles (120ms of quiet),
  // settle() derives the NEW scrollLocked from the final position — the only
  // place scroll input can change the lock state.
  const gestureActiveRef = useRef(false);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const pointerHoldRef = useRef(false);

  // Display modes: direction/keyword filtering + pause/freeze (UI-local).
  const {
    directionFilter, setDirectionFilter, keywordInput, setKeywordInput,
    debouncedKeyword, paused, togglePause, visibleCount, filteredIndices, originalToFiltered,
  } = useTerminalDisplay({ portId, lines });

  // Selection state (UI-local); contextLineIndexRef backs the context menu's
  // "copy selected lines" fallback for the right-clicked row.
  const [selectedRange, setSelectedRange] = useState<{ start: number; end: number } | null>(null);
  const lastClickIndexRef = useRef<number | null>(null);
  const contextLineIndexRef = useRef<number | null>(null);

  // STABILIZATION (do not remove): virtualizer callbacks must keep stable
  // identities, so they close over refs kept current each render instead of
  // the render-scoped values. Churned references make useVirtualizer's
  // internal memos detect a dep change → onChange → notify() → rerender()
  // DURING render → infinite loop.
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const filteredIndicesRef = useRef(filteredIndices);
  filteredIndicesRef.current = filteredIndices;

  // null sentinel = no filter active → identity mapping, render the visible
  // prefix directly; otherwise render exactly the surviving indices.
  const renderedCount = filteredIndices ? filteredIndices.length : visibleCount;
  countRef.current = renderedCount;

  // O(1) identity primitives for the auto-follow effect: the buffer trims
  // from the HEAD once maxLines is full (lines.length stays constant), so
  // renderedCount alone never changes even though every getItemKey shifts —
  // these ids make the effect re-pin on new rows (lastLineId) AND on head
  // trims (firstLineId).
  const lastLineId = lines.length > 0 ? lines[lines.length - 1].id : undefined;
  const firstLineId = lines.length > 0 ? lines[0].id : undefined;

  const getScrollElement = useCallback(() => scrollRef.current, []);
  // Row height estimate from the store font size (kept in sync with the
  // --font-size-terminal var by ThemeProvider + the Ctrl+wheel handler) —
  // avoids a per-call getComputedStyle on the hot virtualizer path.
  const estimateSize = useCallback(() => Math.round(terminalFontSize * 1.5), [terminalFontSize]);
  const getItemKey = useCallback((index: number) => {
    const indices = filteredIndicesRef.current;
    const orig = indices ? indices[index] : index;
    if (orig === undefined) return index;
    return linesRef.current[orig]?.id ?? index;
  }, []);

  const virtualizer = useVirtualizer({
    count: renderedCount,
    getScrollElement,
    estimateSize,
    overscan: 12,
    getItemKey,
    useFlushSync: false,         // Prevent flushSync → synchronous render cascades
  });

  // Scroll to the last rendered row; reads the live count through countRef.
  const scrollToBottom = useCallback(() => {
    const count = countRef.current;
    if (count > 0) {
      virtualizer.scrollToIndex(count - 1, { align: 'end', behavior: 'auto' });
    }
    // Measurement-lag fallback: scrollToIndex targets the last item's
    // (possibly estimated) end — unmeasured tail rows are estimateSize until
    // ResizeObserver lands, so totalSize can grow and stale the scrollTop.
    // One frame later the measurements are in; pin the real bottom directly.
    // Touches ONLY scrollTop — never scrollLocked/followRef.
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, [virtualizer]);

  // Sync the store's scrollLocked to followRef. Explicit-intent transitions:
  // on false→true OR on first render with locked=true (tab remount of a
  // locked tab — Pane keys TerminalView by tabId) jump to the latest row
  // immediately, fixing "click pin doesn't jump" and "locked tab loses its
  // position after tab switch". Mount with locked=false shows the buffer top.
  const prevLockedRef = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    const locked = terminal?.scrollLocked;
    if (locked === undefined) return;
    const prev = prevLockedRef.current;
    prevLockedRef.current = locked;
    followRef.current = locked;
    const becameLocked = prev === undefined ? locked : locked && !prev;
    if (becameLocked) scrollToBottom();
  }, [terminal?.scrollLocked, scrollToBottom]);

  // Settle handler: a user scroll gesture ended — derive scrollLocked from
  // the final position (50px tolerance absorbs virtualizer layout lag).
  const settle = useCallback(() => {
    gestureActiveRef.current = false;
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 50;
    if (atBottom !== useTerminalStore.getState().terminals[portId]?.scrollLocked) {
      setTerminalConfig(portId, { scrollLocked: atBottom });
    }
  }, [portId, setTerminalConfig]);

  const beginGesture = useCallback(() => {
    gestureActiveRef.current = true;
    clearTimeout(settleTimerRef.current);
    settleTimerRef.current = setTimeout(settle, 120);
  }, [settle]);

  // Cleanup the settle timer on unmount.
  useEffect(() => () => clearTimeout(settleTimerRef.current), []);

  // Ctrl+wheel font zoom (8–48px, mirrored to the --font-size-terminal var);
  // every wheel event is also an explicit scroll gesture.
  const handleWheel = useCallback((e: React.WheelEvent) => {
    beginGesture();
    if (!e.ctrlKey) return;
    e.preventDefault();
    const store = useAppStore.getState();
    const current = store.config.terminalFontSize;
    const delta = e.deltaY > 0 ? -1 : 1;
    const next = Math.max(8, Math.min(48, current + delta));
    if (next !== current) {
      document.documentElement.style.setProperty('--font-size-terminal', `${next}px`);
      store.setConfig({ terminalFontSize: next });
    }
  }, [beginGesture]);

  // Scrollbar drag / middle-click autoscroll start: target===currentTarget
  // means the pointer hit the scroll container itself (the scrollbar track
  // or thumb — row divs are nested deeper); button===1 covers Windows
  // middle-click autoscroll. Hold the gesture open until pointer-up.
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button === 1 || e.target === e.currentTarget) {
      gestureActiveRef.current = true;
      pointerHoldRef.current = true;
      clearTimeout(settleTimerRef.current);
    }
  }, []);

  const handlePointerUp = useCallback(() => {
    if (!pointerHoldRef.current) return;
    pointerHoldRef.current = false;
    clearTimeout(settleTimerRef.current);
    settleTimerRef.current = setTimeout(settle, 120);
  }, [settle]);

  // Search jumps need the filtered-view mapping + virtualizer scroll (both
  // change every render) — exposed via a ref-backed getter so the hook's
  // callbacks stay stable (same pattern as linesRef above).
  const jumpContextRef = useRef<SearchJumpContext>({
    originalToFiltered: null,
    visibleCount: 0,
    lineCount: 0,
    scrollToFilteredIndex: () => {},
  });
  jumpContextRef.current = {
    originalToFiltered,
    visibleCount,
    lineCount: lines.length,
    scrollToFilteredIndex: (filteredIndex) => virtualizer.scrollToIndex(filteredIndex, { align: 'center' }),
  };
  const getJumpContext = useCallback(() => jumpContextRef.current, []);

  const {
    searchOpen, searchQuery, debouncedQuery, caseSensitive, currentMatch, matchIndices,
    setSearchQuery, openSearch, toggleSearch, toggleCase, closeSearch,
    nextMatch, prevMatch,
  } = useTerminalSearch({ lines, displayFormat: terminal?.displayFormat, getJumpContext });

  // Follow suppression while the search bar is open — the view must not snap
  // back under the user's current match. Updated during render so effects
  // (which run after render) always see the current value.
  const searchOpenRef = useRef(searchOpen);
  searchOpenRef.current = searchOpen;

  // Closing search re-engages follow when the store says scrollLocked: the
  // auto-follow effect won't refire on its own (no count change), so jump
  // back to latest explicitly.
  const handleSearchClose = useCallback(() => {
    closeSearch();
    if (useTerminalStore.getState().terminals[portId]?.scrollLocked) {
      scrollToBottom();
    }
  }, [closeSearch, portId, scrollToBottom]);

  // Auto-follow: keep the bottom row in view as new rows render. Runs on
  // count changes OR on line-identity changes — lastLineId moves with every
  // new row (splice keeps the length constant once maxLines is full), and
  // firstLineId moves when the buffer trims from the head, which is exactly
  // when the virtualizer re-keys every row and shifts content under a stable
  // scrollTop. Skipped while paused (frozen view), unlocked, mid-gesture
  // (explicit user scroll), or while search is open. On resume the count
  // changes and this effect catches up.
  useEffect(() => {
    if (paused || !followRef.current || gestureActiveRef.current || searchOpenRef.current) return;
    scrollToBottom();
  }, [renderedCount, lastLineId, firstLineId, virtualizer, paused, scrollToBottom]);

  // Ctrl+L clears, Ctrl+F toggles search, F3/Shift+F3 step matches, Esc closes
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.ctrlKey && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      toggleSearch();
      return;
    }
    if (e.key === 'F3') {
      e.preventDefault();
      if (!searchOpen) openSearch();
      if (e.shiftKey) prevMatch();
      else nextMatch();
      return;
    }
    if (e.key === 'Escape' && searchOpen) {
      e.preventDefault();
      handleSearchClose();
      return;
    }
    if (e.ctrlKey && (e.key === 'l' || e.key === 'L')) {
      e.preventDefault();
      useTerminalStore.getState().clearTerminal(portId);
      return;
    }
    // Native keyboard scrolling on the focused container is an explicit
    // gesture — settle() evaluates the final position (Ctrl+Home/End share
    // the key names and are covered too).
    if (e.target === e.currentTarget && ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) {
      beginGesture();
    }
  }, [portId, searchOpen, toggleSearch, openSearch, handleSearchClose, nextMatch, prevMatch, beginGesture]);

  // Quick-jump button targets (pinned at the scrollbar ends). Both are
  // explicit intent: they WRITE scrollLocked.
  const jumpToTop = useCallback(() => {
    setTerminalConfig(portId, { scrollLocked: false });
    virtualizer.scrollToIndex(0, { align: 'start', behavior: 'auto' });
  }, [portId, setTerminalConfig, virtualizer]);

  const jumpToBottom = useCallback(() => {
    setTerminalConfig(portId, { scrollLocked: true });
    scrollToBottom();
  }, [portId, setTerminalConfig, scrollToBottom]);

  const handleSelectAll = useCallback(() => {
    const sel = window.getSelection();
    if (sel && scrollRef.current) {
      const range = document.createRange();
      range.selectNodeContents(scrollRef.current);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }, []);

  // Shift+click extends the selection from the last clicked row (the anchor
  // does not move on shift+click); a plain click clears it.
  const handleRowClick = useCallback((e: React.MouseEvent, index: number) => {
    if (e.shiftKey && lastClickIndexRef.current !== null) {
      const start = Math.min(lastClickIndexRef.current, index);
      const end = Math.max(lastClickIndexRef.current, index);
      setSelectedRange({ start, end });
      return;
    }
    lastClickIndexRef.current = index;
    setSelectedRange(null);
  }, []);

  // Row right-click: record the index; the container's onContextMenu builds
  // the menu (and resets the index afterwards).
  const handleRowContextMenu = useCallback((_e: React.MouseEvent, index: number) => {
    contextLineIndexRef.current = index;
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const currentLines = useTerminalStore.getState().terminals[portId]?.lines ?? [];
    const clickedIdx = contextLineIndexRef.current;
    // No shift-click range → fall back to the single right-clicked line.
    const range = selectedRange ?? (
      clickedIdx !== null ? { start: clickedIdx, end: clickedIdx } : null
    );
    // On-demand first-in-round check over the menu's own snapshot — O(1) per
    // exported line instead of a precomputed boolean[] over the whole buffer.
    const isFirstInRound = (idx: number): boolean => {
      if (idx <= 0) return true;
      const prev = currentLines[idx - 1];
      const cur = currentLines[idx];
      if (!prev || !cur) return true;
      return !isSameRound(prev, cur);
    };
    const items = buildTerminalContextMenuItems({
      portId,
      lines: currentLines,
      range,
      timestampMode,
      isFirstInRound,
      connectedAt: terminal?.connectedAt ?? null,
      timestampFormat,
      t,
      onSelectAll: handleSelectAll,
    });
    setContextMenu({ x: e.clientX, y: e.clientY, items });
    contextLineIndexRef.current = null;
  }, [handleSelectAll, portId, selectedRange, t, timestampMode, terminal?.connectedAt, timestampFormat]);

  const matchSet = useMemo(() => new Set(matchIndices), [matchIndices]);
  const currentMatchLineIdx = matchIndices.length > 0 ? matchIndices[currentMatch] : -1;
  const scrollLocked = terminal?.scrollLocked === true;

  return (
    <div className="terminal-view-container">
      {protocolTemplates.length > 0 && (
        <div className="terminal-protocol-bar">
          <span className="eyebrow">{t('terminalView.protocolLabel')}</span>
          <select
            className="select terminal-bar-select"
            value={protocolTemplateId || ''}
            onChange={(e) => {
              useAppStore.getState().updatePort(portId, { protocolTemplateId: e.target.value || undefined });
            }}
          >
            <option value="">{t('terminalView.protocolNone')}</option>
            {protocolTemplates.filter(tpl => tpl.isEnabled).map(tpl => (
              <option key={tpl.id} value={tpl.id}>{tpl.name}</option>
            ))}
          </select>
        </div>
      )}
      <TerminalFilterBar
        portId={portId}
        encoding={terminal?.encoding}
        scrollLocked={terminal?.scrollLocked}
        showTimestamp={terminal?.showTimestamp}
        displayFormat={terminal?.displayFormat}
        direction={directionFilter}
        onDirectionChange={setDirectionFilter}
        keyword={keywordInput}
        onKeywordChange={setKeywordInput}
        matchCount={renderedCount}
        showMatchCount={debouncedKeyword.trim().length > 0}
        paused={paused}
        onTogglePause={togglePause}
      />
      {searchOpen && (
        <TerminalSearchBar
          query={searchQuery}
          onQueryChange={setSearchQuery}
          caseSensitive={caseSensitive}
          onToggleCase={toggleCase}
          matchIndex={matchIndices.length > 0 ? currentMatch : -1}
          matchCount={matchIndices.length}
          onNext={nextMatch}
          onPrev={prevMatch}
          onClose={handleSearchClose}
        />
      )}
      <div className="terminal-scroll-wrap">
        <div
          ref={scrollRef}
          className="terminal-view"
          tabIndex={0}
          onContextMenu={handleContextMenu}
          onWheel={handleWheel}
          onKeyDown={handleKeyDown}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          <div style={{ height: `${virtualizer.getTotalSize()}px`, width: '100%', position: 'relative' }}>
            {virtualizer.getVirtualItems().map((vRow) => {
              // Filtered row index → original lines[] index, so timestamps,
              // selection, copy and search highlighting target the right line.
              // null filteredIndices → identity (no filter active).
              const origIdx = filteredIndices ? (filteredIndices[vRow.index] ?? vRow.index) : vRow.index;
              const line = lines[origIdx];
              if (!line) return null;
              // O(1) per-row round boundary (replaces the precomputed
              // boolean[] over the whole buffer).
              const isFirstInRound = timestampMode !== 'perRound'
                ? true
                : origIdx === 0 || !isSameRound(lines[origIdx - 1], line);
              return (
                <TerminalRow
                  key={vRow.key}
                  line={line}
                  origIdx={origIdx}
                  prevLine={origIdx > 0 ? lines[origIdx - 1] : undefined}
                  displayFormat={terminal?.displayFormat}
                  showTimestamp={terminal?.showTimestamp}
                  connectedAt={terminal?.connectedAt}
                  highlightRuleSets={highlightRuleSets}
                  timestampFormat={timestampFormat}
                  timestampMode={timestampMode}
                  isFirstInRound={isFirstInRound}
                  selectedRange={selectedRange}
                  searchOpen={searchOpen}
                  matchSet={matchSet}
                  currentMatchLineIdx={currentMatchLineIdx}
                  searchQuery={searchOpen ? debouncedQuery : ''}
                  searchCaseSensitive={caseSensitive}
                  rowIndex={vRow.index}
                  rowStart={vRow.start}
                  measureRef={virtualizer.measureElement}
                  onRowClick={handleRowClick}
                  onRowContextMenu={handleRowContextMenu}
                />
              );
            })}
          </div>
        </div>
        <button
          type="button"
          className="terminal-jump-btn top"
          title={t('terminal.jumpToTop')}
          aria-label={t('terminal.jumpToTop')}
          onClick={jumpToTop}
        >
          <ArrowUpToLine size={13} />
        </button>
        <button
          type="button"
          className={`terminal-jump-btn bottom${scrollLocked ? ' active' : ''}`}
          title={t('terminal.jumpToBottom')}
          aria-label={t('terminal.jumpToBottom')}
          onClick={jumpToBottom}
        >
          <ArrowDownToLine size={13} />
        </button>
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
};

export default TerminalView;
