import React, { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../stores/useAppStore';

const MIN_HEIGHT = 160;
const MAX_HEIGHT = 600;

/**
 * Horizontal drag handle between the main display and the operation panel.
 * Dragging up grows the panel; dragging down shrinks it. The height is clamped
 * to [MIN_HEIGHT, MAX_HEIGHT] px and written to `ui.operationPanelHeight`.
 * Starting a drag also un-collapses the panel. Styles live in
 * `styles/operation-panel.css` (`.operation-panel-resize-handle`).
 */
const OperationPanelResizeHandle: React.FC = () => {
  const setUIState = useAppStore((s) => s.setUIState);
  const [dragging, setDragging] = useState(false);
  const start = useRef({ y: 0, height: 0 });

  useEffect(() => {
    if (!dragging) return;
    const handleMouseMove = (e: MouseEvent) => {
      // Dragging up (clientY decreases) must grow the panel => positive delta.
      const delta = start.current.y - e.clientY;
      const next = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, start.current.height + delta));
      setUIState({ operationPanelHeight: next, isOperationPanelCollapsed: false });
    };
    const handleMouseUp = () => setDragging(false);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragging, setUIState]);

  return (
    <div
      className={`operation-panel-resize-handle${dragging ? ' dragging' : ''}`}
      onMouseDown={(e) => {
        e.preventDefault();
        start.current = {
          y: e.clientY,
          height: useAppStore.getState().ui.operationPanelHeight,
        };
        setDragging(true);
      }}
    />
  );
};

export default OperationPanelResizeHandle;
