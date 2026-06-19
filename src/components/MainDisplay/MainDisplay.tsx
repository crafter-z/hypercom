import React, { useCallback, useRef, useState, useEffect } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { Columns2, Rows2 } from 'lucide-react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  DragOverlay,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import Pane from './Pane';
import ResizeHandle from './ResizeHandle';
import { useTabDragEnd } from './hooks/useTabDragEnd';

const MainDisplay: React.FC = () => {
  const panes = useAppStore((s) => s.panes);
  const tabs = useAppStore((s) => s.tabs);
  const focusedPaneId = useAppStore((s) => s.focusedPaneId);
  const setFocusedPane = useAppStore((s) => s.setFocusedPane);
  const splitPane = useAppStore((s) => s.splitPane);
  const moveTabToPane = useAppStore((s) => s.moveTabToPane);
  const reorderPaneTabIds = useAppStore((s) => s.reorderPaneTabIds);

  const [paneSizes, setPaneSizes] = useState<number[]>(() =>
    panes.map(p => p.size * 100)
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragTabId, setDragTabId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

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

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setDragTabId(String(event.active.id));
  }, []);

  const dragEndHandler = useTabDragEnd({ moveTabToPane, reorderPaneTabIds });
  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setDragTabId(null);
    dragEndHandler(event);
  }, [dragEndHandler]);

  const dragTab = dragTabId ? tabs.find(t => t.id === dragTabId) : null;

  const panesLayout = (
    <div ref={containerRef} style={{
      flex: 1, display: 'flex',
      flexDirection: panes[0]?.direction === 'horizontal' ? 'column' : 'row',
      overflow: 'hidden'
    }}>
      {panes.map((pane, idx) => {
        const isRow = panes[0]?.direction !== 'horizontal';
        return (
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
              isMultiPane={panes.length > 1}
              onFocus={() => setFocusedPane(pane.id)}
            />
          </div>
          {idx < panes.length - 1 && (
            <ResizeHandle
              direction={isRow ? 'vertical' : 'horizontal'}
              onResize={(delta) => handleResize(idx, delta)}
            />
          )}
        </React.Fragment>
      )})}
    </div>
  );

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

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        {panesLayout}
        <DragOverlay dropAnimation={null}>
          {dragTab ? (
            <div className="tab-drag-overlay">
              <span className="tab-drag-overlay-title">{dragTab.title}</span>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {panes.length <= 1 && !tabs.length && (
        <div className="terminal-empty-state" style={{ flex: 1 }}>
          请从左侧选择一个串口打开标签页
        </div>
      )}
    </div>
  );
};

export default MainDisplay;
