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
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUpToLine, ArrowDownToLine } from 'lucide-react';
import { useAppStore } from '../../stores/useAppStore';
import { useRuleStore } from '../../stores/useRuleStore';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { getViewportManager, type TerminalViewportManager } from '../../utils/terminal/viewportManager';
import type { TerminalState } from '../../types';
import { TerminalRenderer, type RendererConfig } from '../../utils/terminal/TerminalRenderer';
import { CONFIG_BOUNDS } from '../../utils/bounds';
import { isAtBottom } from '../../utils/followLogic';
import { isSameRound } from '../../utils/timeFormat';
import { getAvailablePluginViews, getTabViewPreference, selectSerialPluginView } from '../../utils/pluginViewRuntime';
import { notifyError } from '../../stores/useToastStore';
import ContextMenu, { type ContextMenuEntry } from '../shared/ContextMenu';
import PluginViewPicker from '../shared/PluginViewPicker';
import { buildTerminalContextMenuItems } from './terminalContextMenu';
import { useTerminalDisplay } from './useTerminalDisplay';
import { useTerminalSearch } from './useTerminalSearch';
import TerminalSearchBar from './TerminalSearchBar';
import TerminalFilterBar from './TerminalFilterBar';
import { createTrxTimelineAdapter, timelineCoordinator, type TimelineNavigationToken } from '../../utils/timeline';
import { TerminalNavigationLifecycle } from '../../utils/terminalNavigation';
import { TimelineButton, useTimelineMembership } from './TimelineControls';

export interface TerminalViewProps {
  /** Only real serial sources provide a port; replay never fabricates one. */
  portId?: string;
  tabId?: string;
  sourceId?: string;
  manager?: TerminalViewportManager;
  terminalConfig?: Partial<TerminalState>;
  onTerminalConfigChange?: (patch: Partial<TerminalState>) => void;
  timelineClockId?: string;
  timelineEnabled?: boolean;
  onUserNavigation?: () => void;
  /** true = inactive tab (display:none, buffer+renderer stay alive). */
  hidden?: boolean;
}

const SETTLE_MS = 120;

