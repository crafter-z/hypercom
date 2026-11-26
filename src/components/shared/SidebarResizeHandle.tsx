import React from 'react';
import { useTranslation } from 'react-i18next';
import { useSystemStore } from '../../stores/useSystemStore';
import { useDragResize } from './useDragResize';

const MIN_WIDTH = 200;
const MAX_WIDTH = 400;
const DEFAULT_WIDTH = 260;

/**
 * Vertical drag handle between the sidebar and the main content column.
 * Clamps the sidebar width to [200, 400] px while dragging or keyboard-resizing.
 * Styles live in `styles/sidebar.css` (`.sidebar-resize-handle`).
 */
const SidebarResizeHandle: React.FC = () => {
  const { t } = useTranslation();
  const sidebarWidth = useSystemStore((s) => s.ui.sidebarWidth);
  const setUIState = useSystemStore((s) => s.setUIState);

  // The sidebar is docked at x=0, so the pointer's clientX *is* the width.
  const { dragging, onMouseDown } = useDragResize({
    axis: 'x',
    min: MIN_WIDTH,
    max: MAX_WIDTH,
    onChange: (width) => setUIState({ sidebarWidth: width }),
  });

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const step = event.shiftKey ? 40 : 8;
    const delta = event.key === 'ArrowRight' ? step : -step;
    const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, sidebarWidth + delta));
    if (next !== sidebarWidth) {
      setUIState({ sidebarWidth: next });
    }
  };

  return (
    <div
      className={`sidebar-resize-handle${dragging ? ' dragging' : ''}`}
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={t('workspace.resizeSidebar')}
      aria-valuenow={sidebarWidth}
      aria-valuemin={MIN_WIDTH}
      aria-valuemax={MAX_WIDTH}
      onMouseDown={onMouseDown}
      onKeyDown={handleKeyDown}
      onDoubleClick={() => setUIState({ sidebarWidth: DEFAULT_WIDTH })}
    />
  );
};

export default SidebarResizeHandle;
