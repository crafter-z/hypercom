/**
 * TerminalView — terminal container shell (方案B, issue #14).
 *
 * The line buffer + row DOM moved OUT of React into the viewport manager
 * (`TerminalViewportManager` ring buffer + `TerminalRenderer` direct-DOM
 * engine). This component is a thin shell that:
 * - hosts the scroll container + attach/detach of the renderer
 * - syncs display config (font/format/encoding/timestamps/highlight rules)
 *   from the stores into the manager's renderer
 * - owns the UI-local interactive state: filter bar, search bar, selection,
 *   context menu, gestures (scroll-lock follow), quick-jump buttons
 * - renders the protocol-template picker strip
 *
 * Data flows: RxPipeline rAF tick → manager.appendLines → renderer.render
 * (same frame). React does NOT participate in row rendering — the content
 * layer inside the container is imperative DOM that survives shell
 * re-renders (React leaves non-React children alone).
 *
 * TRX tabs are persistently mounted by Pane (`hidden` prop = display:none);
 * the buffer + renderer instance survive tab switches — switching back just
 * re-runs the rAF render after the container gains real dimensions.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUpToLine, ArrowDownToLine } from 'lucide-react';
import { useAppStore } from '../../stores/useAppStore';
import { useRuleStore } from '../../stores/useRuleStore';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { getViewportManager } from '../../utils/terminal/viewportManager';
import { TerminalRenderer, type RendererConfig } from '../../utils/terminal/TerminalRenderer';
import { isAtBottom } from '../../utils/followLogic';
import { isSameRound } from '../../utils/timeFormat';
import ContextMenu, { type ContextMenuEntry } from '../shared/ContextMenu';
import { buildTerminalContextMenuItems } from './terminalContextMenu';
import { useTerminalDisplay } from './useTerminalDisplay';
import { useTerminalSearch } from './useTerminalSearch';
import TerminalSearchBar from './TerminalSearchBar';
import TerminalFilterBar from './TerminalFilterBar';

interface TerminalViewProps {
  portId: string;
  /** true = inactive tab (display:none, buffer+renderer stay alive). */
  hidden?: boolean;
}

const SETTLE_MS = 120;
const FONT_MIN = 8;
const FONT_MAX = 48;

