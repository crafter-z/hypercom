import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { acquirePluginViewOverlay } from '../../utils/pluginViewOverlay';

/** Menus cut only their own rectangle out of native children; modals hide them. */
export function usePluginViewOverlay(open = true, overlayRef?: RefObject<HTMLElement | null>): boolean {
  const [ready, setReady] = useState(false);
  const refreshRef = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    if (!open) { setReady(false); return; }
    let alive = true;
    let revision = 0;
    let lastRect = '';
    const element = overlayRef?.current;
    const measure = () => {
      const rect = element!.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    // Cutout callers mount an invisible, measurable panel before this effect.
    const guard = acquirePluginViewOverlay(element ? measure() : undefined);
    const wait = (pending: Promise<void>) => {
      const current = ++revision;
      setReady(false);
      void pending.then(() => { if (alive && current === revision) setReady(true); })
        .catch(error => console.error('[pluginView] overlay suppression', error));
    };
    wait(guard.ready);
    const refresh = () => {
      if (!element) return;
      const rect = measure();
      const key = JSON.stringify(rect);
      if (key === lastRect) return;
      lastRect = key;
      wait(guard.updateRect(rect));
    };
    refreshRef.current = refresh;
    const observer = element ? new ResizeObserver(refresh) : null;
    if (element) observer!.observe(element);
    window.addEventListener('resize', refresh);
    window.addEventListener('scroll', refresh, true);
    return () => {
      alive = false;
      refreshRef.current = null;
      observer?.disconnect();
      window.removeEventListener('resize', refresh);
      window.removeEventListener('scroll', refresh, true);
      guard.release();
    };
  }, [open, overlayRef]);
  // Placement can change without a resize (e.g. clamping a menu to an edge).
  useLayoutEffect(() => { refreshRef.current?.(); });
  return open && ready;
}
