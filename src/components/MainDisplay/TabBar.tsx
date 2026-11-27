import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { TabItem, LeafPane, SerialPort } from '../../types';
import { useContextMenu } from '../shared/ContextMenu';
import type { ContextMenuEntry } from '../shared/ContextMenu';
import { Pin, X, AlertTriangle, Columns2, Rows2, ExternalLink, PlugZap, Unplug, Wrench, TerminalSquare, PanelTopClose, Globe, Lock, RotateCcw } from 'lucide-react';
import PluginTabLauncher from './PluginTabLauncher';
import { TimelineBadge, openTimelinePanel } from './TimelineControls';
import {
  SortableContext,
  useSortable,
  horizontalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useAppStore, getTabPortId, getClosingTabIds } from '../../stores/useAppStore';
import { collectLeaves } from '../../utils/paneTree';
import { isPortLost } from '../../hooks';
import { getPortCapabilities, isRemotePort, isRemotePortId, parseRemotePortId } from '../../utils/portCapabilities';
import { controlService } from '../../services/tauri';
import { notifyError, notifySuccess } from '../../stores/useToastStore';

interface TabBarProps {
  tabs: TabItem[];
  activeTabId: string | null;
  isMultiPane?: boolean;
  onTabClick: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
  onTabPin: (tabId: string) => void;
  onCloseToRight: (tabId: string) => void;
  onCloseToLeft: (tabId: string) => void;
  onCloseOthers: (tabId: string) => void;
  onPopOut?: (tabId: string) => void;
  moveToPaneTargets?: LeafPane[];
  onMoveToPane?: (tabId: string, targetPaneId: string) => void;
  onSplitVertical?: () => void;
  onSplitHorizontal?: () => void;
  onClosePane?: () => void;
  /** 一次性打开（连接）全部标签页对应串口（issue #2-1）。 */
  onConnectAllTabs?: () => void;
  /** 一次性断开全部标签页对应串口（issue #2-1）。 */
  onDisconnectAllTabs?: () => void;
  /** 外部工具三入口 —— 与侧边栏端口右键菜单同源同行为（issue #2-2）。 */
  onRunTool?: (tabId: string) => void;
  onKillTool?: (tabId: string) => void;
  onConfigTool?: () => void;
}

// ==================== Tab rendering ====================

interface TabItemProps {
  tab: TabItem;
  isActive: boolean;
  portStatus: SerialPort['status'] | null;
  portWarningTitle?: string;
  isRemote?: boolean;
  titleTooltip?: string;
  loanTitle?: string;
  closeLabel: string;
  onTabClick: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
  onContextMenu: (e: React.MouseEvent, tabId: string) => void;
}

const tabItemClassName = (tab: TabItem, isActive: boolean): string =>
  `tab-item${isActive ? ' active' : ''}${tab.isPinned ? ' pinned' : ''}`;

/** Presentational tab innards shared by the sortable and static shells —
 * the single source of truth for what a tab looks like. */
const TabItemContent: React.FC<TabItemProps> = ({
  tab,
  portStatus,
  portWarningTitle,
  isRemote,
  titleTooltip,
  loanTitle,
  closeLabel,
  onTabClose,
}) => (
  <>
    {portStatus !== null && <span className={`tab-status-dot status-${portStatus}`} />}
    {portWarningTitle && (
      <span className="tab-warning-icon" title={portWarningTitle}>
        <AlertTriangle size={12} aria-hidden="true" />
      </span>
    )}
    {isRemote && <Globe size={11} className="tab-remote-icon" aria-hidden="true" />}
    <span className="tab-title" title={titleTooltip ?? tab.title}>{tab.title}</span>
    {loanTitle && (
      <span className="tab-loan-icon" title={loanTitle}>
        <Lock size={11} aria-hidden="true" />
      </span>
    )}
    <TimelineBadge tabId={tab.id} />
    {tab.isPinned && <Pin size={10} className="tab-pin-icon" />}
    {!tab.isPinned && (
      <button
        type="button"
        className="tab-close"
        aria-label={closeLabel}
        onClick={(e) => { e.stopPropagation(); onTabClose(tab.id); }}
      >
        <X size={12} />
      </button>
    )}
  </>
);

/** Keyboard/ARIA tab semantics shared by both shells. */
const tabA11yProps = (tab: TabItem, isActive: boolean) => ({
  role: 'tab' as const,
  'aria-selected': isActive,
  tabIndex: isActive ? 0 : -1,
  'data-tab-id': tab.id,
});

function handleMiddleClickMouseDown(e: React.MouseEvent): void {
  if (e.button === 1) e.preventDefault();
}

