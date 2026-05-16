import React, { useState, useCallback } from 'react';
import type { TabItem, SplitPane } from '../../types';
import ContextMenu from '../shared/ContextMenu';
import type { ContextMenuEntry } from '../shared/ContextMenu';
import { Pin, X } from 'lucide-react';
import { useAppStore } from '../../stores/useAppStore';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  horizontalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

interface TabBarProps {
  tabs: TabItem[];
  activeTabId: string | null;
  onTabClick: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
  onTabPin: (tabId: string) => void;
  onCloseToRight: (tabId: string) => void;
  onCloseToLeft: (tabId: string) => void;
  onCloseOthers: (tabId: string) => void;
  moveToPaneTargets?: SplitPane[];
  onMoveToPane?: (tabId: string, targetPaneId: string) => void;
}

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
    opacity: isDragging ? 0.5 : 1,
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

const TabBar: React.FC<TabBarProps> = ({
  tabs,
  activeTabId,
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
  const reorderTabs = useAppStore((s) => s.reorderTabs);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const storeState = useAppStore.getState();
      const oldIndex = storeState.tabs.findIndex(t => t.id === active.id);
      const newIndex = storeState.tabs.findIndex(t => t.id === over.id);
      if (oldIndex !== -1 && newIndex !== -1) {
        reorderTabs(oldIndex, newIndex);
      }
    }
  }, [reorderTabs]);

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
      for (const pane of moveToPaneTargets) {
        const paneLabel = `分屏 ${pane.id.replace('pane-', '').slice(0, 4)}`;
        items.push({
          label: paneLabel,
          onClick: () => onMoveToPane?.(tabId, pane.id),
        });
      }
    }

    return items;
  }, [tabs, onTabPin, onTabClose, onCloseToRight, onCloseToLeft, onCloseOthers, moveToPaneTargets, onMoveToPane]);

  const tabIds = tabs.map(t => t.id);

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={tabIds} strategy={horizontalListSortingStrategy}>
        <div className="tab-bar">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            return (
              <SortableTab
                key={tab.id}
                tab={tab}
                isActive={isActive}
                onTabClick={onTabClick}
                onTabClose={onTabClose}
                onContextMenu={handleContextMenu}
              />
            );
          })}
        </div>
      </SortableContext>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={getContextMenuItems(contextMenu.tabId)}
          onClose={handleCloseContextMenu}
        />
      )}
    </DndContext>
  );
};

export default TabBar;
