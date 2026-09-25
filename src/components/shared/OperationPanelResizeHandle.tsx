import React from 'react';
import { useSystemStore } from '../../stores/useSystemStore';
import { useDragResize } from './useDragResize';

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
  const setUIState = useSystemStore((s) => s.setUIState);
  // Height at drag start — the hook reports pointer deltas, the clamped
  // absolute height is this component's geometry, not a shared concern.
  const startHeightRef = React.useRef(0);

  const { dragging, onMouseDown } = useDragResize({
    axis: 'y',
    mode: 'delta',
    invert: true,
    onDragStart: () => {
      startHeightRef.current = useSystemStore.getState().ui.operationPanelHeight;
    },
    onChange: (delta) => {
      const next = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, startHeightRef.current + delta));
      setUIState({ operationPanelHeight: next, isOperationPanelCollapsed: false });
    },
  });

  return (
    <div
      className={`operation-panel-resize-handle${dragging ? ' dragging' : ''}`}
      onMouseDown={onMouseDown}
    />
  );
};

export default OperationPanelResizeHandle;