function handleMiddleClickAux(e: React.MouseEvent, tab: TabItem, onTabClose: (tabId: string) => void): void {
  if (e.button === 1 && !tab.isPinned) {
    e.preventDefault();
    onTabClose(tab.id);
  }
}

/** DnD-enabled shell — used when reordering / cross-pane drag applies. */
const SortableTab: React.FC<TabItemProps> = (props) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: props.tab.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 1 : 0,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={tabItemClassName(props.tab, props.isActive)}
      onClick={() => props.onTabClick(props.tab.id)}
      onMouseDown={handleMiddleClickMouseDown}
      onAuxClick={(e) => handleMiddleClickAux(e, props.tab, props.onTabClose)}
      onContextMenu={(e) => props.onContextMenu(e, props.tab.id)}
      {...attributes}
      {...listeners}
      {...tabA11yProps(props.tab, props.isActive)}
    >
      <TabItemContent {...props} />
    </div>
  );
};

/** Plain shell — single tab in a single pane, no DnD overhead. */
const StaticTab: React.FC<TabItemProps> = (props) => (
  <div
    className={tabItemClassName(props.tab, props.isActive)}
    onClick={() => props.onTabClick(props.tab.id)}
    onMouseDown={handleMiddleClickMouseDown}
    onAuxClick={(e) => handleMiddleClickAux(e, props.tab, props.onTabClose)}
    onContextMenu={(e) => props.onContextMenu(e, props.tab.id)}
    {...tabA11yProps(props.tab, props.isActive)}
  >
    <TabItemContent {...props} />
  </div>
);

// ==================== TabBar ====================

