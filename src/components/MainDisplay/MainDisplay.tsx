import React, { useCallback, useRef, useState, useEffect } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import TabBar from './TabBar';
import TerminalView from './TerminalView';
import {
  Columns2, Rows2
} from 'lucide-react';

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

  useEffect(() => {
    if (localActiveTabId && !tabIds.includes(localActiveTabId)) {
      setLocalActiveTabId(tabIds[0] || null);
    }
  }, [tabIds, localActiveTabId]);

  return (
    <div
      className={`pane-container-inner${isFocused ? ' pane-focused' : ''}`}
      onClick={onFocus}
    >
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

      {displayTab && (
        <div className="terminal-toolbar">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="status-dot connected" />
            <span className="terminal-toolbar-title">{displayTab.title}</span>
            <span className="terminal-toolbar-info">(115200, 8N1)</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span className="terminal-toolbar-label">编码:</span>
            <select className="select terminal-toolbar-select">
              <option>ASCII</option>
              <option>UTF-8</option>
              <option>GBK</option>
            </select>
          </div>
        </div>
      )}

      <div style={{ flex: 1, overflow: 'hidden' }}>
        {paneTabs.length > 0 && displayTab ? (
          <TerminalView
            portId={displayTab.id}
            terminal={terminals[displayTab.id]}
          />
        ) : paneTabs.length === 0 ? (
          <div className="terminal-empty-state">
            双击左侧串口打开标签页
          </div>
        ) : null}
      </div>
    </div>
  );
};

interface ResizeHandleProps {
  onResize: (delta: number) => void;
  direction: 'horizontal' | 'vertical';
}

const ResizeHandle: React.FC<ResizeHandleProps> = ({ onResize, direction }) => {
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
      className={`pane-resize-handle${dragging ? ' dragging' : ''}`}
      style={{
        width: isH ? 5 : '100%',
        height: isH ? '100%' : 5,
        cursor: isH ? 'col-resize' : 'row-resize',
      }}
      onMouseDown={(e) => { e.preventDefault(); setDragging(true); }}
    />
  );
};

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
    <div className="main-display">
      <div className="main-display-toolbar">
        <button className="btn btn-icon btn-sm" title="左右分屏" onClick={() => splitPane('vertical')}>
          <Columns2 size={14} />
        </button>
        <button className="btn btn-icon btn-sm" title="上下分屏" onClick={() => splitPane('horizontal')}>
          <Rows2 size={14} />
        </button>
        {panes.length > 1 && (
          <span className="main-display-info">{panes.length} 个分屏</span>
        )}
      </div>

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

      {(!tabs.length || !activeTabId) && panes.length <= 1 && (
        <div className="terminal-empty-state" style={{ flex: 1 }}>
          请从左侧选择一个串口打开标签页
        </div>
      )}
    </div>
  );
};

export default MainDisplay;