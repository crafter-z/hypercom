import React, { useCallback, useState } from 'react';
import { useMenuPlacement } from './menuPlacement';
import { useOutsideDismiss } from './useOutsideDismiss';

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
  const { ref, pos } = useMenuPlacement(x, y);
  useOutsideDismiss(ref, onClose);

  return (
    <div
      ref={ref}
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