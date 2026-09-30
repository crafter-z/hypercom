import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';

export interface DragResizeOptions {
  /** Pointer axis that drives the drag. */
  axis: 'x' | 'y';
  /**
   * `'absolute'` reports the clamped pointer coordinate (a left-docked panel's
   * width); `'delta'` reports the signed movement since the drag started (a
   * split separator, where the parent owns the geometry). Default `'absolute'`.
   */
  mode?: 'absolute' | 'delta';
  /** Clamp range for `'absolute'` mode. */
  min?: number;
  max?: number;
  /** `'delta'` mode: flip the sign — dragging up (dy < 0) grows a bottom-docked panel. */
  invert?: boolean;
  onChange: (value: number) => void;
  onDragStart?: () => void;
}

function clampTo(value: number, min?: number, max?: number): number {
  if (min !== undefined && value < min) return min;
  if (max !== undefined && value > max) return max;
  return value;
}

/**
 * Mouse-drag resize behaviour shared by every resize handle in the app.
 *
 * Three handles previously hand-rolled the same press → window mousemove →
 * window mouseup lifecycle with two different value semantics (pixel clamp vs
 * raw delta) and two different start-point conventions. Keeping them here means
 * the listeners are attached once per drag, always torn down, and the consumer
 * only decides what to do with the reported value.
 *
 * The options object is read through a ref so the window listeners are
 * subscribed once per drag instead of being re-bound on every parent render.
 */
export function useDragResize(options: DragResizeOptions): {
  dragging: boolean;
  onMouseDown: (e: ReactMouseEvent) => void;
} {
  const [dragging, setDragging] = useState(false);
  const startRef = useRef(0);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (!dragging) return;
    const axis = optionsRef.current.axis;

    const handleMouseMove = (e: MouseEvent) => {
      const o = optionsRef.current;
      if ((o.mode ?? 'absolute') === 'delta') {
        const delta = (axis === 'x' ? e.clientX : e.clientY) - startRef.current;
        o.onChange(o.invert ? -delta : delta);
        return;
      }
      o.onChange(clampTo(axis === 'x' ? e.clientX : e.clientY, o.min, o.max));
    };
    const handleMouseUp = () => setDragging(false);

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragging]);

  const onMouseDown = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    const o = optionsRef.current;
    startRef.current = o.axis === 'x' ? e.clientX : e.clientY;
    setDragging(true);
    o.onDragStart?.();
  }, []);

  return { dragging, onMouseDown };
}
