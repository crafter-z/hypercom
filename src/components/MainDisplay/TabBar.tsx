import React, { useState, useCallback } from 'react';
import type { TabItem, SplitPane } from '../../types';
import ContextMenu from '../shared/ContextMenu';
import type { ContextMenuEntry } from '../shared/ContextMenu';
import { Pin, X } from 'lucide-react';
import {
  SortableContext,
  useSortable,
  horizontalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

interface TabBarProps {
  paneId: string;
  tabs: TabItem[];
  activeTabId: string | null;
  isMultiPane?: boolean;
  onTabClick: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
  onTabPin: (tabId: string) => void;
  onCloseToRight: (tabId: string) => void;
  onCloseToLeft: (tabId: string) => void;
  onCloseOthers: (tabId: string) => void;
  moveToPaneTargets?: SplitPane[];
  onMoveToPane?: (tabId: string, targetPaneId: string) => void;
}

// ==================== SortableTab ====================

const SortableTab: React.FC<{
  tab: TabItem;
  isActive: boolean;
  onTabClick: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
  onContextMenu: (e: React.MouseEvent, tabId: string) => void;
}> = ({ tab, isActive, onTabClick, onTabClose, onContextMenu }) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: tab.id });

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
      className={`tab-item${isActive ? ' active' : ''}${tab.isPinned ? ' pinned' : ''}`}
      onClick={() => onTabClick(tab.id)}
      onContextMenu={(e) => onContextMenu(e, tab.id)}
      {...attributes}
      {...listeners}
    >
      <span
        className="tab-status-dot"
        style={{ background: isActive ? 'var(--text-link)' : 'var(--text-secondary)' }}
      />
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
    </div>
  );
};

// ==================== TabBar ====================

const TabBar: React.FC<TabBarProps> = ({
  paneId,
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
}) => {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);

  const handleContextMenu = useCallback((e: React.MouseEvent, tabId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, tabId });
  }, []);

  const handleCloseContextMenu = useCallback(() => setContextMenu(null), []);

  const getContextMenuItems = useCallback((tabId: string): ContextMenuEntry[] => {
    const tab = tabs.find(t => t.id === tabId);
    const items: ContextMenuEntry[] = [
      { label: tab?.isPinned ? '取消固定' : '固定选项卡', icon: <Pin size={14} />, onClick: () => onTabPin(tabId) },
      { type: 'separator' },
      { label: '关闭', onClick: () => onTabClose(tabId) },
      { label: '关闭右侧', onClick: () => onCloseToRight(tabId) },
      { label: '关闭左侧', onClick: () => onCloseToLeft(tabId) },
      { label: '关闭其他', onClick: () => onCloseOthers(tabId) },
    ];

    if (moveToPaneTargets && moveToPaneTargets.length > 0) {
      items.push({ type: 'separator' });
      for (const targetPane of moveToPaneTargets) {
        const label = `移至分屏 ${targetPane.id.replace('pane-', '').slice(0, 4)}`;
        items.push({
          label,
          onClick: () => onMoveToPane?.(tabId, targetPane.id),
        });
      }
    }

    return items;
  }, [tabs, onTabPin, onTabClose, onCloseToRight, onCloseToLeft, onCloseOthers, moveToPaneTargets, onMoveToPane]);

  const tabIds = tabs.map(t => t.id);

  // When single-pane with ≤1 tab: no sorting targets, render plain (no DnD overhead).
  // When multi-pane: always use SortableContext so tabs are draggable across panes.
  const shouldUseSortable = tabIds.length >= 2 || !!isMultiPane;

  if (!shouldUseSortable) {
    const tab = tabs[0];
    const ctxItems = tab ? getContextMenuItems(tab.id) : [];
    void paneId; // suppress unused warning — paneId is for parent DnD identification
    return (
      <div className="tab-bar">
        {tab && (
          <div
            className={`tab-item${tab.id === activeTabId ? ' active' : ''}${tab.isPinned ? ' pinned' : ''}`}
            onClick={() => onTabClick(tab.id)}
            onContextMenu={(e) => handleContextMenu(e, tab.id)}
          >
            <span
              className="tab-status-dot"
              style={{ background: tab.id === activeTabId ? 'var(--text-link)' : 'var(--text-secondary)' }}
            />
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
          </div>
        )}
        {contextMenu && (
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            items={ctxItems}
            onClose={handleCloseContextMenu}
          />
        )}
      </div>
    );
  }

  // With >1 tab or multi-pane: always render as sortable so @dnd-kit can
  // handle both within-pane reordering and cross-pane tab moves.
  void paneId; // suppress unused warning — paneId is for parent DnD identification
  return (
    <SortableContext items={tabIds} strategy={horizontalListSortingStrategy}>
      <div className="tab-bar">
        {tabs.map((tab) => (
          <SortableTab
            key={tab.id}
            tab={tab}
            isActive={tab.id === activeTabId}
            onTabClick={onTabClick}
            onTabClose={onTabClose}
            onContextMenu={handleContextMenu}
          />
        ))}
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
