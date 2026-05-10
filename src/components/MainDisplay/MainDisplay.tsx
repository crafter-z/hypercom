/**
 * 主串口显示窗口区
 * 支持多分屏渲染、标签页系统、终端显示
 * 每个分屏区域独立渲染自己的标签栏和终端
 */

import React, { useCallback, useRef, useState, useEffect } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import TabBar from './TabBar';
import TerminalView from './TerminalView';

// ==================== 分屏面板 ====================

interface PaneProps {
  paneId: string;
  tabIds: string[];
  size: number;
  isFocused: boolean;
  onFocus: () => void;
}

const Pane: React.FC<PaneProps> = ({ paneId, tabIds, isFocused, onFocus }) => {
  const {
    tabs,
    activeTabId,
    terminals,
    panes,
    setActiveTab,
    closeTab,
    pinTab,
    closeTabsToRight,
    closeTabsToLeft,
    closeOtherTabs,
    moveTabToPane,
  } = useAppStore();

  const paneTabs = tabs.filter(t => tabIds.includes(t.id));

  // Per-pane display tab: use global activeTab if it belongs here, else local fallback
  const [localActiveTabId, setLocalActiveTabId] = useState<string | null>(null);
  const displayTabId = (activeTabId && tabIds.includes(activeTabId))
    ? activeTabId
    : (localActiveTabId && tabIds.includes(localActiveTabId) ? localActiveTabId : paneTabs[0]?.id || null);
  const displayTab = paneTabs.find(t => t.id === displayTabId);

  const otherPanes = panes.filter(p => p.id !== paneId);

  const handleTabClick = useCallback((tabId: string) => {
    onFocus();
    setActiveTab(tabId);
    setLocalActiveTabId(tabId);
  }, [onFocus, setActiveTab]);

  const handleMoveTabToPane = useCallback((tabId: string, targetPaneId: string) => {
    moveTabToPane(tabId, targetPaneId);
    if (tabId === localActiveTabId && paneTabs.length <= 1) {
      setLocalActiveTabId(null);
    }
  }, [moveTabToPane, localActiveTabId, paneTabs.length]);

  // Keep localActiveTabId in sync when tabs change
  useEffect(() => {
    if (localActiveTabId && !tabIds.includes(localActiveTabId)) {
      setLocalActiveTabId(tabIds[0] || null);
    }
  }, [tabIds, localActiveTabId]);

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        outline: isFocused ? '1px solid var(--bg-active)' : 'none',
        outlineOffset: -1,
      }}
      onClick={onFocus}
    >
      {/* 标签栏 */}
      <div style={{ display: 'flex', alignItems: 'center', background: 'var(--bg-secondary)' }}>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <TabBar
            tabs={paneTabs}
            activeTabId={displayTabId}
            onTabClick={handleTabClick}
            onTabClose={closeTab}
            onTabPin={pinTab}
            onCloseToRight={closeTabsToRight}
            onCloseToLeft={closeTabsToLeft}
            onCloseOthers={closeOtherTabs}
            moveToPaneTargets={otherPanes}
            onMoveToPane={handleMoveTabToPane}
          />
        </div>
      </div>

      {/* 终端工具栏 */}
      {displayTab && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '2px 12px',
          background: 'var(--bg-secondary)',
          borderBottom: '1px solid var(--border-color)',
          fontSize: 11,
          color: 'var(--text-secondary)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="status-dot connected" />
            <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{displayTab.title}</span>
            <span>(115200, 8N1)</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span>编码:</span>
            <select className="select" style={{ fontSize: 11, padding: '1px 16px 1px 4px' }}>
              <option>ASCII</option>
              <option>UTF-8</option>
              <option>GBK</option>
            </select>
          </div>
        </div>
      )}

      {/* 终端内容 */}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {paneTabs.length > 0 && displayTab ? (
          <TerminalView
            portId={displayTab.id}
            terminal={terminals[displayTab.id]}
          />
        ) : paneTabs.length === 0 ? (
          <div style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-secondary)',
            fontSize: 13,
            height: '100%',
          }}>
            双击左侧串口打开标签页
          </div>
        ) : null}
      </div>
    </div>
  );
};

// ==================== 可拖拽分割线 ====================

interface ResizeHandleProps {
  onResize: (delta: number) => void;
  direction: 'horizontal' | 'vertical';
}

