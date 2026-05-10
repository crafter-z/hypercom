/**
 * 主显示区标签栏
 * 每个串口对应一个标签，支持右键菜单（关闭、固定、移动至分屏）
 */

import React, { useState, useCallback } from 'react';
import type { TabItem, SplitPane } from '../../types';

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

interface ContextMenu {
  x: number;
  y: number;
  tabId: string;
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
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);

  const handleContextMenu = useCallback((e: React.MouseEvent, tabId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, tabId });
  }, []);

  const handleCloseContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  // Close context menu when clicking outside
  React.useEffect(() => {
    if (contextMenu) {
      const handler = () => setContextMenu(null);
      window.addEventListener('click', handler);
      return () => window.removeEventListener('click', handler);
    }
  }, [contextMenu]);

  return (
    <div className="tab-bar">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`tab-item ${tab.isActive ? 'active' : ''} ${tab.isPinned ? 'pinned' : ''}`}
          onClick={() => onTabClick(tab.id)}
          onContextMenu={(e) => handleContextMenu(e, tab.id)}
        >
          {/* 状态指示 */}
          <span
            className="status-dot"
            style={{
              background: tab.id === activeTabId ? 'var(--text-link)' : 'var(--text-secondary)',
            }}
          />

          {/* 标签标题 */}
          <span className="text-ellipsis" style={{ flex: 1, fontSize: 12 }}>
            {tab.title}
          </span>

          {/* 固定标记 */}
          {tab.isPinned && (
            <span style={{ fontSize: 10, color: 'var(--text-link)' }}>📌</span>
          )}

          {/* 关闭按钮 */}
          {!tab.isPinned && (
            <span
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation();
                onTabClose(tab.id);
              }}
              title="关闭标签页"
            >
              ✕
            </span>
          )}
        </div>
      ))}

      {/* 右键菜单 */}
      {contextMenu && (
        <div
          className="context-menu animate-fade-in"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className="context-menu-item"
            onClick={() => {
              onTabPin(contextMenu.tabId);
              handleCloseContextMenu();
            }}
          >
            {tabs.find(t => t.id === contextMenu.tabId)?.isPinned ? '📌 取消固定' : '📌 固定选项卡'}
          </div>

          <div className="context-menu-separator" />

          <div
            className="context-menu-item"
            onClick={() => {
              onTabClose(contextMenu.tabId);
              handleCloseContextMenu();
            }}
          >
            关闭
          </div>
          <div
            className="context-menu-item"
            onClick={() => {
              onCloseToRight(contextMenu.tabId);
              handleCloseContextMenu();
            }}
          >
            关闭右侧
          </div>
          <div
            className="context-menu-item"
            onClick={() => {
              onCloseToLeft(contextMenu.tabId);
              handleCloseContextMenu();
            }}
          >
            关闭左侧
          </div>
          <div
            className="context-menu-item"
            onClick={() => {
              onCloseOthers(contextMenu.tabId);
              handleCloseContextMenu();
            }}
          >
            关闭其他
          </div>

          {/* 移动到其他分屏 */}
          {moveToPaneTargets && moveToPaneTargets.length > 0 && (
            <>
              <div className="context-menu-separator" />
              <div className="context-menu-item" style={{ color: 'var(--text-secondary)', cursor: 'default' }}>
                移动到分屏
              </div>
              {moveToPaneTargets.map((pane) => (
                <div
                  key={pane.id}
                  className="context-menu-item"
                  onClick={() => {
                    onMoveToPane?.(contextMenu.tabId, pane.id);
                    handleCloseContextMenu();
                  }}
                >
                  分屏 {pane.id.replace('pane-', '').slice(0, 4)}
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default TabBar;