const TabBar: React.FC<TabBarProps> = ({
  tabs,
  activeTabId,
  isMultiPane,
  onTabClick,
  onTabClose,
  onTabPin,
  onCloseToRight,
  onCloseToLeft,
  onCloseOthers,
  onPopOut,
  moveToPaneTargets,
  onMoveToPane,
  onSplitVertical,
  onSplitHorizontal,
  onClosePane,
  onConnectAllTabs,
  onDisconnectAllTabs,
  onRunTool,
  onKillTool,
  onConfigTool,
}) => {
  const { t } = useTranslation();
  const {
    show: showContextMenu,
    showAt: showContextMenuAt,
    element: contextMenuElement,
  } = useContextMenu();
  const ports = useAppStore((s) => s.ports);
  // 批量开/关针对**全部标签页**（跨分屏），禁用态按全局 tabs 计算。
  const allTabs = useAppStore((s) => s.tabs);
  const pluginLauncherPortId = getTabPortId(tabs.find(tab => tab.id === activeTabId)) ?? null;
  const tabsContainerRef = useRef<HTMLDivElement>(null);
  /** Index to focus after the next `tabs` change (keyboard/close-button close). */
  const pendingFocusIndexRef = useRef<number | null>(null);

  // Per-tab status dot and warning tooltip. Warning icon is strictly reserved
  // for unexpectedly lost ports or ports in error state — NOT normally disconnected ports.
  const tabPortMeta = useMemo(() => {
    const portMap = new Map(ports.map(p => [p.id, p]));
    const map = new Map<string, {
      status: SerialPort['status'] | null;
      warningTitle?: string;
      isRemote?: boolean;
      titleTooltip?: string;
      loanTitle?: string;
    }>();
    for (const tab of tabs) {
      const portId = getTabPortId(tab);
      if (!portId) {
        map.set(tab.id, { status: null });
        continue;
      }
      const port = portMap.get(portId);
      const status: SerialPort['status'] = port?.status ?? 'disconnected';
      let warningTitle: string | undefined;
      if (isPortLost(portId)) {
        warningTitle = t('tabBar.portLostWarning');
      } else if (status === 'error') {
        warningTitle = t('tabBar.portErrorWarning');
      }
      const isRemoteSerial = tab.kind === 'serial' && isRemotePortId(tab.portId);
      let titleTooltip: string | undefined;
      if (isRemoteSerial) {
        const parsed = parseRemotePortId(tab.portId);
        const hostLabel = (port?.hostLabel || port?.hostId || parsed?.hostId || '').trim();
        const remotePortId = (port?.remotePortId || parsed?.remotePortId || port?.name || tab.portId).trim();
        const roleLabel = port?.remoteRole ? t(`collaboration.role.${port.remoteRole}`) : undefined;
        const parts = [hostLabel, remotePortId, roleLabel].filter((v): v is string => !!v);
        if (parts.length > 0) {
          titleTooltip = parts.join(' · ');
        }
      }
      const loanTitle = tab.kind === 'serial' && port?.loan
        ? (port.loan.reason ? `${port.loan.holder} · ${port.loan.reason}` : port.loan.holder)
        : undefined;
      map.set(tab.id, { status, warningTitle, isRemote: isRemoteSerial, titleTooltip, loanTitle });
    }
    return map;
  }, [ports, tabs, t]);

  // Keep the active tab scrolled into view when switching tabs.
  useEffect(() => {
    if (!activeTabId) return;
    const cssEscape = globalThis.CSS?.escape;
    const escaped = typeof cssEscape === 'function'
      ? cssEscape(activeTabId)
      : activeTabId.replace(/"/g, '\\"');
    const el = tabsContainerRef.current?.querySelector<HTMLElement>(`[data-tab-id="${escaped}"]`);
    el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [activeTabId]);

  // Vertical mouse wheel scrolls overflowing tabs horizontally.
  const handleTabsWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    const el = tabsContainerRef.current;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    }
  }, []);

  // Move focus to a surviving tab after the close commits. The store's
  // successor may differ (global last tab), so index-focus is the predictable
  // choice for a keyboard user.
  useEffect(() => {
    const index = pendingFocusIndexRef.current;
    if (index === null) return;
    pendingFocusIndexRef.current = null;
    const elements = tabsContainerRef.current?.querySelectorAll<HTMLElement>('[role="tab"]');
    if (!elements || elements.length === 0) return;
    elements[Math.min(index, elements.length - 1)]?.focus({ preventScroll: true });
  }, [tabs]);

  const requestCloseTab = useCallback((tabId: string) => {
    const index = tabs.findIndex(tab => tab.id === tabId);
    if (index >= 0) {
      // After removal the same index holds the next tab; the last one falls back left.
      pendingFocusIndexRef.current = Math.max(0, Math.min(index, tabs.length - 2));
    }
    onTabClose(tabId);
  }, [tabs, onTabClose]);

  const handleReclaimLoan = useCallback(async (portId: string) => {
    try {
      const recovery = await controlService.reclaimPortLoan(portId);
      if (recovery.error) {
        notifyError(recovery.error);
      } else {
        notifySuccess('collaboration.loan.reclaimed');
      }
    } catch (err) {
      notifyError(err);
    }
  }, []);

  const getContextMenuItems = useCallback((tabId: string): ContextMenuEntry[] => {
    const tab = tabs.find(t => t.id === tabId);
    const portMap = new Map(ports.map(p => [p.id, p]));
    const targetPortId = getTabPortId(tab);
    const targetPort = targetPortId ? portMap.get(targetPortId) : undefined;
    const targetCaps = getPortCapabilities(targetPort);

    const items: ContextMenuEntry[] = [
      { label: tab?.isPinned ? t('tabBar.contextMenu.unpin') : t('tabBar.contextMenu.pin'), icon: <Pin size={14} />, onClick: () => onTabPin(tabId) },
    ];

    items.push({ label: t('timeline.manage'), onClick: () => openTimelinePanel(tabId) });

    // 弹出入口：仅未弹出时提供（弹出后主窗内容区为占位，标签右键不再给此项）。
    if (onPopOut && tab?.kind === 'serial' && !tab.poppedOut) {
      items.push({
        label: t('terminalPopout.popOut'),
        icon: <ExternalLink size={14} />,
        onClick: () => onPopOut(tabId),
      });
    }

    // 批量连接/断开所有标签页对应的串口（issue #2-1），仅纳入有控制权限的端口。
    if (onConnectAllTabs || onDisconnectAllTabs) {
      const hasConnectable = allTabs.some(tb => {
        const portId = getTabPortId(tb);
        const port = portId ? portMap.get(portId) : undefined;
        return !!port && getPortCapabilities(port).canControl && !port.loan && port.status !== 'connected' && port.status !== 'connecting';
      });
      const hasDisconnectable = allTabs.some(tb => {
        const id = getTabPortId(tb);
        const port = id ? portMap.get(id) : undefined;
        return !!port && getPortCapabilities(port).canControl && port.status === 'connected';
      });
      items.push(
        { type: 'separator' },
        { label: t('tabBar.contextMenu.openAll'), icon: <PlugZap size={14} />, onClick: () => onConnectAllTabs?.(), disabled: !hasConnectable },
        { label: t('tabBar.contextMenu.disconnectAll'), icon: <Unplug size={14} />, onClick: () => onDisconnectAllTabs?.(), disabled: !hasDisconnectable },
      );
    }

    // 借用收回：存在外部借用租约时允许从标签右键直接收回。
    if (tab?.kind === 'serial' && targetPort?.loan) {
      items.push(
        { type: 'separator' },
        {
          label: t('sidebar.port.contextMenu.reclaimLoan'),
          icon: <RotateCcw size={14} />,
          danger: true,
          disabled: targetCaps.isRemote && !targetCaps.canLoan,
          onClick: () => { void handleReclaimLoan(tab.portId); },
        },
      );
    }

    // 外部工具：与侧边栏端口右键菜单同文案同行为（issue #2-2）。
    // 远程端口不支持本地外部工具，隐藏对应入口。
    if (targetPortId && !isRemotePortId(targetPortId) && !isRemotePort(targetPort) && (onRunTool || onConfigTool)) {
      const toolRunning = targetPort?.toolRunning === true;
      items.push({ type: 'separator' });
      if (onRunTool) {
        items.push(
          toolRunning
            ? { label: t('sidebar.port.contextMenu.killTool'), icon: <TerminalSquare size={14} />, onClick: () => onKillTool?.(targetPortId), danger: true }
            : { label: t('sidebar.port.contextMenu.runTool'), icon: <Wrench size={14} />, onClick: () => onRunTool(targetPortId), disabled: targetPort?.pluginToolRunning },
        );
      }
      if (onConfigTool) {
        items.push({ label: t('sidebar.port.contextMenu.configTool'), icon: <Wrench size={14} />, onClick: () => onConfigTool() });
      }
    }

    const canCloseRight = getClosingTabIds(tabId, 'toRight').length > 0;
    const canCloseLeft = getClosingTabIds(tabId, 'toLeft').length > 0;
    const canCloseOthers = getClosingTabIds(tabId, 'others').length > 0;

    items.push(
      { type: 'separator' },
      { label: t('tabBar.contextMenu.close'), onClick: () => requestCloseTab(tabId), disabled: !!tab?.isPinned },
      { label: t('tabBar.contextMenu.closeToRight'), onClick: () => onCloseToRight(tabId), disabled: !canCloseRight },
      { label: t('tabBar.contextMenu.closeToLeft'), onClick: () => onCloseToLeft(tabId), disabled: !canCloseLeft },
      { label: t('tabBar.contextMenu.closeOthers'), onClick: () => onCloseOthers(tabId), disabled: !canCloseOthers },
    );

    if (moveToPaneTargets && moveToPaneTargets.length > 0) {
      const storeState = useAppStore.getState();
      const allLeaves = collectLeaves(storeState.paneTree);
      items.push({ type: 'separator' });
      for (const targetPane of moveToPaneTargets) {
        const leafIdx = allLeaves.findIndex((leaf) => leaf.id === targetPane.id);
        const paneNumber = leafIdx >= 0 ? leafIdx + 1 : 1;
        const paneActiveOrFirst = targetPane.tabIds.includes(storeState.activeTabId ?? '')
          ? storeState.tabs.find((item) => item.id === storeState.activeTabId)
          : storeState.tabs.find((item) => targetPane.tabIds.includes(item.id) && (item.kind !== 'serial' || !item.poppedOut));
        const targetLabel = paneActiveOrFirst ? `${paneNumber} — ${paneActiveOrFirst.title}` : String(paneNumber);
        const label = t('tabBar.contextMenu.moveToPane', { target: targetLabel });
        items.push({
          label,
          onClick: () => onMoveToPane?.(tabId, targetPane.id),
        });
      }
    }

    return items;
  }, [tabs, allTabs, ports, onTabPin, requestCloseTab, onCloseToRight, onCloseToLeft, onCloseOthers, onPopOut, moveToPaneTargets, onMoveToPane, onConnectAllTabs, onDisconnectAllTabs, onRunTool, onKillTool, onConfigTool, handleReclaimLoan, t]);

  const handleContextMenu = useCallback((e: React.MouseEvent, tabId: string) => {
    showContextMenu(e, getContextMenuItems(tabId));
  }, [showContextMenu, getContextMenuItems]);

  const openContextMenuForTabElement = useCallback((tabEl: HTMLElement) => {
    const tabId = tabEl.dataset.tabId;
    if (!tabId) return;
    const rect = tabEl.getBoundingClientRect();
    showContextMenuAt(rect.left, rect.bottom, getContextMenuItems(tabId), tabEl);
  }, [showContextMenuAt, getContextMenuItems]);

  const handleTablistKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    // Close and timeline badge affordances are native buttons with their own Enter/Space handling.
    if (target.closest('.tab-close, .timeline-badge')) return;
    const tabEl = target.closest<HTMLElement>('[role="tab"]');
    if (!tabEl || !e.currentTarget.contains(tabEl)) return;
    const index = tabs.findIndex(tab => tab.id === tabEl.dataset.tabId);
    if (index < 0) return;

    const focusTabAt = (nextIndex: number) => {
      const elements = e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]');
      if (elements.length === 0) return;
      const wrapped = ((nextIndex % elements.length) + elements.length) % elements.length;
      elements[wrapped]?.focus({ preventScroll: true });
    };

    const closeFocused = () => {
      const tab = tabs[index];
      if (!tab || tab.isPinned) return;
      pendingFocusIndexRef.current = Math.max(0, Math.min(index, tabs.length - 2));
      onTabClose(tab.id);
    };

    switch (e.key) {
      case 'ArrowLeft':
        e.preventDefault();
        focusTabAt(index - 1);
        break;
      case 'ArrowRight':
        e.preventDefault();
        focusTabAt(index + 1);
        break;
      case 'Home':
        e.preventDefault();
        focusTabAt(0);
        break;
      case 'End':
        e.preventDefault();
        focusTabAt(tabs.length - 1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        onTabClick(tabs[index].id);
        break;
      case 'Delete':
        e.preventDefault();
        closeFocused();
        break;
      case 'w':
      case 'W':
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
          e.preventDefault();
          closeFocused();
        }
        break;
      case 'F10':
        if (e.shiftKey) {
          e.preventDefault();
          openContextMenuForTabElement(tabEl);
        }
        break;
      case 'ContextMenu':
        e.preventDefault();
        openContextMenuForTabElement(tabEl);
        break;
      default:
        break;
    }
  }, [tabs, onTabClick, onTabClose, openContextMenuForTabElement]);

  const tabIds = tabs.map(t => t.id);

  // Single-pane with ≤1 tab: no sorting targets, render static shells (no
  // DnD overhead — the SortableContext gets an empty item list). With >1 tab
  // or multi-pane, tabs render as sortable so @dnd-kit handles both
  // within-pane reordering and cross-pane moves.
  const shouldUseSortable = tabIds.length >= 2 || !!isMultiPane;
  const closeLabel = t('tabBar.contextMenu.close');

  const renderTab = (tab: TabItem) => {
    const meta = tabPortMeta.get(tab.id);
    const itemProps: TabItemProps = {
      tab,
      isActive: tab.id === activeTabId,
      portStatus: meta?.status ?? null,
      portWarningTitle: meta?.warningTitle,
      isRemote: meta?.isRemote,
      titleTooltip: meta?.titleTooltip,
      loanTitle: meta?.loanTitle,
      closeLabel,
      onTabClick,
      onTabClose: requestCloseTab,
      onContextMenu: handleContextMenu,
    };
    return shouldUseSortable
      ? <SortableTab key={tab.id} {...itemProps} />
      : <StaticTab key={tab.id} {...itemProps} />;
  };

  return (
    <SortableContext
      items={shouldUseSortable ? tabIds : []}
      strategy={horizontalListSortingStrategy}
    >
      <div className="tab-bar">
        <div
          ref={tabsContainerRef}
          className="tab-bar-tabs"
          role="tablist"
          aria-label={t('tabBar.tabsLabel')}
          aria-orientation="horizontal"
          onKeyDown={handleTablistKeyDown}
          onWheel={handleTabsWheel}
        >
          {tabs.map(renderTab)}
        </div>
        <div className="tab-bar-actions">
          <PluginTabLauncher portId={pluginLauncherPortId} />
          {((onSplitVertical && onSplitHorizontal) || onClosePane) && (
            <div className="tab-bar-split-group">
              {onSplitVertical && (
                <button
                  type="button"
                  className="icon-btn"
                  title={t('mainDisplay.toolbar.splitVertical')}
                  aria-label={t('mainDisplay.toolbar.splitVertical')}
                  onClick={(e) => { e.stopPropagation(); onSplitVertical(); }}
                >
                  <Columns2 size={13} />
                </button>
              )}
              {onSplitHorizontal && (
                <button
                  type="button"
                  className="icon-btn"
                  title={t('mainDisplay.toolbar.splitHorizontal')}
                  aria-label={t('mainDisplay.toolbar.splitHorizontal')}
                  onClick={(e) => { e.stopPropagation(); onSplitHorizontal(); }}
                >
                  <Rows2 size={13} />
                </button>
              )}
              {onClosePane && (
                <button
                  type="button"
                  className="icon-btn"
                  title={t('pane.closeAndMerge')}
                  aria-label={t('pane.closeAndMerge')}
                  onClick={(e) => { e.stopPropagation(); onClosePane(); }}
                >
                  <PanelTopClose size={13} />
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {contextMenuElement}
    </SortableContext>
  );
};

export default TabBar;
