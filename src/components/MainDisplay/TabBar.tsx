import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { TabItem, LeafPane } from '../../types';
import { useContextMenu } from '../shared/ContextMenu';
import type { ContextMenuEntry } from '../shared/ContextMenu';
import { Pin, X, AlertTriangle, Columns2, Rows2, ExternalLink, PlugZap, Unplug, Wrench, TerminalSquare } from 'lucide-react';
import PluginTabLauncher from './PluginTabLauncher';
import { TimelineBadge, openTimelinePanel } from './TimelineControls';
import {
  SortableContext,
  useSortable,
  horizontalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useAppStore, getTabPortId } from '../../stores/useAppStore';

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
  isPortDisconnected: boolean;
  closeLabel: string;
  onTabClick: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
  onContextMenu: (e: React.MouseEvent, tabId: string) => void;
}

const tabItemClassName = (tab: TabItem, isActive: boolean): string =>
  `tab-item${isActive ? ' active' : ''}${tab.isPinned ? ' pinned' : ''}`;

/** Presentational tab innards shared by the sortable and static shells —
 * the single source of truth for what a tab looks like. */
const TabItemContent: React.FC<TabItemProps> = ({ tab, isPortDisconnected, closeLabel, onTabClose }) => (
  <>
    {getTabPortId(tab) !== null && <span className="tab-status-dot" />}
    {isPortDisconnected && (
      <AlertTriangle size={12} className="tab-warning-icon" />
    )}
    <span className="tab-title">{tab.title}</span>
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

  // Lookup: portId → is disconnected (status 'disconnected' or port missing).
  // A missing port (USB unplug removed it from the list) is treated as
  // disconnected so the warning icon stays visible on the stale tab.
  const disconnectedPortIds = useMemo(() => {
    const portMap = new Map(ports.map(p => [p.id, p]));
    const set = new Set<string>();
    for (const tab of tabs) {
      const portId = getTabPortId(tab);
      if (!portId) continue;
      const port = portMap.get(portId);
      if (!port || port.status === 'disconnected') set.add(tab.id);
    }
    return set;
  }, [ports, tabs]);

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

  const getContextMenuItems = useCallback((tabId: string): ContextMenuEntry[] => {
    const tab = tabs.find(t => t.id === tabId);
    const portMap = new Map(ports.map(p => [p.id, p]));
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

    // 批量连接/断开所有标签页对应的串口（issue #2-1）。
    if (onConnectAllTabs || onDisconnectAllTabs) {
      const hasConnectable = allTabs.some(tb => {
        const portId = getTabPortId(tb);
        const port = portId ? portMap.get(portId) : undefined;
        return !!port && port.status !== 'connected' && port.status !== 'connecting';
      });
      const hasDisconnectable = allTabs.some(tb => { const id = getTabPortId(tb); return id !== null && portMap.get(id)?.status === 'connected'; });
      items.push(
        { type: 'separator' },
        { label: t('tabBar.contextMenu.openAll'), icon: <PlugZap size={14} />, onClick: () => onConnectAllTabs?.(), disabled: !hasConnectable },
        { label: t('tabBar.contextMenu.disconnectAll'), icon: <Unplug size={14} />, onClick: () => onDisconnectAllTabs?.(), disabled: !hasDisconnectable },
      );
    }

    // 外部工具：与侧边栏端口右键菜单同文案同行为（issue #2-2）。
    // 执行入口始终可见；未配置时点击跳转配置页。运行中显示终止。
    const targetPortId = getTabPortId(tab);
    if (targetPortId && (onRunTool || onConfigTool)) {
      const toolRunning = portMap.get(targetPortId)?.toolRunning === true;
      items.push({ type: 'separator' });
      if (onRunTool) {
        items.push(
          toolRunning
            ? { label: t('sidebar.port.contextMenu.killTool'), icon: <TerminalSquare size={14} />, onClick: () => onKillTool?.(targetPortId), danger: true }
            : { label: t('sidebar.port.contextMenu.runTool'), icon: <Wrench size={14} />, onClick: () => onRunTool(targetPortId) },
        );
      }
      if (onConfigTool) {
        items.push({ label: t('sidebar.port.contextMenu.configTool'), icon: <Wrench size={14} />, onClick: () => onConfigTool() });
      }
    }

    items.push(
      { type: 'separator' },
      { label: t('tabBar.contextMenu.close'), onClick: () => requestCloseTab(tabId) },
      { label: t('tabBar.contextMenu.closeToRight'), onClick: () => onCloseToRight(tabId) },
      { label: t('tabBar.contextMenu.closeToLeft'), onClick: () => onCloseToLeft(tabId) },
      { label: t('tabBar.contextMenu.closeOthers'), onClick: () => onCloseOthers(tabId) },
    );

    if (moveToPaneTargets && moveToPaneTargets.length > 0) {
      items.push({ type: 'separator' });
      for (const targetPane of moveToPaneTargets) {
        const label = t('tabBar.contextMenu.moveToPane', { target: targetPane.id.replace('pane-', '').slice(0, 4) });
        items.push({
          label,
          onClick: () => onMoveToPane?.(tabId, targetPane.id),
        });
      }
    }

    return items;
  }, [tabs, allTabs, ports, onTabPin, requestCloseTab, onCloseToRight, onCloseToLeft, onCloseOthers, onPopOut, moveToPaneTargets, onMoveToPane, onConnectAllTabs, onDisconnectAllTabs, onRunTool, onKillTool, onConfigTool, t]);

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
    // The close affordance is a native button with its own Enter/Space handling.
    if (target.closest('.tab-close')) return;
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
        if (e.ctrlKey) {
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
    const itemProps: TabItemProps = {
      tab,
      isActive: tab.id === activeTabId,
      isPortDisconnected: disconnectedPortIds.has(tab.id),
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
        >
          {tabs.map(renderTab)}
        </div>
        <div className="tab-bar-actions">
          <PluginTabLauncher portId={pluginLauncherPortId} />
          {onSplitVertical && onSplitHorizontal && (
            <div className="tab-bar-split-group">
              <button className="icon-btn" title={t('mainDisplay.toolbar.splitVertical')}
                onClick={(e) => { e.stopPropagation(); onSplitVertical(); }}>
                <Columns2 size={13} />
              </button>
              <button className="icon-btn" title={t('mainDisplay.toolbar.splitHorizontal')}
                onClick={(e) => { e.stopPropagation(); onSplitHorizontal(); }}>
                <Rows2 size={13} />
              </button>
            </div>
          )}
        </div>
      </div>

      {contextMenuElement}
    </SortableContext>
  );
};

export default TabBar;
