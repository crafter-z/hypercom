/**
 * TerminalView — thin orchestrator for one port's terminal: virtualizer
 * setup, scroll/wheel/keyboard handling, row rendering, selection state.
 * Display modes (filter/pause) → useTerminalDisplay · search →
 * useTerminalSearch + TerminalSearchBar · strip UI + replay →
 * TerminalFilterBar · rows → TerminalRow · menu → buildTerminalContextMenuItems.
 */
import React, { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import type { TerminalState } from '../../types';
import ContextMenu, { type ContextMenuEntry } from '../shared/ContextMenu';
import { useAppStore } from '../../stores/useAppStore';
import { useOperationStore } from '../../stores/useOperationStore';
import { useRuleStore } from '../../stores/useRuleStore';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { useVirtualizer } from '@tanstack/react-virtual';
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
  const setTerminalConfig = useTerminalStore((s) => s.setTerminalConfig);
  const autoScrollRef = useRef(true);

  // Per-round grouping: lines within ~50ms of their predecessor share a round.
  const firstInRound = useMemo(() => {
    if (timestampMode !== 'perRound' || lines.length === 0) return null;
    const arr = new Array<boolean>(lines.length);
    arr[0] = true;
    for (let i = 1; i < lines.length; i++) {
      arr[i] = !isSameRound(lines[i - 1], lines[i]);
    }
    return arr;
  }, [lines, timestampMode]);

  // Display modes: direction/keyword filtering + pause/freeze (UI-local).
  const {
    directionFilter, setDirectionFilter, keywordInput, setKeywordInput,
    debouncedKeyword, paused, togglePause, filteredIndices, originalToFiltered,
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

  // Sync store's scrollLocked to local ref (for OperationPanel toggle)
  useEffect(() => {
    if (terminal?.scrollLocked !== undefined) {
      autoScrollRef.current = terminal.scrollLocked;
    }
  }, [terminal?.scrollLocked]);

  const getScrollElement = useCallback(() => scrollRef.current, []);
  const estimateSize = useCallback(() => {
    const fontSize = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--font-size-terminal')) || 14;
    return Math.round(fontSize * 1.5);
  }, []);
  const getItemKey = useCallback((index: number) => {
    const orig = filteredIndicesRef.current[index];
    if (orig === undefined) return index;
    return linesRef.current[orig]?.id ?? index;
  }, []);

  const virtualizer = useVirtualizer({
    count: filteredIndices.length,
    getScrollElement,
    estimateSize,
    overscan: 12,
    getItemKey,
    useFlushSync: false,         // Prevent flushSync → synchronous render cascades
  });

  // Search jumps need the filtered-view mapping + virtualizer scroll (both
  // change every render) — exposed via a ref-backed getter so the hook's
  // callbacks stay stable (same pattern as linesRef above).
  const jumpContextRef = useRef<SearchJumpContext>({
    originalToFiltered: new Map(),
    lineCount: 0,
    scrollToFilteredIndex: () => {},
  });
  jumpContextRef.current = {
    originalToFiltered,
    lineCount: lines.length,
    scrollToFilteredIndex: (filteredIndex) => virtualizer.scrollToIndex(filteredIndex, { align: 'center' }),
  };
  const getJumpContext = useCallback(() => jumpContextRef.current, []);

  const {
    searchOpen, searchQuery, caseSensitive, currentMatch, matchIndices,
    setSearchQuery, openSearch, toggleSearch, toggleCase, closeSearch,
    nextMatch, prevMatch,
  } = useTerminalSearch({ lines, displayFormat: terminal?.displayFormat, getJumpContext });

  // Auto-scroll to bottom on new lines; skipped while paused (frozen view).
  // On resume, filteredIndices.length changes and this effect catches up.
  useEffect(() => {
    if (paused) return;
    if (autoScrollRef.current && filteredIndices.length > 0) {
      virtualizer.scrollToIndex(filteredIndices.length - 1, { align: 'end', behavior: 'auto' });
    }
  }, [filteredIndices.length, virtualizer, paused]);

  // Ctrl+wheel font zoom (8–48px, mirrored to the --font-size-terminal var)
  const handleWheel = useCallback((e: React.WheelEvent) => {
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
  }, []);

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
      closeSearch();
      return;
    }
    if (e.ctrlKey && (e.key === 'l' || e.key === 'L')) {
      e.preventDefault();
      useTerminalStore.getState().clearTerminal(portId);
    }
  }, [portId, searchOpen, toggleSearch, openSearch, closeSearch, nextMatch, prevMatch]);

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const el = scrollRef.current;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
    if (atBottom !== autoScrollRef.current) {
      autoScrollRef.current = atBottom;
      if (portId && terminal) {
        setTerminalConfig(portId, { scrollLocked: atBottom });
        // 滚轮解除/恢复滚动锁定时，同步写回 OperationStore，让操作面板
        // 的「钉住」按钮状态与终端实际滚动状态联动（否则仅单向 op→terminal）。
        if (useAppStore.getState().activeTabId === portId) {
          useOperationStore.getState().setOpState({ scrollLocked: atBottom });
        }
      }
    }
  }, [portId, terminal, setTerminalConfig]);

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
    const items = buildTerminalContextMenuItems({
      portId,
      lines: currentLines,
      range,
      timestampMode,
      firstInRound,
      connectedAt: terminal?.connectedAt ?? null,
      timestampFormat,
      t,
      onSelectAll: handleSelectAll,
    });
    setContextMenu({ x: e.clientX, y: e.clientY, items });
    contextLineIndexRef.current = null;
  }, [handleSelectAll, portId, selectedRange, t, timestampMode, firstInRound, terminal?.connectedAt, timestampFormat]);

  const matchSet = useMemo(() => new Set(matchIndices), [matchIndices]);
  const currentMatchLineIdx = matchIndices.length > 0 ? matchIndices[currentMatch] : -1;

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
        direction={directionFilter}
        onDirectionChange={setDirectionFilter}
        keyword={keywordInput}
        onKeywordChange={setKeywordInput}
        matchCount={filteredIndices.length}
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
          onClose={closeSearch}
        />
      )}
      <div
        ref={scrollRef}
        className="terminal-view"
        tabIndex={0}
        onContextMenu={handleContextMenu}
        onScroll={handleScroll}
        onWheel={handleWheel}
        onKeyDown={handleKeyDown}
      >
        <div style={{ height: `${virtualizer.getTotalSize()}px`, width: '100%', position: 'relative' }}>
          {virtualizer.getVirtualItems().map((vRow) => {
            // Filtered row index → original lines[] index, so timestamps,
            // selection, copy and search highlighting target the right line.
            const origIdx = filteredIndices[vRow.index] ?? vRow.index;
            const line = lines[origIdx];
            if (!line) return null;
            return (
              <TerminalRow
                key={vRow.key}
                line={line}
                origIdx={origIdx}
                lines={lines}
                terminal={terminal}
                highlightRuleSets={highlightRuleSets}
                timestampFormat={timestampFormat}
                timestampMode={timestampMode}
                firstInRound={firstInRound}
                selectedRange={selectedRange}
                searchOpen={searchOpen}
                matchSet={matchSet}
                currentMatchLineIdx={currentMatchLineIdx}
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
