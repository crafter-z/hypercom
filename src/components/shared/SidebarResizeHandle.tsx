import React, { useEffect, useState } from 'react';
import { useAppStore } from '../../stores/useAppStore';

/**
 * Vertical drag handle between the sidebar and the main content column.
 * Clamps the sidebar width to [200, 400] px while dragging.
 * Styles live in `styles/sidebar.css` (`.sidebar-resize-handle`).
 */
const SidebarResizeHandle: React.FC = () => {
  const setUIState = useAppStore((s) => s.setUIState);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) return;
    const handleMouseMove = (e: MouseEvent) => {
      const newWidth = Math.max(200, Math.min(400, e.clientX));
      setUIState({ sidebarWidth: newWidth });
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
      className={`sidebar-resize-handle${dragging ? ' dragging' : ''}`}
      onMouseDown={(e) => { e.preventDefault(); setDragging(true); }}
    />
  );
};

export default SidebarResizeHandle;
