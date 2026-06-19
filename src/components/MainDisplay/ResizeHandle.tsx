import React, { useState, useEffect } from 'react';

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

export default ResizeHandle;
