import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMenuPlacement } from './menuPlacement';
import { useOutsideDismiss } from './useOutsideDismiss';
import { usePluginViewOverlay } from './usePluginViewOverlay';

export interface ContextMenuItem {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Toggle-state affordance — rendered with the active (accent) treatment. */
  active?: boolean;
  /** Nested entries; the item renders a submenu affordance instead of acting. */
  submenu?: ContextMenuEntry[];
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
  /** Element that owns focus while the menu is open; focus returns here on close. */
  trigger?: HTMLElement | null;
  /** Accessible name for the menu panel (role="menu"). */
  ariaLabel?: string;
}

const isSeparator = (entry: ContextMenuEntry): entry is ContextMenuSeparator =>
  'type' in entry && entry.type === 'separator';

const enabledIndices = (items: ContextMenuEntry[]): number[] =>
  items.reduce<number[]>((acc, entry, index) => {
    if (!isSeparator(entry) && !entry.disabled) acc.push(index);
    return acc;
  }, []);

const firstEnabledIndex = (items: ContextMenuEntry[]): number => {
  const index = items.findIndex(entry => !isSeparator(entry) && !entry.disabled);
  return index;
};

interface MenuListProps {
  items: ContextMenuEntry[];
  label: string;
  level: number;
  autoFocus: boolean;
  onActivate: (item: ContextMenuItem) => void;
  onCloseAll: () => void;
  /** Close just this submenu and return focus to its parent item. */
  onBack?: () => void;
  panelRef?: React.RefObject<HTMLDivElement | null>;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * One menu level. Rendered recursively for submenus: each level owns its own
 * roving active index and key handling, and stops propagation for keys it
 * consumes so the parent level never sees them.
 */
const MenuList: React.FC<MenuListProps> = ({
  items,
  label,
  level,
  autoFocus,
  onActivate,
  onCloseAll,
  onBack,
  panelRef,
  className,
  style,
}) => {
  const ownRef = useRef<HTMLDivElement>(null);
  const ref = panelRef ?? ownRef;
  const [activeIndex, setActiveIndex] = useState<number>(() => firstEnabledIndex(items));
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const enabled = enabledIndices(items);

  const focusIndex = useCallback((index: number) => {
    // Scope to this level: a nested submenu reuses the same index sequence.
    const el = ref.current?.querySelector<HTMLElement>(
      `[data-menu-depth="${level}"][data-menu-idx="${index}"]`,
    );
    if (!el) return;
    el.focus({ preventScroll: true });
    setActiveIndex(index);
  }, [ref, level]);

  useEffect(() => {
    if (autoFocus && activeIndex >= 0) focusIndex(activeIndex);
    // Focus only when this level first becomes interactive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocus]);

  const moveFocus = useCallback((current: number, direction: 1 | -1) => {
    if (enabled.length === 0) return;
    const pos = enabled.indexOf(current);
    const nextPos = pos === -1
      ? (direction === 1 ? 0 : enabled.length - 1)
      : (pos + direction + enabled.length) % enabled.length;
    focusIndex(enabled[nextPos]);
  }, [enabled, focusIndex]);

  const activate = useCallback((index: number) => {
    const entry = items[index];
    if (!entry || isSeparator(entry) || entry.disabled) return;
    if (entry.submenu && entry.submenu.length > 0) {
      setExpandedIndex(prev => (prev === index ? null : index));
      return;
    }
    onActivate(entry);
  }, [items, onActivate]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const itemEl = target.closest<HTMLElement>('[data-menu-idx]');
    if (!itemEl) return;
    // Ignore key events bubbling up from a nested (deeper) submenu level.
    if (itemEl.closest<HTMLElement>('[data-menu-list]') !== ref.current) return;
    const index = Number(itemEl.dataset.menuIdx);
    if (Number.isNaN(index)) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        e.stopPropagation();
        moveFocus(index, 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        e.stopPropagation();
        moveFocus(index, -1);
        break;
      case 'Home':
        e.preventDefault();
        e.stopPropagation();
        if (enabled.length > 0) focusIndex(enabled[0]);
        break;
      case 'End':
        e.preventDefault();
        e.stopPropagation();
        if (enabled.length > 0) focusIndex(enabled[enabled.length - 1]);
        break;
      case 'ArrowRight': {
        const entry = items[index];
        if (entry && !isSeparator(entry) && entry.submenu && entry.submenu.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          setExpandedIndex(index);
        }
        break;
      }
      case 'ArrowLeft':
        if (level > 0 && onBack) {
          e.preventDefault();
          e.stopPropagation();
          onBack();
        }
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        e.stopPropagation();
        activate(index);
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        onCloseAll();
        break;
      case 'Tab':
        // Menus trap nothing: Tab leaves and dismisses (focus returns to the trigger).
        e.preventDefault();
        onCloseAll();
        break;
      default:
        break;
    }
  }, [activate, enabled, focusIndex, items, level, moveFocus, onBack, onCloseAll, ref]);

  const levelLabel = `${label}${level > 0 ? ` (${level})` : ''}`;

  return (
    <div
      ref={ref as React.RefObject<HTMLDivElement>}
      data-menu-list
      className={className ?? `context-menu${level > 0 ? ' context-submenu' : ' animate-fade-in'}`}
      style={style}
      role="menu"
      aria-label={levelLabel}
      onKeyDown={handleKeyDown}
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((entry, idx) => {
        if (isSeparator(entry)) {
          return <div key={`sep-${idx}`} role="separator" className="context-menu-separator" />;
        }
        const hasSubmenu = !!entry.submenu && entry.submenu.length > 0;
        const expanded = hasSubmenu && expandedIndex === idx;
        return (
          <div
            key={`item-${idx}`}
            data-menu-idx={idx}
            data-menu-depth={level}
            role="menuitem"
            tabIndex={entry.disabled ? -1 : (activeIndex === idx ? 0 : -1)}
            aria-disabled={entry.disabled || undefined}
            aria-haspopup={hasSubmenu ? 'menu' : undefined}
            aria-expanded={hasSubmenu ? expanded : undefined}
            className={`context-menu-item${entry.danger ? ' danger' : ''}${entry.disabled ? ' disabled' : ''}${entry.active ? ' active' : ''}`}
            onMouseEnter={() => {
              if (!entry.disabled) setActiveIndex(idx);
            }}
            onClick={() => {
              if (entry.disabled) return;
              activate(idx);
            }}
          >
            {entry.icon && <span className="context-menu-icon">{entry.icon}</span>}
            <span>{entry.label}</span>
            {hasSubmenu && <span className="context-menu-submenu-arrow" aria-hidden="true">›</span>}
            {expanded && entry.submenu && (
              <MenuList
                items={entry.submenu}
                label={entry.label}
                level={level + 1}
                autoFocus
                onActivate={onActivate}
                onCloseAll={onCloseAll}
                onBack={() => {
                  setExpandedIndex(null);
                  focusIndex(idx);
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
};

const ContextMenu: React.FC<ContextMenuProps> = ({ x, y, items, onClose, trigger, ariaLabel = 'Context menu' }) => {
  const { ref, pos } = useMenuPlacement(x, y);
  const overlayGuardReady = usePluginViewOverlay(true, ref);
  useOutsideDismiss(ref, onClose);

  // Remember what was focused before the menu mounted so closing can restore
  // it. `trigger` wins when the caller knows the owning control. Computed once:
  // a later render may already have focus inside the menu.
  const [restoreTarget] = useState<HTMLElement | null>(() => {
    if (trigger) return trigger;
    if (typeof document === 'undefined') return null;
    const active = document.activeElement;
    return active instanceof HTMLElement && active !== document.body ? active : null;
  });

  // The placement ref is detached before passive cleanup runs on unmount, so
  // capture the panel node while it is still mounted.
  const panelElRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    panelElRef.current = ref.current;
  }, [ref]);

  useEffect(() => () => {
    const target = trigger ?? restoreTarget;
    if (!target || !document.contains(target)) return;
    const active = document.activeElement;
    const focusWasInMenu = !!panelElRef.current && !!active && panelElRef.current.contains(active);
    const focusLost = !active || active === document.body;
    if (focusWasInMenu || focusLost) target.focus({ preventScroll: true });
    // Restore once, on unmount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleActivate = useCallback((item: ContextMenuItem) => {
    item.onClick();
    onClose();
  }, [onClose]);

  return createPortal(
    <MenuList
      panelRef={ref}
      className="context-menu animate-fade-in"
      style={{ left: pos.x, top: pos.y, visibility: overlayGuardReady ? 'visible' : 'hidden' }}
      items={items}
      label={ariaLabel}
      level={0}
      autoFocus={overlayGuardReady}
      onActivate={handleActivate}
      onCloseAll={onClose}
    />,
    document.body,
  );
};

export default ContextMenu;

export interface ContextMenuController {
  /** Mouse/context-menu event entry point (legacy). */
  show: (e: React.MouseEvent, items: ContextMenuEntry[], ariaLabel?: string) => void;
  /** Programmatic entry point for keyboard invocation (e.g. Shift+F10). */
  showAt: (x: number, y: number, items: ContextMenuEntry[], trigger?: HTMLElement | null, ariaLabel?: string) => void;
  hide: () => void;
  element: React.ReactElement | null;
}

interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuEntry[];
  trigger: HTMLElement | null;
  ariaLabel?: string;
}

export function useContextMenu(): ContextMenuController {
  const [state, setState] = useState<ContextMenuState | null>(null);

  const show = useCallback((e: React.MouseEvent, items: ContextMenuEntry[], ariaLabel?: string) => {
    e.preventDefault();
    e.stopPropagation();
    const trigger = e.currentTarget instanceof HTMLElement ? e.currentTarget : null;
    setState({ x: e.clientX, y: e.clientY, items, trigger, ariaLabel });
  }, []);

  const showAt = useCallback((
    x: number,
    y: number,
    items: ContextMenuEntry[],
    trigger?: HTMLElement | null,
    ariaLabel?: string,
  ) => {
    setState({ x, y, items, trigger: trigger ?? null, ariaLabel });
  }, []);

  const hide = useCallback(() => setState(null), []);

  const element = state ? (
    <ContextMenu
      x={state.x}
      y={state.y}
      items={state.items}
      onClose={hide}
      trigger={state.trigger}
      ariaLabel={state.ariaLabel}
    />
  ) : null;

  return { show, showAt, hide, element };
}
