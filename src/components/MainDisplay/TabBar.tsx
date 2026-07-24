import React, { useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { TabItem, LeafPane } from '../../types';
import ContextMenu from '../shared/ContextMenu';
import type { ContextMenuEntry } from '../shared/ContextMenu';
import { Pin, X, AlertTriangle, Columns2, Rows2 } from 'lucide-react';
import {
  SortableContext,
  useSortable,
  horizontalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useAppStore } from '../../stores/useAppStore';

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
  moveToPaneTargets?: LeafPane[];
  onMoveToPane?: (tabId: string, targetPaneId: string) => void;
  onSplitVertical?: () => void;
  onSplitHorizontal?: () => void;
}

// ==================== Tab rendering ====================

interface TabItemProps {
  tab: TabItem;
  isActive: boolean;
  isPortDisconnected: boolean;
  onTabClick: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
  onContextMenu: (e: React.MouseEvent, tabId: string) => void;
}

const tabItemClassName = (tab: TabItem, isActive: boolean): string =>
  `tab-item${isActive ? ' active' : ''}${tab.isPinned ? ' pinned' : ''}`;

/** Presentational tab innards shared by the sortable and static shells —
 * the single source of truth for what a tab looks like. */
const TabItemContent: React.FC<TabItemProps> = ({ tab, isPortDisconnected, onTabClose }) => (
  <>
    <span className="tab-status-dot" />
    {isPortDisconnected && (
      <AlertTriangle size={12} className="tab-warning-icon" />
    )}
    <span className="tab-title">{tab.title}</span>
    {tab.isPinned && <Pin size={10} className="tab-pin-icon" />}
    {!tab.isPinned && (
      <span
        className="tab-close"
        onClick={(e) => { e.stopPropagation(); onTabClose(tab.id); }}
      >
        <X size={12} />
      </span>
    )}
  </>
);

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
  moveToPaneTargets,
  onMoveToPane,
  onSplitVertical,
  onSplitHorizontal,
}) => {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);
  const { t } = useTranslation();
  const ports = useAppStore((s) => s.ports);

  // Lookup: portId → is disconnected (status 'disconnected' or port missing).
  // A missing port (USB unplug removed it from the list) is treated as
  // disconnected so the warning icon stays visible on the stale tab.
  const disconnectedPortIds = useMemo(() => {
    const portMap = new Map(ports.map(p => [p.id, p]));
    const set = new Set<string>();
    for (const tab of tabs) {
      const port = portMap.get(tab.id);
      if (!port || port.status === 'disconnected') {
        set.add(tab.id);
      }
    }
    return set;
  }, [ports, tabs]);

  const handleContextMenu = useCallback((e: React.MouseEvent, tabId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, tabId });
  }, []);

  const handleCloseContextMenu = useCallback(() => setContextMenu(null), []);

  const getContextMenuItems = useCallback((tabId: string): ContextMenuEntry[] => {
    const tab = tabs.find(t => t.id === tabId);
    const items: ContextMenuEntry[] = [
      { label: tab?.isPinned ? t('tabBar.contextMenu.unpin') : t('tabBar.contextMenu.pin'), icon: <Pin size={14} />, onClick: () => onTabPin(tabId) },
      { type: 'separator' },
      { label: t('tabBar.contextMenu.close'), onClick: () => onTabClose(tabId) },
      { label: t('tabBar.contextMenu.closeToRight'), onClick: () => onCloseToRight(tabId) },
      { label: t('tabBar.contextMenu.closeToLeft'), onClick: () => onCloseToLeft(tabId) },
      { label: t('tabBar.contextMenu.closeOthers'), onClick: () => onCloseOthers(tabId) },
    ];

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
  }, [tabs, onTabPin, onTabClose, onCloseToRight, onCloseToLeft, onCloseOthers, moveToPaneTargets, onMoveToPane, t]);

  const tabIds = tabs.map(t => t.id);

  // Single-pane with ≤1 tab: no sorting targets, render static shells (no
  // DnD overhead — the SortableContext gets an empty item list). With >1 tab
  // or multi-pane, tabs render as sortable so @dnd-kit handles both
  // within-pane reordering and cross-pane moves.
  const shouldUseSortable = tabIds.length >= 2 || !!isMultiPane;

  const renderTab = (tab: TabItem) => {
    const itemProps: TabItemProps = {
      tab,
      isActive: tab.id === activeTabId,
      isPortDisconnected: disconnectedPortIds.has(tab.id),
      onTabClick,
      onTabClose,
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
        {tabs.map(renderTab)}
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

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={getContextMenuItems(contextMenu.tabId)}
          onClose={handleCloseContextMenu}
        />
      )}
    </SortableContext>
  );
};

export default TabBar;
