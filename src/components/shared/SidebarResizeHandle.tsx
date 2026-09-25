import React from 'react';
import { useSystemStore } from '../../stores/useSystemStore';
import { useDragResize } from './useDragResize';

const MIN_WIDTH = 200;
const MAX_WIDTH = 400;

/**
 * Vertical drag handle between the sidebar and the main content column.
 * Clamps the sidebar width to [200, 400] px while dragging. Styles live in
 * `styles/sidebar.css` (`.sidebar-resize-handle`).
 */
const SidebarResizeHandle: React.FC = () => {
  const setUIState = useSystemStore((s) => s.setUIState);

  // The sidebar is docked at x=0, so the pointer's clientX *is* the width.
  const { dragging, onMouseDown } = useDragResize({
    axis: 'x',
    min: MIN_WIDTH,
    max: MAX_WIDTH,
    onChange: (width) => setUIState({ sidebarWidth: width }),
  });

  return (
    <div
      className={`sidebar-resize-handle${dragging ? ' dragging' : ''}`}
      onMouseDown={onMouseDown}
    />
  );
};

export default SidebarResizeHandle;