const TerminalView: React.FC<TerminalViewProps> = ({ portId, tabId, sourceId, manager, terminalConfig, onTerminalConfigChange, timelineClockId, timelineEnabled = true, onUserNavigation, hidden }) => {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; items: ContextMenuEntry[] } | null>(null);
  const [selectedRange, setSelectedRange] = useState<{ start: number; end: number } | null>(null);
  const [, forceRender] = useState(0);

  // Display config from the stores (selector-grained — only these re-render
  // the shell; row content is rendered by the manager).
  const liveConfig = useTerminalStore((s) => portId ? s.terminals[portId] : undefined);
  const scrollLocked = terminalConfig?.scrollLocked ?? liveConfig?.scrollLocked ?? false;
  const showTimestamp = terminalConfig?.showTimestamp ?? liveConfig?.showTimestamp ?? true;
  const displayFormat = terminalConfig?.displayFormat ?? liveConfig?.displayFormat ?? 'string';
  const encoding = terminalConfig?.encoding ?? liveConfig?.encoding ?? 'UTF-8';
  const connectedAt = terminalConfig?.connectedAt ?? liveConfig?.connectedAt ?? null;
  const updateTerminalConfig = useCallback((patch: Partial<TerminalState>) => {
    if (onTerminalConfigChange) onTerminalConfigChange(patch);
    else if (portId) useTerminalStore.getState().setTerminalConfig(portId, patch);
  }, [portId, onTerminalConfigChange]);
  const timestampFormat = useAppStore((s) => s.config.timestampFormat);
  const timestampMode = useAppStore((s) => s.config.timestampMode);
  const terminalFontSize = useAppStore((s) => s.config.terminalFontSize);
  const highlightRuleSets = useRuleStore((s) => s.highlightRuleSets);
  const protocolTemplates = useRuleStore((s) => s.protocolTemplates);
  const protocolTemplateId = useAppStore((s) => s.ports.find((p) => p.id === portId)?.protocolTemplateId);

  // Stable per-port manager (module registry — same instance across remounts).
  if (!manager && !portId) throw new Error('TerminalView requires a real port or an independent manager');
  const vm = manager ?? getViewportManager(portId!);
  const groupId = useTimelineMembership(tabId);
  const groupIdRef = useRef(groupId);
  groupIdRef.current = groupId;
  const adapterRef = useRef<ReturnType<typeof createTrxTimelineAdapter> | null>(null);
  const navigationRef = useRef<TerminalNavigationLifecycle<{ timeMs: number; recordKey?: string }> | null>(null);
  const configRef = useRef({ scrollLocked, updateTerminalConfig, onUserNavigation });
  configRef.current = { scrollLocked, updateTerminalConfig, onUserNavigation };

  useEffect(() => {
    if (!tabId || !timelineEnabled) return; // no popout/hidden replacement raw participant
    const adapter = createTrxTimelineAdapter({ slotId: tabId, portId, sourceId, manager: vm,
      sourceKind: portId ? 'live' : 'replay', clockId: timelineClockId,
      visible: !hidden, onUserNavigation: () => configRef.current.onUserNavigation?.(),
    });
    adapterRef.current = adapter;
    return () => { navigationRef.current?.cancel(); adapter.dispose(); adapterRef.current = null; };
  }, [tabId, portId, sourceId, vm, timelineClockId, timelineEnabled]);

  useEffect(() => {
    adapterRef.current?.setAvailability({ available: true, visible: !hidden });
    if (hidden) navigationRef.current?.release();
  }, [hidden, vm, tabId]);

  const previousGroup = useRef<string | null>(null);
  useEffect(() => {
    // Exiting a group holds the current viewport; independent Pin is opt-in again.
    if (previousGroup.current && !groupId) {
      navigationRef.current?.cancel();
      vm.setLocked(false);
      updateTerminalConfig({ scrollLocked: false });
    }
    previousGroup.current = groupId;
  }, [groupId, vm, updateTerminalConfig]);

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
  // issue #15：useLayoutEffect 保证 attach/detach 在 React 提交阶段同步完成。
  // 跨 Pane 位移（splitPane 嵌套分支）时旧 TerminalView 卸载的布局 cleanup
  // （detachRenderer）在 mutation 阶段先于新实例的布局 create（attachRenderer）
  // 执行——「先 detach 旧容器、再 attach 新容器」被确定性保证，rAF render 无法
  // 插进双挂载窗口（提交全程同步，浏览器不在中途跑 rAF）。useEffect 的清理在
  // passive 阶段、且时序不保证，attach/detach 交错会让渲染器在同一帧内对着
  // 已移除的旧 layer 与新容器渲染（旧 active 行脱链 → insertBefore 崩溃）。
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    vm.attachRenderer(el, buildConfig());
    return () => vm.detachRenderer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vm]);

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
    if (prev !== locked && locked && !groupId) vm.scrollToBottom();
  }, [scrollLocked, vm, groupId]);

  // Refresh readouts (match count / search index) on manager render passes.
  useEffect(() => {
    return vm.subscribeReadouts(() => {
      adapterRef.current?.refreshSource();
      if (!hidden) forceRender((v) => v + 1);
    });
  }, [vm, hidden]);

  // Direction/keyword filter + pause (UI-local state, manager-backed).
  const {
    directionFilter, setDirectionFilter, keywordInput, setKeywordInput,
    debouncedKeyword, paused, togglePause,
  } = useTerminalDisplay({ vm });

  const localViewKey = JSON.stringify([directionFilter, debouncedKeyword, paused, encoding, displayFormat]);
  const previousLocalViewKey = useRef(localViewKey);
  useEffect(() => {
    const changed = previousLocalViewKey.current !== localViewKey;
    previousLocalViewKey.current = localViewKey;
    if (changed && tabId && groupId) timelineCoordinator.realign(tabId);
  }, [tabId, groupId, localViewKey]);

  const resumeHeldAlignment = useCallback(() => {
    const adapter = adapterRef.current;
    if (!tabId || !adapter || timelineCoordinator.participantForSlot(tabId)?.participantId !== adapter.participantId) return;
    const group = timelineCoordinator.groupForSlot(tabId);
    if (group?.members.find(member => member.slotId === tabId)?.status === 'held' && group.ownerParticipantId !== adapter.participantId) timelineCoordinator.realign(tabId);
  }, [tabId]);
  useEffect(() => {
    const realignAfterSelection = () => { if (window.getSelection()?.isCollapsed) resumeHeldAlignment(); };
    document.addEventListener('selectionchange', realignAfterSelection);
    return () => document.removeEventListener('selectionchange', realignAfterSelection);
  }, [resumeHeldAlignment]);

  // Search (UI-local state, manager-backed computation + navigation).
  const {
    searchOpen, searchQuery, caseSensitive, currentMatch, searchMatchCount,
    setSearchQuery, toggleCase, openSearch, toggleSearch, closeSearch,
    nextMatch, prevMatch,
  } = useTerminalSearch({ vm,
    onOpen: useCallback(() => {
      configRef.current.onUserNavigation?.();
      if (groupIdRef.current) timelineCoordinator.setMode(groupIdRef.current, 'browse');
    }, []),
    onNavigate: useCallback(() => navigationRef.current?.commitPosition(), []),
  });

  // Explicit intent owns the lease. Bare scroll only samples that lease, never
  // acquires ownership or writes scrollLocked (including trusted programmatic scroll).
  const lastClickSeqRef = useRef<number | null>(null);
  const contextLineSeqRef = useRef<number | null>(null);
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    let token: TimelineNavigationToken | null = null;
    const lifecycle = new TerminalNavigationLifecycle<{ timeMs: number; recordKey?: string }>({
      quietMs: SETTLE_MS,
      readScrollTop: () => element.scrollTop,
      canUseLastAnchor: () => document.visibilityState === 'hidden' || element.clientHeight === 0,
      isCurrent: () => {
        if (!token) return true;
        const group = timelineCoordinator.getSnapshot().groups.find(item => item.id === token!.groupId);
        return group?.ownerParticipantId === token.participantId && group.navigationEpoch === token.navigationEpoch;
      },
      readAnchor: () => {
        if (document.visibilityState === 'hidden' || element.clientHeight === 0) return null;
        const anchor = vm.readTimelineAnchor();
        return anchor?.timeMs != null ? { timeMs: anchor.timeMs, recordKey: anchor.recordKey } : null;
      },
      onBegin: () => {
        vm.beginGesture();
        configRef.current.onUserNavigation?.();
        token = adapterRef.current?.beginNavigation() ?? null;
      },
      onPreview: anchor => { if (token) adapterRef.current?.updateNavigation(token, anchor); },
      onCommit: anchor => {
        // End the follow suppression only AFTER updating the manager's lock.
        // Waiting for React's effect leaves a frame where the old true lock
        // pins an explicitly scrolled viewport back to the tail.
        if (!groupIdRef.current) {
          const atBottom = isAtBottom(element.scrollTop, element.clientHeight, element.scrollHeight);
          vm.setLocked(atBottom);
          if (atBottom !== configRef.current.scrollLocked) configRef.current.updateTerminalConfig({ scrollLocked: atBottom });
        }
        vm.endGesture();
        if (token) adapterRef.current?.endNavigation(token, anchor);
        token = null;
      },
      onCancel: () => {
        vm.endGesture();
        if (token) adapterRef.current?.cancelNavigation(token);
        token = null;
      },
    });
    navigationRef.current = lifecycle;
    const scroll = () => lifecycle.scroll();
    const pointerEnd = (event: PointerEvent) => lifecycle.release(event.pointerId);
    const mouseEnd = () => lifecycle.release();
    const visibility = () => { if (document.visibilityState === 'hidden') lifecycle.release(); };
    element.addEventListener('scroll', scroll, { passive: true });
    window.addEventListener('pointerup', pointerEnd, true);
    window.addEventListener('pointercancel', pointerEnd, true);
    window.addEventListener('mouseup', mouseEnd, true);
    window.addEventListener('blur', mouseEnd);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      lifecycle.dispose(); navigationRef.current = null;
      element.removeEventListener('scroll', scroll);
      window.removeEventListener('pointerup', pointerEnd, true);
      window.removeEventListener('pointercancel', pointerEnd, true);
      window.removeEventListener('mouseup', mouseEnd, true);
      window.removeEventListener('blur', mouseEnd);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [vm]);
  const beginGesture = useCallback(() => navigationRef.current?.commitPosition(), []);

  // Ctrl+wheel font zoom, mirrored to the --font-size-terminal var. Bounds come
  // from CONFIG_BOUNDS (the single source of numeric limits, K2) — a local 8/48
  // copy silently drifts the moment the real bounds move.
  const handleWheel = useCallback(
    (e: WheelEvent) => {
      if (!e.ctrlKey) {
        if (e.deltaY !== 0 && Math.abs(e.deltaY) >= Math.abs(e.deltaX)) beginGesture();
        return;
      }
      e.preventDefault();
      const store = useAppStore.getState();
      const current = store.config.terminalFontSize;
      const delta = e.deltaY > 0 ? -1 : 1;
      const next = Math.max(
        CONFIG_BOUNDS.terminalFontSize[0],
        Math.min(CONFIG_BOUNDS.terminalFontSize[1], current + delta),
      );
      if (next !== current) {
        document.documentElement.style.setProperty('--font-size-terminal', `${next}px`);
        store.setConfig({ terminalFontSize: next });
      }
    },
    [beginGesture],
  );

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    // React's delegated wheel listener is passive. A local non-passive listener
    // is required to suppress browser Ctrl+wheel zoom without console errors.
    element.addEventListener('wheel', handleWheel, { passive: false });
    return () => element.removeEventListener('wheel', handleWheel);
  }, [vm, handleWheel]);

  // Scrollbar drag / middle-click autoscroll: hold the gesture until pointer-up.
  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      const element = e.currentTarget;
      const rect = element.getBoundingClientRect();
      const verticalScrollbar = e.target === element && e.clientX >= rect.left + element.clientWidth && e.clientY < rect.top + element.clientHeight;
      if (e.button === 1 || (e.button === 0 && verticalScrollbar)) navigationRef.current?.begin(e.pointerId);
      // Left-button drag on a row starts a native cross-row text selection.
      // The renderer pins rows the live Range anchors to (selectionchange +
      // per-render syncPins) — no freeze protocol. Clear any stale selection
      // first so pins never outlive their browser Range. Scrollbar presses
      // hit the container itself (no data-seq) and don't touch pins.
      if (e.button === 0 && TerminalRenderer.seqFromEventTarget(e.target) !== null) {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) sel.removeAllRanges();
        // 拖选 = 主动浏览/选择历史数据：脱离滚动锁定。否则 follow pin 在
        // 数据快速刷新时每帧把 scrollTop 钉在增长中的底部，被选中行随内容
        // 增长滚出视口 → 输出区空白。解锁后视口固定，选区稳定；settle 不
        // 参与拖选（非 gesture 路径），用户停在哪锁定就保持在哪，点底部
        // 按钮可重新跟随。
        if (scrollLocked) updateTerminalConfig({ scrollLocked: false });
        vm.setLocked(false);
      }
    },
    [vm, scrollLocked, updateTerminalConfig],
  );

  const handlePointerUp = useCallback((event: React.PointerEvent) => navigationRef.current?.release(event.pointerId), []);

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
      resumeHeldAlignment();
    },
    [vm, resumeHeldAlignment],
  );

  // Right-click: record the seq; build the menu from the buffer snapshot.
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const seq = TerminalRenderer.seqFromEventTarget(e.target);
      contextLineSeqRef.current = seq;
      const vmLive = vm;
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
        portId: portId ?? sourceId ?? tabId ?? 'replay', // export label, never a send target
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
    [vm, portId, sourceId, tabId, selectedRange, timestampMode, connectedAt, timestampFormat, encoding, t],
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
    if (scrollLocked && !groupId) vm.scrollToBottom();
  }, [closeSearch, scrollLocked, groupId, vm]);

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
        if (portId) vm.clear(); // imported documents are read-only
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
    beginGesture();
    if (!groupId) updateTerminalConfig({ scrollLocked: false });
    vm.setLocked(false);
    vm.scrollToTop();
    navigationRef.current?.commitPosition();
  }, [groupId, updateTerminalConfig, beginGesture, vm]);

  const jumpToBottom = useCallback(() => {
    beginGesture();
    if (!groupId) updateTerminalConfig({ scrollLocked: true });
    vm.scrollToBottom();
    navigationRef.current?.commitPosition();
  }, [groupId, updateTerminalConfig, beginGesture, vm]);

  // FilterBar readout (visible rows under filter/pause) — refreshed via the
  // manager subscription above.
  const matchCount = vm.getVisibleCount();

  return (
    <div className="terminal-view-container" style={hidden ? { display: 'none' } : undefined}>
      {portId && protocolTemplates.length > 0 && (
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
      {vm.isLoading && <div className="timeline-note" role="status">{t('timeline.status.loading')}</div>}
      <TerminalFilterBar
        portId={portId}
        configId={tabId ?? sourceId ?? portId}
        grouped={!!groupId}
        timelineControl={tabId ? <TimelineButton tabId={tabId} /> : undefined}
        onConfigChange={updateTerminalConfig}
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
        viewPicker={(() => {
          const tab = useAppStore.getState().tabs.find(item => item.kind === 'serial' && item.portId === portId);
          const preference = tab ? getTabViewPreference(tab) : null;
          const choices = portId ? getAvailablePluginViews(portId, 'serial-content') : [];
          return tab && (choices.length > 0 || preference) ? (
            <PluginViewPicker
              choices={choices}
              value={preference ? `${preference.pluginId}/${preference.viewId}` : ''}
              rawOption={{ key: '', label: t('pluginViews.terminal') }}
              triggerLabel={t('pluginViews.view')}
              title={t('pluginViews.view')}
              ariaLabel={t('pluginViews.view')}
              onSelect={choice => { try { selectSerialPluginView(tab.id, choice?.preference ?? null); } catch (error) { notifyError(error); } }}
            />
          ) : null;
        })()}
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