const ResizeHandle: React.FC<ResizeHandleProps> = ({ onResize, direction }) => {
  const handleRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) return;
    const handleMouseMove = (e: MouseEvent) => {
      onResize(direction === 'vertical' ? e.movementX : e.movementY);
    };
    const handleMouseUp = () => setDragging(false);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragging, onResize, direction]);

  const isH = direction === 'vertical';
  return (
    <div
      ref={handleRef}
      style={{
        flexShrink: 0,
        width: isH ? 5 : '100%',
        height: isH ? '100%' : 5,
        cursor: isH ? 'col-resize' : 'row-resize',
        background: dragging ? 'var(--bg-active)' : 'var(--border-color)',
        transition: dragging ? 'none' : 'background 0.15s',
        zIndex: 10,
      }}
      onMouseDown={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
    />
  );
};

// ==================== 主组件 ====================

const MainDisplay: React.FC = () => {
  const {
    panes,
    tabs,
    activeTabId,
    focusedPaneId,
    setFocusedPane,
    splitPane,
  } = useAppStore();

  const [paneSizes, setPaneSizes] = useState<number[]>(() =>
    panes.map(p => p.size * 100)
  );
  const containerRef = useRef<HTMLDivElement>(null);

  // Sync sizes when panes change externally
  useEffect(() => {
    const total = panes.reduce((s, p) => s + p.size, 0) || 1;
    setPaneSizes(panes.map(p => (p.size / total) * 100));
  }, [panes.length]);

  const handleResize = useCallback((index: number, delta: number) => {
    setPaneSizes(prev => {
      const totalWidth = containerRef.current?.clientWidth || 1200;
      const deltaPct = (delta / totalWidth) * 100;
      const next = [...prev];
      if (delta > 0) {
        next[index] = Math.min(85, next[index] + deltaPct);
        next[index + 1] = Math.max(15, next[index + 1] - deltaPct);
      } else {
        next[index] = Math.max(15, next[index] + deltaPct);
        next[index + 1] = Math.min(85, next[index + 1] - deltaPct);
      }
      return next;
    });
  }, []);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* 全局工具栏：分屏与标签操作 */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        background: 'var(--bg-secondary)',
        borderBottom: '1px solid var(--border-color)',
        padding: '2px 8px',
        gap: 4,
      }}>
        <button className="btn btn-icon btn-sm" title="新建标签页" onClick={() => {
          // Find an available port and open it
          const { ports } = useAppStore.getState();
          const openedPortIds = new Set(tabs.map(t => t.id));
          const available = ports.find(p => !openedPortIds.has(p.id));
          if (available) {
            const { openTab } = useAppStore.getState();
            openTab(available.id);
          }
        }}>
          +
        </button>
        <button
          className="btn btn-icon btn-sm"
          title="左右分屏 (垂直分割)"
          onClick={() => splitPane('vertical')}
        >
          ⏶
        </button>
        <button
          className="btn btn-icon btn-sm"
          title="上下分屏 (水平分割)"
          onClick={() => splitPane('horizontal')}
        >
          ⏷
        </button>
        <span style={{ fontSize: 10, color: 'var(--text-secondary)', marginLeft: 4 }}>
          {panes.length > 1 ? `${panes.length} 个分屏` : ''}
        </span>
      </div>

      {/* 分屏区 */}
      <div ref={containerRef} style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {panes.map((pane, idx) => (
          <React.Fragment key={pane.id}>
            <div style={{
              flex: idx === 0 && paneSizes.length === panes.length
                ? `0 0 ${paneSizes[idx] || 100 / panes.length}%`
                : 1,
              display: 'flex',
              overflow: 'hidden',
            }}>
              <Pane
                paneId={pane.id}
                tabIds={pane.tabIds}
                size={pane.size}
                isFocused={pane.id === focusedPaneId}
                onFocus={() => setFocusedPane(pane.id)}
              />
            </div>
            {idx < panes.length - 1 && (
              <ResizeHandle
                direction="vertical"
                onResize={(delta) => handleResize(idx, delta)}
              />
            )}
          </React.Fragment>
        ))}
      </div>

      {/* 无分屏时的空状态 */}
      {(!tabs.length || !activeTabId) && panes.length <= 1 && (
        <div style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--text-secondary)',
          fontSize: 14,
        }}>
          请从左侧选择一个串口打开标签页
        </div>
      )}
    </div>
  );
};

export default MainDisplay;
