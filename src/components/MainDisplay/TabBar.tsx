/**
 * 主显示区标签栏
 * 每个串口对应一个标签，支持拖拽排序、右键菜单、固定选项卡
 */

import React, { useState } from 'react';
import type { TabItem } from '../../types';

interface TabBarProps {
  tabs: TabItem[];
  activeTabId: string | null;
  onTabClick: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
  onTabPin: (tabId: string) => void;
  onCloseToRight: (tabId: string) => void;
  onCloseToLeft: (tabId: string) => void;
  onCloseOthers: (tabId: string) => void;
}

const TabBar: React.FC<TabBarProps> = ({
  tabs,
  activeTabId: _activeTabId,
  onTabClick,
  onTabClose,
  onTabPin,
  onCloseToRight,
  onCloseToLeft,
  onCloseOthers,
}) => {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);

  const handleContextMenu = (e: React.MouseEvent, tabId: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, tabId });
  };

  const handleCloseContextMenu = () => {
    setContextMenu(null);
  };

  return (
    <div className="tab-bar" onClick={handleCloseContextMenu}>
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
              background: tab.isActive ? 'var(--text-link)' : 'var(--text-secondary)',
            }}
          />

          {/* 标签标题 */}
          <span className="text-ellipsis" style={{ flex: 1, fontSize: 12 }}>
            {tab.title}
          </span>

          {/* 固定标记 */}
          {tab.isPinned && <span style={{ fontSize: 10, color: 'var(--text-link)' }}>📌</span>}

          {/* 关闭按钮 */}
          {!tab.isPinned && (
            <span
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation();
                onTabClose(tab.id);
              }}
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
        >
          <div className="context-menu-item" onClick={() => { onTabPin(contextMenu.tabId); handleCloseContextMenu(); }}>
            {tabs.find(t => t.id === contextMenu.tabId)?.isPinned ? '取消固定' : '固定选项卡'}
          </div>
          <div className="context-menu-separator" />
          <div className="context-menu-item" onClick={() => { onTabClose(contextMenu.tabId); handleCloseContextMenu(); }}>
            关闭当前
          </div>
          <div className="context-menu-item" onClick={() => { onCloseToRight(contextMenu.tabId); handleCloseContextMenu(); }}>
            关闭右侧
          </div>
          <div className="context-menu-item" onClick={() => { onCloseToLeft(contextMenu.tabId); handleCloseContextMenu(); }}>
            关闭左侧
          </div>
          <div className="context-menu-item" onClick={() => { onCloseOthers(contextMenu.tabId); handleCloseContextMenu(); }}>
            关闭其他
          </div>
        </div>
      )}
    </div>
  );
};

export default TabBar;
