import React, { useCallback, useRef, useState } from 'react';
import { useAppStore, countLeaves } from '../../stores/useAppStore';
import type { PaneNode, BranchPane, SplitDirection } from '../../types';
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

/** 方向映射：分支 direction → flex 容器 flexDirection */
function flexDirectionFor(direction: SplitDirection): 'row' | 'column' {
  // 与历史行为一致：'horizontal' 元素在视觉上垂直堆叠（column），
  // 'vertical' 元素水平并排（row）。
  return direction === 'horizontal' ? 'column' : 'row';
}

/**
 * 分隔条方向与分屏方向一致：'vertical' 分屏（左右并排）用竖向分隔条
 * （width:5, col-resize, 拖 X）；'horizontal' 分屏（上下堆叠）用横向
 * 分隔条（height:5, row-resize, 拖 Y）。此前返回相反方向，导致并排
 * 分屏时分隔条渲染成 100% 宽的横条，整个显示区溢出错乱。
 */
function resizeHandleDirection(direction: SplitDirection): 'horizontal' | 'vertical' {
  return direction;
}

const MainDisplay: React.FC = () => {
  const paneTree = useAppStore((s) => s.paneTree);
  const tabs = useAppStore((s) => s.tabs);
  const focusedPaneId = useAppStore((s) => s.focusedPaneId);
  const setFocusedPane = useAppStore((s) => s.setFocusedPane);
  const moveTabToPane = useAppStore((s) => s.moveTabToPane);
  const reorderPaneTabIds = useAppStore((s) => s.reorderPaneTabIds);
  const resizeChildren = useAppStore((s) => s.resizeChildren);

  const containerRef = useRef<HTMLDivElement>(null);
  const [dragTabId, setDragTabId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const leafCount = countLeaves(paneTree);
  const isMultiPane = leafCount > 1;

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setDragTabId(String(event.active.id));
  }, []);

  const dragEndHandler = useTabDragEnd({ moveTabToPane, reorderPaneTabIds });
  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setDragTabId(null);
    dragEndHandler(event);
  }, [dragEndHandler]);

  const dragTab = dragTabId ? tabs.find(t => t.id === dragTabId) : null;

  /** 渲染单个树节点。当节点位于某分支内时，flexBasis 由 size 决定。 */
  const renderNode = useCallback((
    node: PaneNode,
    parentBranch: BranchPane | null,
  ): React.ReactNode => {
    // flex-basis: 当节点处于分支内时按 size 比例展开；根节点 flex:1。
    // flex-shrink 取 1（而非 0）：兄弟节点之间还有 5px 分隔条，百分比
    // 之和加上分隔条会略超 100%，允许收缩才能刚好填满而不溢出裁切。
    const flexBasis = parentBranch
      ? `0 1 ${(node.size * 100).toFixed(2)}%`
      : '1';

    if (node.type === 'leaf') {
      return (
        <div
          key={node.id}
          className="pane-node"
          style={{ flex: flexBasis }}
        >
          <Pane
            paneId={node.id}
            tabIds={node.tabIds}
            size={node.size}
            isFocused={node.id === focusedPaneId}
            isMultiPane={isMultiPane}
            onFocus={() => setFocusedPane(node.id)}
          />
        </div>
      );
    }

    // Branch — render children recursively with ResizeHandle between siblings
    const branch = node;
    const children = branch.children;
    return (
      <div
        key={branch.id}
        className={`pane-branch pane-branch-${flexDirectionFor(branch.direction)}`}
        style={{ flex: flexBasis }}
      >
        {children.map((child, idx) => {
          const siblings = children;
          const handleResize = (deltaPx: number) => {
            // 将像素增量转为相对于该分支子节点总尺寸的分数
            // 使用 containerRef 的当前尺寸估算分支可见尺寸
            const container = containerRef.current;
            if (!container) return;
            const rect = container.getBoundingClientRect();
            // 分支可见尺寸 = 整个 MainDisplay 容器在分支 flex 方向上的尺寸
            const branchVisible =
              branch.direction === 'vertical'
                ? rect.width    // row 布局 → 横向尺寸
                : rect.height;  // column 布局 → 纵向尺寸
            // branchVisible 是根容器的尺寸；子节点 size 之和应≈1
            // deltaFraction = deltaPx / branchVisible * parentSizeFraction
            // 父分支自身 size 占比（根为1）
            const parentFraction = parentBranch ? parentBranch.size : 1;
            const deltaFraction = (deltaPx / branchVisible) * parentFraction;
            if (deltaFraction !== 0) {
              resizeChildren(branch.id, idx, deltaFraction);
            }
          };
          return (
            <React.Fragment key={child.id}>
              {renderNode(child, branch)}
              {idx < siblings.length - 1 && (
                <ResizeHandle
                  direction={resizeHandleDirection(branch.direction)}
                  onResize={handleResize}
                />
              )}
            </React.Fragment>
          );
        })}
      </div>
    );
  }, [focusedPaneId, isMultiPane, setFocusedPane, resizeChildren]);

  const panesLayout = (
    <div ref={containerRef} className="panes-layout">
      {renderNode(paneTree, null)}
    </div>
  );

  return (
    <div className="main-display">
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
    </div>
  );
};

export default MainDisplay;