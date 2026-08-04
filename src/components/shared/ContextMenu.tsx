import React, { useEffect, useRef, useState, useCallback } from 'react';

export interface ContextMenuItem {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Toggle-state affordance — rendered with the active (accent) treatment. */
  active?: boolean;
}

export interface ContextMenuSeparator {
  type: 'separator';
}

export type ContextMenuEntry = ContextMenuItem | ContextMenuSeparator;

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuEntry[];
  onClose: () => void;
}

const ContextMenu: React.FC<ContextMenuProps> = ({ x, y, items, onClose }) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let nx = x;
    let ny = y;
    if (rect.width + x > vw - 8) nx = vw - rect.width - 8;
    if (rect.height + y > vh - 8) ny = vh - rect.height - 8;
    if (nx < 0) nx = 0;
    if (ny < 0) ny = 0;
    if (nx !== x || ny !== y) setPos({ x: nx, y: ny });
  }, [x, y]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', keyHandler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', keyHandler);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className="context-menu animate-fade-in"
      style={{ left: pos.x, top: pos.y }}
    >
      {items.map((item, idx) => {
        if ('type' in item && item.type === 'separator') {
          return <div key={`sep-${idx}`} className="context-menu-separator" />;
        }
        const menuItem = item as ContextMenuItem;
        return (
          <div
            key={`item-${idx}`}
            className={`context-menu-item${menuItem.danger ? ' danger' : ''}${menuItem.disabled ? ' disabled' : ''}${menuItem.active ? ' active' : ''}`}
            onClick={() => {
              if (!menuItem.disabled) {
                menuItem.onClick();
                onClose();
              }
            }}
          >
            {menuItem.icon && <span className="context-menu-icon">{menuItem.icon}</span>}
            <span>{menuItem.label}</span>
          </div>
        );
      })}
    </div>
  );
};

export default ContextMenu;

export function useContextMenu() {
  const [state, setState] = useState<{ x: number; y: number; items: ContextMenuEntry[] } | null>(null);
  const show = useCallback((e: React.MouseEvent, items: ContextMenuEntry[]) => {
    e.preventDefault();
    e.stopPropagation();
    setState({ x: e.clientX, y: e.clientY, items });
  }, []);
  const hide = useCallback(() => setState(null), []);
  const element = state ? (
    <ContextMenu x={state.x} y={state.y} items={state.items} onClose={hide} />
  ) : null;
  return { show, element };
}