const TerminalView: React.FC<TerminalViewProps> = ({ portId, hidden }) => {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; items: ContextMenuEntry[] } | null>(null);
  const [selectedRange, setSelectedRange] = useState<{ start: number; end: number } | null>(null);
  const [, forceRender] = useState(0);

  // Display config from the stores (selector-grained — only these re-render
  // the shell; row content is rendered by the manager).
  const scrollLocked = useTerminalStore((s) => s.terminals[portId]?.scrollLocked);
  const showTimestamp = useTerminalStore((s) => s.terminals[portId]?.showTimestamp);
  const displayFormat = useTerminalStore((s) => s.terminals[portId]?.displayFormat);
  const encoding = useTerminalStore((s) => s.terminals[portId]?.encoding);
  const connectedAt = useTerminalStore((s) => s.terminals[portId]?.connectedAt);
  const timestampFormat = useAppStore((s) => s.config.timestampFormat);
  const timestampMode = useAppStore((s) => s.config.timestampMode);
  const terminalFontSize = useAppStore((s) => s.config.terminalFontSize);
  const highlightRuleSets = useRuleStore((s) => s.highlightRuleSets);
  const protocolTemplates = useRuleStore((s) => s.protocolTemplates);
  const protocolTemplateId = useAppStore((s) => s.ports.find((p) => p.id === portId)?.protocolTemplateId);

  // Stable per-port manager (module registry — same instance across remounts).
  const vm = getViewportManager(portId);

  const buildConfig = useCallback(
    (): RendererConfig => ({
      rowHeight: Math.round(terminalFontSize * 1.5),
      showTimestamp: showTimestamp !== false,
      displayFormat: displayFormat ?? 'string',
      encoding: encoding ?? 'UTF-8',
      timestampFormat,
      timestampMode,
      highlightRuleSets,
      connectedAt: connectedAt ?? null,
    }),
    [terminalFontSize, showTimestamp, displayFormat, encoding, timestampFormat, timestampMode, highlightRuleSets, connectedAt],
  );

  // Attach the renderer to the container on mount (re-attach on pane move).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    vm.attachRenderer(el, buildConfig());
    return () => vm.detachRenderer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [portId]);

  // Display config changes → live-update the renderer (re-decodes rows on
  // encoding switch; repositions on font change).
  useEffect(() => {
    vm.updateConfig(buildConfig());
  }, [vm, buildConfig]);

  // Store scrollLocked → manager follow state; engage jumps to the bottom.
  const prevLockedRef = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    const locked = scrollLocked === true;
    const prev = prevLockedRef.current;
    prevLockedRef.current = locked;
    vm.setLocked(locked);
    if (prev !== locked && locked) vm.scrollToBottom();
  }, [scrollLocked, vm]);

  // Refresh readouts (match count / search index) on manager render passes.
  useEffect(() => {
    return vm.subscribe(() => {
      if (!hidden) forceRender((v) => v + 1);
    });
  }, [vm, hidden]);

  // Direction/keyword filter + pause (UI-local state, manager-backed).
  const {
    directionFilter, setDirectionFilter, keywordInput, setKeywordInput,
    debouncedKeyword, paused, togglePause,
  } = useTerminalDisplay({ vm });

  // Search (UI-local state, manager-backed computation + navigation).
  const {
    searchOpen, searchQuery, caseSensitive, currentMatch, searchMatchCount,
    setSearchQuery, toggleCase, openSearch, toggleSearch, closeSearch,
    nextMatch, prevMatch,
  } = useTerminalSearch({ vm });

  // Gesture system: explicit user scroll → suppress follow until settle.
  const gestureActiveRef = useRef(false);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const lastClickSeqRef = useRef<number | null>(null);
  const contextLineSeqRef = useRef<number | null>(null);
  const searchOpenRef = useRef(searchOpen);
  searchOpenRef.current = searchOpen;

  const settle = useCallback(() => {
    gestureActiveRef.current = false;
    vm.endGesture();
    const el = containerRef.current;
    if (!el) return;
    const atBottom = isAtBottom(el.scrollTop, el.clientHeight, el.scrollHeight);
    const store = useTerminalStore.getState();
    const current = store.terminals[portId]?.scrollLocked ?? true;
    if (atBottom !== current) {
      store.setTerminalConfig(portId, { scrollLocked: atBottom });
    }
  }, [portId, vm]);

  const beginGesture = useCallback(() => {
    gestureActiveRef.current = true;
    vm.beginGesture();
    clearTimeout(settleTimerRef.current);
    settleTimerRef.current = setTimeout(settle, SETTLE_MS);
  }, [vm, settle]);

  // Cleanup settle timer on unmount.
  useEffect(() => () => clearTimeout(settleTimerRef.current), []);

  // Ctrl+wheel font zoom (8–48px, mirrored to the --font-size-terminal var).
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      beginGesture();
      if (!e.ctrlKey) return;
      e.preventDefault();
      const store = useAppStore.getState();
      const current = store.config.terminalFontSize;
      const delta = e.deltaY > 0 ? -1 : 1;
      const next = Math.max(FONT_MIN, Math.min(FONT_MAX, current + delta));
      if (next !== current) {
        document.documentElement.style.setProperty('--font-size-terminal', `${next}px`);
        store.setConfig({ terminalFontSize: next });
      }
    },
    [beginGesture],
  );

  // Scrollbar drag / middle-click autoscroll: hold the gesture until pointer-up.
  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button === 1 || e.target === e.currentTarget) {
        gestureActiveRef.current = true;
        vm.beginGesture();
        clearTimeout(settleTimerRef.current);
      }
      // Left-button drag on a row starts a native cross-row text selection —
      // freeze renderer structural DOM changes until release so the selection
      // Range stays anchored to live nodes. Scrollbar presses hit the
      // container itself (no data-seq) and never freeze.
      if (e.button === 0 && TerminalRenderer.seqFromEventTarget(e.target) !== null) {
        vm.setSelecting(true);
      }
    },
    [vm],
  );

  // Release the selection freeze anywhere (mouseup may happen off-container).
  const handleSelectionEnd = useCallback(() => {
    vm.setSelecting(false);
  }, [vm]);

  useEffect(() => {
    window.addEventListener('pointerup', handleSelectionEnd);
    window.addEventListener('pointercancel', handleSelectionEnd);
    return () => {
      window.removeEventListener('pointerup', handleSelectionEnd);
      window.removeEventListener('pointercancel', handleSelectionEnd);
    };
  }, [handleSelectionEnd]);

  const handlePointerUp = useCallback(() => {
    clearTimeout(settleTimerRef.current);
    settleTimerRef.current = setTimeout(settle, SETTLE_MS);
  }, [settle]);

  // Row click: select range (shift extends from the anchor seq).
  const handleRowClick = useCallback(
    (e: React.MouseEvent) => {
      const seq = TerminalRenderer.seqFromEventTarget(e.target);
      if (seq === null) return;
      if (e.shiftKey && lastClickSeqRef.current !== null) {
        const start = Math.min(lastClickSeqRef.current, seq);
        const end = Math.max(lastClickSeqRef.current, seq);
        setSelectedRange({ start, end });
        vm.setSelectedRange({ start, end });
        return;
      }
      lastClickSeqRef.current = seq;
      setSelectedRange(null);
      vm.setSelectedRange(null);
    },
    [vm],
  );

  // Right-click: record the seq; build the menu from the buffer snapshot.
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const seq = TerminalRenderer.seqFromEventTarget(e.target);
      contextLineSeqRef.current = seq;
      const vmLive = getViewportManager(portId);
      const snapshot = vmLive.buffer.snapshot();
      // The menu works on snapshot ARRAY indices — convert the seq-based
      // selection range (clamped to the live window).
      const firstSeq = vmLive.buffer.firstSeq;
      const lastSeq = vmLive.buffer.lastSeq;
      const clampSeq = (s: number): number | null => (s >= firstSeq && s <= lastSeq ? s : null);
      const seqRange =
        selectedRange !== null
          ? { start: clampSeq(selectedRange.start), end: clampSeq(selectedRange.end) }
          : seq !== null
            ? { start: clampSeq(seq), end: clampSeq(seq) }
            : null;
      const range =
        seqRange && seqRange.start !== null && seqRange.end !== null
          ? { start: seqRange.start - firstSeq, end: seqRange.end - firstSeq }
          : null;
      const isFirstInRound = (idx: number): boolean => {
        if (idx <= 0) return true;
        const prev = snapshot[idx - 1];
        const cur = snapshot[idx];
        if (!prev || !cur) return true;
        return !isSameRound(prev, cur);
      };
      const items = buildTerminalContextMenuItems({
        portId,
        lines: snapshot,
        range,
        timestampMode,
        isFirstInRound,
        connectedAt: connectedAt ?? null,
        timestampFormat,
        encoding,
        t,
        onSelectAll: handleSelectAll,
      });
      setContextMenu({ x: e.clientX, y: e.clientY, items });
      contextLineSeqRef.current = null;
    },
    [portId, selectedRange, timestampMode, connectedAt, timestampFormat, encoding, t],
  );

  const handleSelectAll = useCallback(() => {
    const sel = window.getSelection();
    if (sel && containerRef.current) {
      const range = document.createRange();
      range.selectNodeContents(containerRef.current);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }, []);

  const handleSearchClose = useCallback(() => {
    closeSearch();
    if (useTerminalStore.getState().terminals[portId]?.scrollLocked) {
      vm.scrollToBottom();
    }
  }, [closeSearch, portId, vm]);

  // Ctrl+L clear · Ctrl+F search · F3/Shift+F3 step · Esc close.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
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
        getViewportManager(portId).clear();
        return;
      }
      // Native keyboard scrolling is an explicit gesture.
      if (
        e.target === e.currentTarget &&
        ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)
      ) {
        beginGesture();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [searchOpen, toggleSearch, openSearch, handleSearchClose, nextMatch, prevMatch, beginGesture, portId],
  );

  const jumpToTop = useCallback(() => {
    useTerminalStore.getState().setTerminalConfig(portId, { scrollLocked: false });
    vm.scrollToSeq(vm.buffer.firstSeq, 'start');
  }, [portId, vm]);

  const jumpToBottom = useCallback(() => {
    useTerminalStore.getState().setTerminalConfig(portId, { scrollLocked: true });
    vm.scrollToBottom();
  }, [portId, vm]);

  // FilterBar readout (visible rows under filter/pause) — refreshed via the
  // manager subscription above.
  const matchCount = vm.getVisibleCount();

  return (
    <div className="terminal-view-container" style={hidden ? { display: 'none' } : undefined}>
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
            {protocolTemplates.filter((tpl) => tpl.isEnabled).map((tpl) => (
              <option key={tpl.id} value={tpl.id}>{tpl.name}</option>
            ))}
          </select>
        </div>
      )}
      <TerminalFilterBar
        portId={portId}
        encoding={encoding}
        scrollLocked={scrollLocked}
        showTimestamp={showTimestamp}
        displayFormat={displayFormat}
        direction={directionFilter}
        onDirectionChange={setDirectionFilter}
        keyword={keywordInput}
        onKeywordChange={setKeywordInput}
        matchCount={matchCount}
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
          matchIndex={searchMatchCount > 0 ? currentMatch : -1}
          matchCount={searchMatchCount}
          onNext={nextMatch}
          onPrev={prevMatch}
          onClose={handleSearchClose}
        />
      )}
      <div className="terminal-scroll-wrap">
        <div
          ref={containerRef}
          className="terminal-view"
          tabIndex={0}
          onContextMenu={handleContextMenu}
          onWheel={handleWheel}
          onKeyDown={handleKeyDown}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onClick={handleRowClick}
        />
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
