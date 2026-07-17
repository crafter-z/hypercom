import React, { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore, countLeaves } from '../../stores/useAppStore';
import type { PaneNode, BranchPane, SplitDirection } from '../../types';
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

/** 方向映射：分支 direction → flex 容器 flexDirection */
function flexDirectionFor(direction: SplitDirection): 'row' | 'column' {
  // 与历史行为一致：'horizontal' 元素在视觉上垂直堆叠（column），
  // 'vertical' 元素水平并排（row）。
  return direction === 'horizontal' ? 'column' : 'row';
}

/** ResizeHandle 的 direction 与 flex 方向相反 */
function resizeHandleDirection(direction: SplitDirection): 'horizontal' | 'vertical' {
  return direction === 'horizontal' ? 'vertical' : 'horizontal';
}

const MainDisplay: React.FC = () => {
  const paneTree = useAppStore((s) => s.paneTree);
  const tabs = useAppStore((s) => s.tabs);
  const focusedPaneId = useAppStore((s) => s.focusedPaneId);
  const setFocusedPane = useAppStore((s) => s.setFocusedPane);
  const splitPane = useAppStore((s) => s.splitPane);
  const moveTabToPane = useAppStore((s) => s.moveTabToPane);
  const reorderPaneTabIds = useAppStore((s) => s.reorderPaneTabIds);
  const resizeChildren = useAppStore((s) => s.resizeChildren);
  const { t } = useTranslation();

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
    // flex-basis: 当节点处于分支内时按 size 比例展开；根节点 flex:1
    const flexBasis = parentBranch
      ? `0 0 ${(node.size * 100).toFixed(2)}%`
      : '1';

    if (node.type === 'leaf') {
      return (
        <div
          key={node.id}
          style={{
            flex: flexBasis,
            display: 'flex',
            overflow: 'hidden',
            minWidth: 0,
            minHeight: 0,
          }}
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
        style={{
          flex: flexBasis,
          display: 'flex',
          flexDirection: flexDirectionFor(branch.direction),
          overflow: 'hidden',
          minWidth: 0,
          minHeight: 0,
        }}
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
    <div ref={containerRef} style={{
      flex: 1, display: 'flex', overflow: 'hidden', minWidth: 0, minHeight: 0,
    }}>
      {renderNode(paneTree, null)}
    </div>
  );

  return (
    <div className="main-display">
      <div className="main-display-toolbar">
        <button className="btn btn-icon btn-sm" title={t('mainDisplay.toolbar.splitVertical')} onClick={() => splitPane('vertical')}>
          <Columns2 size={14} />
        </button>
        <button className="btn btn-icon btn-sm" title={t('mainDisplay.toolbar.splitHorizontal')} onClick={() => splitPane('horizontal')}>
          <Rows2 size={14} />
        </button>
        {leafCount > 1 && (
          <span className="main-display-info">{t('mainDisplay.toolbar.paneCount', { count: leafCount })}</span>
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
    </div>
  );
};

export default MainDisplay;