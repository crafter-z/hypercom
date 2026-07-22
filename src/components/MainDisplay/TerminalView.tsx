import React, { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import type { TerminalState } from '../../types';
import ContextMenu, { type ContextMenuEntry } from '../shared/ContextMenu';
import { applyHighlightSets } from '../../utils/highlightEngine';
import { renderProtocolLine } from '../../utils/protocolRenderer';
import { useAppStore } from '../../stores/useAppStore';
import { useRuleStore } from '../../stores/useRuleStore';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { useVirtualizer } from '@tanstack/react-virtual';
import { save, open } from '@tauri-apps/plugin-dialog';
import { logService } from '../../services/tauri';
import { hexToString, stringToHex } from '../../utils/hexUtils';
import { formatTerminalTimestamp, isSameRound } from '../../utils/timeFormat';
import { useTranslation } from 'react-i18next';
import { X, ChevronUp, ChevronDown, Type, Pause, Play, Filter, History, Square } from 'lucide-react';
import { findMatches, formatLineForCopy } from './terminalSearch';
import { filterLines, type DirectionFilter } from '../../utils/lineFilter';
import { notifyError } from '../../stores/useToastStore';
import { useLogReplay } from './hooks/useLogReplay';

interface TerminalViewProps {
  portId: string;
  terminal: TerminalState | undefined;
}

function exportTimestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

interface SearchBarProps {
  query: string;
  onQueryChange: (q: string) => void;
  caseSensitive: boolean;
  onToggleCase: () => void;
  matchIndex: number;   // 0-based index into matchIndices, -1 if none
  matchCount: number;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}

const SearchBar: React.FC<SearchBarProps> = ({
  query,
  onQueryChange,
  caseSensitive,
  onToggleCase,
  matchIndex,
  matchCount,
  onNext,
  onPrev,
  onClose,
}) => {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);

  // Autofocus on mount and when re-opened
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Local key handler: Enter / Shift+Enter / Escape. Stop propagation so the
  // terminal container's onKeyDown doesn't also process them.
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) onPrev();
      else onNext();
    }
  }, [onClose, onNext, onPrev]);

  const counterText = matchCount === 0
    ? t('terminal.search.noResults')
    : t('terminal.search.counter', { current: matchIndex + 1, total: matchCount });

  return (
    <div className="terminal-search-bar">
      <input
        ref={inputRef}
        type="text"
        className="terminal-search-input"
        value={query}
        placeholder={t('terminal.search.placeholder')}
        title={t('terminal.search.tooltip.shortcut')}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      <span className={`terminal-search-counter${matchCount === 0 ? ' no-results' : ''}`}>
        {counterText}
      </span>
      <button
        type="button"
        className={`terminal-search-btn${caseSensitive ? ' active' : ''}`}
        onClick={onToggleCase}
        title={caseSensitive
          ? t('terminal.search.caseSensitiveActive')
          : t('terminal.search.caseSensitive')}
        aria-pressed={caseSensitive}
      >
        <Type size={13} />
      </button>
      <button
        type="button"
        className="terminal-search-btn"
        onClick={onPrev}
        disabled={matchCount === 0}
        title={t('terminal.search.previous')}
      >
        <ChevronUp size={14} />
      </button>
      <button
        type="button"
        className="terminal-search-btn"
        onClick={onNext}
        disabled={matchCount === 0}
        title={t('terminal.search.next')}
      >
        <ChevronDown size={14} />
      </button>
      <button
        type="button"
        className="terminal-search-btn"
        onClick={onClose}
        title={t('terminal.search.close')}
      >
        <X size={14} />
      </button>
    </div>
  );
};

const DIRECTION_LABEL_KEYS: Record<DirectionFilter, string> = {
  all: 'terminal.filter.all',
  TX: 'terminal.filter.txOnly',
  RX: 'terminal.filter.rxOnly',
};

