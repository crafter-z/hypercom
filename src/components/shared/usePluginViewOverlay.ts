import { useLayoutEffect, useState } from 'react';
import { acquirePluginViewOverlay } from '../../utils/pluginViewOverlay';

/** A native child is hidden before a DOM overlay paints above its content area. */
export function usePluginViewOverlay(open = true): boolean {
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    if (!open) { setReady(false); return; }
    let alive = true;
    const guard = acquirePluginViewOverlay();
    void guard.ready.then(() => { if (alive) setReady(true); }).catch(error => console.error('[pluginView] overlay suppression', error));
    return () => { alive = false; guard.release(); };
  }, [open]);
  return open && ready;
}
