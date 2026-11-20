import { useEffect, useRef, useState } from 'react';

/** Keep a floating menu clear of the viewport edge so its border stays visible. */
const EDGE_MARGIN = 8;

interface MenuPosition {
  x: number;
  y: number;
}

/**
 * Viewport-clamped position for a floating menu anchored at (x, y).
 *
 * The size is only known after layout, so the first paint uses the raw anchor
 * and the effect corrects it — a menu opened near the right/bottom edge would
 * otherwise overflow the window. Shared by ContextMenu and
 * TextEditContextMenu, which carried byte-identical copies of this effect.
 */
export function useMenuPlacement(x: number, y: number, ready = true) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<MenuPosition>({ x, y });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      const nx = Math.max(0, Math.min(x, window.innerWidth - rect.width - EDGE_MARGIN));
      const ny = Math.max(0, Math.min(y, window.innerHeight - rect.height - EDGE_MARGIN));
      // The anchor may change even when it still fits. Do not retain the old
      // coordinates, and re-clamp when an options panel changes its own size.
      setPos(previous => previous.x === nx && previous.y === ny ? previous : { x: nx, y: ny });
    };
    update();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    observer?.observe(el);
    window.addEventListener('resize', update);
    return () => { observer?.disconnect(); window.removeEventListener('resize', update); };
  }, [x, y, ready]);

  return { ref, pos };
}
