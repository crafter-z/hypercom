import React, { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useDragResize } from '../shared/useDragResize';

interface ResizeHandleProps {
  /** Called with the px movement of ONE mousemove event (the store's
   *  `resizeChildren` applies each delta relative to the current sizes). */
  onResize: (delta: number) => void;
  /** Optional reset handler invoked on double-click (e.g. restore 50/50 split). */
  onReset?: () => void;
  /** Split direction: 'vertical' = siblings side by side → vertical handle. */
  direction: 'horizontal' | 'vertical';
  /** Leading pane's share of the two adjacent panes, derived from paneTree. */
  value: number;
}

const ResizeHandle: React.FC<ResizeHandleProps> = ({ onResize, onReset, direction, value }) => {
  const { t } = useTranslation();
  const isVertical = direction === 'vertical';
  // useDragResize('delta') reports the offset since the drag STARTED, while the
  // store action re-applies every delta to the live sizes — so re-diff here to
  // keep the per-event contract of `onResize`.
  const reportedRef = useRef(0);
  const { dragging, onMouseDown } = useDragResize({
    axis: isVertical ? 'x' : 'y',
    mode: 'delta',
    onChange: (cumulative) => {
      onResize(cumulative - reportedRef.current);
      reportedRef.current = cumulative;
    },
    onDragStart: () => {
      reportedRef.current = 0;
    },
  });

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const forward = isVertical ? event.key === 'ArrowRight' : event.key === 'ArrowDown';
    const backward = isVertical ? event.key === 'ArrowLeft' : event.key === 'ArrowUp';
    if (!forward && !backward) return;
    event.preventDefault();
    // Shift+Arrow uses a coarse 40px step; plain Arrow nudges by 8px.
    const step = event.shiftKey ? 40 : 8;
    onResize((forward ? 1 : -1) * step);
  };

  return (
    <div
      className={`pane-resize-handle${dragging ? ' dragging' : ''}`}
      role="separator"
      tabIndex={0}
      aria-orientation={isVertical ? 'vertical' : 'horizontal'}
      aria-label={t(isVertical ? 'workspace.resizeHorizontal' : 'workspace.resizeVertical')}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
      title={onReset ? t('workspace.doubleClickResetSplit') : undefined}
      onKeyDown={handleKeyDown}
      onDoubleClick={onReset}
      style={{
        width: isVertical ? 5 : '100%',
        height: isVertical ? '100%' : 5,
        cursor: isVertical ? 'col-resize' : 'row-resize',
      }}
      onMouseDown={onMouseDown}
    />
  );
};

export default ResizeHandle;
