import React, { useState, useCallback } from 'react';
import type { TabItem, SplitPane } from '../../types';
import ContextMenu from '../shared/ContextMenu';
import type { ContextMenuEntry } from '../shared/ContextMenu';
import {
  Pin, X
} from 'lucide-react';

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
      items.push({ label: '移动到分屏', onClick: () => {} });
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

  return (
    <div className="tab-bar">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            className={`tab-item${isActive ? ' active' : ''}${tab.isPinned ? ' pinned' : ''}`}
            onClick={() => onTabClick(tab.id)}
            onContextMenu={(e) => handleContextMenu(e, tab.id)}
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
      })}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={getContextMenuItems(contextMenu.tabId)}
          onClose={handleCloseContextMenu}
        />
      )}
    </div>
  );
};

export default TabBar;