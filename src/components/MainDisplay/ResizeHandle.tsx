import React, { useRef } from 'react';
import { useDragResize } from '../shared/useDragResize';

interface ResizeHandleProps {
  /** Called with the px movement of ONE mousemove event (the store's
   *  `resizeChildren` applies each delta relative to the current sizes). */
  onResize: (delta: number) => void;
  /** Split direction: 'vertical' = siblings side by side → vertical handle. */
  direction: 'horizontal' | 'vertical';
}

const ResizeHandle: React.FC<ResizeHandleProps> = ({ onResize, direction }) => {
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

  return (
    <div
      className={`pane-resize-handle${dragging ? ' dragging' : ''}`}
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
