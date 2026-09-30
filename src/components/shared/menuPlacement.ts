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
export function useMenuPlacement(x: number, y: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<MenuPosition>({ x, y });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let nx = x;
    let ny = y;
    if (rect.width + x > window.innerWidth - EDGE_MARGIN) {
      nx = window.innerWidth - rect.width - EDGE_MARGIN;
    }
    if (rect.height + y > window.innerHeight - EDGE_MARGIN) {
      ny = window.innerHeight - rect.height - EDGE_MARGIN;
    }
    if (nx < 0) nx = 0;
    if (ny < 0) ny = 0;
    if (nx !== x || ny !== y) setPos({ x: nx, y: ny });
  }, [x, y]);

  return { ref, pos };
}