const DIRECTION_OPTIONS: DirectionFilter[] = ['all', 'TX', 'RX'];

interface FilterBarProps {
  direction: DirectionFilter;
  onDirectionChange: (d: DirectionFilter) => void;
  keyword: string;
  onKeywordChange: (k: string) => void;
  matchCount: number;      // visible line count while the keyword filter is active
  showMatchCount: boolean; // true when the debounced keyword is non-empty
  paused: boolean;
  onTogglePause: () => void;
  isReplaying: boolean;
  replaySpeed: number;
  onReplaySpeedChange: (s: number) => void;
  onStartReplay: () => void;
  onStopReplay: () => void;
}

const FilterBar: React.FC<FilterBarProps> = ({
  direction,
  onDirectionChange,
  keyword,
  onKeywordChange,
  matchCount,
  showMatchCount,
  paused,
  onTogglePause,
  isReplaying,
  replaySpeed,
  onReplaySpeedChange,
  onStartReplay,
  onStopReplay,
}) => {
  const { t } = useTranslation();

  // Escape clears the keyword filter (stopPropagation so the terminal
  // container's Escape → close-search handler doesn't also fire).
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onKeywordChange('');
    }
  }, [onKeywordChange]);

  return (
    <div className="terminal-filter-bar">
      <Filter size={13} className="terminal-filter-icon" aria-hidden="true" />
      <div className="terminal-filter-segment" role="group">
        {DIRECTION_OPTIONS.map((d) => (
          <button
            key={d}
            type="button"
            className={`terminal-filter-seg-btn${direction === d ? ' active' : ''}`}
            onClick={() => onDirectionChange(d)}
            aria-pressed={direction === d}
          >
            {t(DIRECTION_LABEL_KEYS[d])}
          </button>
        ))}
      </div>
      <input
        type="text"
        className="terminal-filter-input"
        value={keyword}
        placeholder={t('terminal.filter.keywordPlaceholder')}
        onChange={(e) => onKeywordChange(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      {showMatchCount && (
        <span className={`terminal-filter-count${matchCount === 0 ? ' no-results' : ''}`}>
          {t('terminal.filter.matchCount', { count: matchCount })}
        </span>
      )}
      <div className="terminal-filter-spacer" />
      {paused && (
        <span className="terminal-filter-paused">
          <span className="terminal-filter-paused-dot" />
          {t('terminal.filter.paused')}
        </span>
      )}
      <button
        type="button"
        className={`terminal-filter-btn${paused ? ' active' : ''}`}
        onClick={onTogglePause}
        title={paused ? t('terminal.filter.resume') : t('terminal.filter.pause')}
        aria-pressed={paused}
      >
        {paused ? <Play size={13} /> : <Pause size={13} />}
      </button>
      <select
        className="select"
        style={{ fontSize: 10, padding: '1px 4px', height: 22, width: 52 }}
        value={replaySpeed}
        onChange={(e) => onReplaySpeedChange(Number(e.target.value))}
        title={t('terminal.replay.speedTooltip')}
        disabled={isReplaying}
      >
        <option value={1}>1×</option>
        <option value={4}>4×</option>
        <option value={16}>16×</option>
        <option value={0}>{t('terminal.replay.speedMax')}</option>
      </select>
      <button
        type="button"
        className={`terminal-filter-btn${isReplaying ? ' active' : ''}`}
        onClick={isReplaying ? onStopReplay : onStartReplay}
        title={isReplaying ? t('terminal.replay.stop') : t('terminal.replay.start')}
        aria-pressed={isReplaying}
      >
        {isReplaying ? <Square size={13} /> : <History size={13} />}
      </button>
    </div>
  );
};

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

  // ---- Search state (UI-local, not Zustand) ----
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [currentMatch, setCurrentMatch] = useState(0); // index into matchIndices
  const matchIndices = useMemo(
    () => findMatches(lines, {
      query: debouncedQuery,
      caseSensitive,
      displayFormat: terminal?.displayFormat,
    }),
    [lines, debouncedQuery, caseSensitive, terminal?.displayFormat]
  );

  // ---- Filter state (UI-local, not Zustand; resets when the tab remounts) ----
  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>('all');
  const [keywordInput, setKeywordInput] = useState('');
  const [debouncedKeyword, setDebouncedKeyword] = useState('');

  // ---- Pause-display state (UI-local) ----
  // While paused, lines keep accumulating in the store; the view renders only
  // the snapshot prefix lines.slice(0, frozenCount). A prefix slice preserves
  // original indices, so filteredIndices still maps into `lines` correctly.
  const [paused, setPaused] = useState(false);
  const [frozenCount, setFrozenCount] = useState<number | null>(null);

  // ---- 日志回放状态 (UI-local) ----
  const { isReplaying, startReplay, stopReplay } = useLogReplay(portId);
  const [replaySpeed, setReplaySpeed] = useState(4);

  const handleStartReplay = useCallback(async () => {
    const path = await open({
      multiple: false,
      filters: [{ name: 'Log', extensions: ['log', 'txt'] }],
    });
    if (!path || typeof path !== 'string') return;
    await startReplay(path, replaySpeed);
  }, [startReplay, replaySpeed]);

  const visibleLines = useMemo(
    () => (paused && frozenCount !== null ? lines.slice(0, frozenCount) : lines),
    [lines, paused, frozenCount]
  );

  // Data-level filtering: original indices into `lines` that pass both the
  // direction and keyword filters. The virtualizer renders exactly
  // filteredIndices.length rows — never hidden DOM nodes.
  const filteredIndices = useMemo(
    () => filterLines(visibleLines, { direction: directionFilter, keyword: debouncedKeyword }),
    [visibleLines, directionFilter, debouncedKeyword]
  );

  // ---- Selection state (UI-local) ----
  const [selectedRange, setSelectedRange] = useState<{ start: number; end: number } | null>(null);
  const lastClickIndexRef = useRef<number | null>(null);
  // Index of the row the user right-clicked on (for "copy selected lines" fallback)
  const contextLineIndexRef = useRef<number | null>(null);

  // Keep a stable ref to the latest lines array so virtualizer callbacks
  // (getScrollElement, estimateSize, getItemKey) have stable identities
  // across renders. Without this, each new function reference causes
  // useVirtualizer's internal memos (getMeasurementOptions) to detect a
  // dep change → onChange → notify() → rerender() DURING render → infinite loop.
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

  // Stabilize virtualizer callbacks: closures over refs so function identity
  // is stable (empty dep array). The refs are kept current on every render.
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

  // Auto-scroll to bottom when new lines arrive. Skipped while paused (the
  // view is frozen); on resume, filteredIndices.length changes and this
  // effect catches up to the latest accumulated line.
  useEffect(() => {
    if (paused) return;
    if (autoScrollRef.current && filteredIndices.length > 0) {
      virtualizer.scrollToIndex(filteredIndices.length - 1, { align: 'end', behavior: 'auto' });
    }
  }, [filteredIndices.length, virtualizer, paused]);

  // Debounce search input (~150ms) — only recompute matches on debounced value
  useEffect(() => {
    const handle = setTimeout(() => {
      setDebouncedQuery(searchQuery);
      setCurrentMatch(0);
    }, 150);
    return () => clearTimeout(handle);
  }, [searchQuery]);

  // Debounce keyword filter input (200ms) — only refilter on debounced value
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedKeyword(keywordInput), 200);
    return () => clearTimeout(handle);
  }, [keywordInput]);

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

  // Ctrl+Scroll to adjust font size
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

  // Reverse map: original line index → virtualizer index in the filtered
  // view. Identity when no filter is active (size === lines.length).
  const originalToFiltered = useMemo(() => {
    const m = new Map<number, number>();
    for (let i = 0; i < filteredIndices.length; i++) m.set(filteredIndices[i], i);
    return m;
  }, [filteredIndices]);

  const jumpToMatch = useCallback((idx: number) => {
    if (matchIndices.length === 0) return;
    let clamped = ((idx % matchIndices.length) + matchIndices.length) % matchIndices.length;
    // Search runs over the FULL view, but the jump must land on a rendered
    // row: if the target match is hidden by an active filter, advance to the
    // nearest visible match instead. If NO match survives the filter, leave
    // state unchanged so the UI never points at a hidden line.
    if (originalToFiltered.size < lines.length) {
      if (!originalToFiltered.has(matchIndices[clamped])) {
        let foundVisible = false;
        for (let step = 1; step < matchIndices.length; step++) {
          const candidate = (clamped + step) % matchIndices.length;
          if (originalToFiltered.has(matchIndices[candidate])) {
            clamped = candidate;
            foundVisible = true;
            break;
          }
        }
        if (!foundVisible) return;
      }
    }
    const virtIdx = originalToFiltered.get(matchIndices[clamped]);
    if (virtIdx === undefined) return;
    setCurrentMatch(clamped);
    virtualizer.scrollToIndex(virtIdx, { align: 'center' });
  }, [matchIndices, originalToFiltered, lines.length, virtualizer]);

  const handleNextMatch = useCallback(() => {
    jumpToMatch(currentMatch + 1);
  }, [jumpToMatch, currentMatch]);

  const handlePrevMatch = useCallback(() => {
    jumpToMatch(currentMatch - 1);
  }, [jumpToMatch, currentMatch]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    // Keep query so re-opening restores it; clear debounced to stop recompute churn
  }, []);

  // Pause/resume the display. Pausing snapshots the live line count from the
  // store (not from the render closure, which may lag a few events behind);
  // unpausing clears the snapshot so all accumulated lines render at once.
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

  // Ctrl+L to clear terminal, Ctrl+F to toggle search, F3 next match, Escape close search
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.ctrlKey && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      setSearchOpen((prev) => !prev);
      return;
    }
    if (e.key === 'F3') {
      e.preventDefault();
      if (!searchOpen) setSearchOpen(true);
      if (e.shiftKey) handlePrevMatch();
      else handleNextMatch();
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
  }, [portId, searchOpen, closeSearch, handleNextMatch, handlePrevMatch]);

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const el = scrollRef.current;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
    if (atBottom !== autoScrollRef.current) {
      autoScrollRef.current = atBottom;
      if (portId && terminal) {
        setTerminalConfig(portId, { scrollLocked: atBottom });
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

  const handleCopy = useCallback(() => {
    const sel = window.getSelection();
    if (sel && sel.toString()) {
      navigator.clipboard.writeText(sel.toString());
    }
  }, []);

  // Row click: shift+click extends selection from last click to current row
  const handleRowClick = useCallback((e: React.MouseEvent, index: number) => {
    if (e.shiftKey && lastClickIndexRef.current !== null) {
      const start = Math.min(lastClickIndexRef.current, index);
      const end = Math.max(lastClickIndexRef.current, index);
      setSelectedRange({ start, end });
      // Don't update lastClickIndexRef on shift+click — anchor stays
      return;
    }
    lastClickIndexRef.current = index;
    setSelectedRange(null);
  }, []);

  // Row right-click: record clicked index for context menu actions.
  // The container's onContextMenu handles preventDefault + showing the menu.
  const handleRowContextMenu = useCallback((_e: React.MouseEvent, index: number) => {
    contextLineIndexRef.current = index;
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const currentLines = useTerminalStore.getState().terminals[portId]?.lines ?? [];
    const clickedIdx = contextLineIndexRef.current;

    // Resolve the selection range to copy. If no shift-click range exists,
    // fall back to the single right-clicked line.
    const range = selectedRange ?? (
      clickedIdx !== null ? { start: clickedIdx, end: clickedIdx } : null
    );

    const copySelected = () => {
      if (!range) return;
      const slice = currentLines.slice(range.start, range.end + 1);
      const text = slice.map(formatLineForCopy).join('\n');
      if (text) navigator.clipboard.writeText(text);
    };

    const copyAll = () => {
      const text = currentLines.map(formatLineForCopy).join('\n');
      if (text) navigator.clipboard.writeText(text);
    };

    const copyVisible = () => {
      const sel = window.getSelection();
      if (sel && sel.toString()) navigator.clipboard.writeText(sel.toString());
    };

    const items: ContextMenuEntry[] = [
      { label: t('terminal.context.copySelectedLines'), onClick: copySelected, disabled: range === null },
      { label: t('terminal.context.copyVisible'), onClick: copyVisible },
      { label: t('terminal.context.copyAll'), onClick: copyAll, disabled: currentLines.length === 0 },
      { type: 'separator' },
      { label: t('terminalView.contextMenu.selectAll'), onClick: handleSelectAll },
      { label: t('terminalView.contextMenu.copy'), onClick: handleCopy },
      { type: 'separator' },
      { label: t('terminalView.contextMenu.copyAsHex'), onClick: () => {
        const sel = window.getSelection();
        if (sel && sel.toString()) navigator.clipboard.writeText(stringToHex(sel.toString()));
      }},
      { label: t('terminalView.contextMenu.hexToText'), onClick: () => {
        const sel = window.getSelection();
        if (sel && sel.toString()) navigator.clipboard.writeText(hexToString(sel.toString()));
      }},
      { type: 'separator' },
      { label: t('terminalView.contextMenu.exportTxt'), onClick: async () => {
        const text = currentLines.map((l, idx) => {
          const ts = timestampMode === 'perRound' && idx > 0 && !firstInRound?.[idx]
            ? '-'
            : formatTerminalTimestamp(currentLines, idx, terminal?.connectedAt, timestampFormat);
          return `[${ts}] ${l.direction} ${l.content}`;
        }).join('\n');
        const filePath = await save({
          title: t('terminalView.saveDialog.title.txt'),
          defaultPath: `${portId}-${exportTimestamp()}.txt`,
          filters: [{ name: t('terminalView.saveDialog.filterName'), extensions: ['txt'] }],
        });
        if (filePath === null) return;
        try {
          await logService.exportTerminalLog(filePath, text);
        } catch (err) {
          console.error('Failed to export TXT:', err);
          notifyError(err);
        }
      }},
      { label: t('terminalView.contextMenu.exportCsv'), onClick: async () => {
        const csv = 'timestamp,direction,content\n' + currentLines.map((l, idx) => {
          const ts = timestampMode === 'perRound' && idx > 0 && !firstInRound?.[idx]
            ? '-'
            : formatTerminalTimestamp(currentLines, idx, terminal?.connectedAt, timestampFormat);
          return `"${ts}","${l.direction}","${l.content.replace(/"/g, '""')}"`;
        }).join('\n');
        const filePath = await save({
          title: t('terminalView.saveDialog.title.csv'),
          defaultPath: `${portId}-${exportTimestamp()}.csv`,
          filters: [{ name: 'CSV', extensions: ['csv'] }],
        });
        if (filePath === null) return;
        try {
          await logService.exportTerminalLog(filePath, csv);
        } catch (err) {
          console.error('Failed to export CSV:', err);
          notifyError(err);
        }
      }},
    ];
    setContextMenu({ x: e.clientX, y: e.clientY, items });
    // Reset the per-row context index after building the menu
    contextLineIndexRef.current = null;
  }, [handleSelectAll, handleCopy, portId, selectedRange, t, timestampMode, firstInRound, terminal?.connectedAt, timestampFormat]);

  const directionColor = (dir: string) => {
    if (dir === 'TX') return 'var(--terminal-tx-color)';
    return 'var(--terminal-rx-color)';
  };

  // Pre-compute match set + current match line index for row class lookup
  const matchSet = useMemo(() => new Set(matchIndices), [matchIndices]);
  const currentMatchLineIdx = matchIndices.length > 0 ? matchIndices[currentMatch] : -1;

  return (
    <div className="terminal-view-container">
      {protocolTemplates.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', borderBottom: '1px solid var(--border-color)', fontSize: 12, flexShrink: 0 }}>
          <span style={{ color: 'var(--text-secondary)' }}>{t('terminalView.protocolLabel')}</span>
          <select
            className="select"
            style={{ width: 150, height: 22, fontSize: 12 }}
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
      <FilterBar
        direction={directionFilter}
        onDirectionChange={setDirectionFilter}
        keyword={keywordInput}
        onKeywordChange={setKeywordInput}
        matchCount={filteredIndices.length}
        showMatchCount={debouncedKeyword.trim().length > 0}
        paused={paused}
        onTogglePause={togglePause}
        isReplaying={isReplaying}
        replaySpeed={replaySpeed}
        onReplaySpeedChange={setReplaySpeed}
        onStartReplay={handleStartReplay}
        onStopReplay={stopReplay}
      />
      {searchOpen && (
        <SearchBar
          query={searchQuery}
          onQueryChange={setSearchQuery}
          caseSensitive={caseSensitive}
          onToggleCase={() => setCaseSensitive((v) => !v)}
          matchIndex={matchIndices.length > 0 ? currentMatch : -1}
          matchCount={matchIndices.length}
          onNext={handleNextMatch}
          onPrev={handlePrevMatch}
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
            // Map the virtualizer (filtered) index back to the original
            // lines[] index so timestamps, selection, context-menu copy and
            // search highlighting all operate on the correct line.
            const origIdx = filteredIndices[vRow.index] ?? vRow.index;
            const line = lines[origIdx];
            if (!line) return null;
            let lineHtml: string;
            if (line.parsedFields && line.parsedFields.length > 0) {
              lineHtml = renderProtocolLine(line);
            } else {
              const displayText = terminal?.displayFormat === 'hex' && line.rawData
                ? line.rawData.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')
                : line.content;
              lineHtml = applyHighlightSets(displayText, highlightRuleSets);
            }
            const isSelected = selectedRange !== null
              && origIdx >= selectedRange.start
              && origIdx <= selectedRange.end;
            const isMatch = searchOpen && matchSet.has(origIdx);
            const isCurrent = searchOpen && origIdx === currentMatchLineIdx;
            const classes = [
              'terminal-line',
              isSelected ? 'selected' : '',
              isCurrent ? 'current-match' : (isMatch ? 'search-hit-line' : ''),
            ].filter(Boolean).join(' ');
            return (
              <div
                key={vRow.key}
                data-index={vRow.index}
                ref={virtualizer.measureElement}
                className={classes}
                onClick={(e) => handleRowClick(e, origIdx)}
                onContextMenu={(e) => handleRowContextMenu(e, origIdx)}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${vRow.start}px)`,
                }}
              >
                {terminal?.showTimestamp !== false && (
                  <span className={`terminal-timestamp${timestampMode === 'perRound' && origIdx > 0 && !firstInRound?.[origIdx] ? ' terminal-timestamp-muted' : ''}`}>
                    {timestampMode === 'perRound' && origIdx > 0 && !firstInRound?.[origIdx]
                      ? '-'
                      : formatTerminalTimestamp(lines, origIdx, terminal?.connectedAt, timestampFormat)}
                  </span>
                )}
                <span
                  className="terminal-direction"
                  style={{ color: directionColor(line.direction) }}
                >
                  {line.direction}
                </span>
                <span className="terminal-content"
                  dangerouslySetInnerHTML={{ __html: lineHtml }}
                />
              </div>
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