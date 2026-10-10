import { suppressPluginViews } from './pluginViewRuntime';

const overlaySelector = '.modal-overlay, .context-menu, .notify-panel, .tab-drag-overlay, .toast';
let activeGuards = 0;
let overlayCount = 0;
let dragActive = false;
let sequence = 0;
let observedBlocked = false;
let suppressionPending: Promise<void> = Promise.resolve();

function update(): Promise<void> {
  const blocked = activeGuards > 0 || overlayCount > 0 || dragActive || document.hidden;
  if (blocked === observedBlocked) return suppressionPending;
  observedBlocked = blocked;
  suppressionPending = suppressPluginViews(blocked);
  return suppressionPending;
}

/** Hide native children before allowing an overlay component to become visible. */
export function acquirePluginViewOverlay(): { ready: Promise<void>; release: () => void } {
  activeGuards++;
  const ready = update();
  let released = false;
  return { ready, release: () => { if (released) return; released = true; activeGuards--; void update(); } };
}

/** Catch host-local overlays and pointer drags; explicit overlay components use the handshake above. */
export function startPluginViewOverlayGuard(): () => void {
  const refresh = () => {
    overlayCount = document.querySelectorAll(overlaySelector).length;
    void update();
  };
  const observer = new MutationObserver(refresh);
  observer.observe(document.body, { childList: true, subtree: true });
  const down = (event: PointerEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('.pane-resize-handle, .operation-panel-resize-handle, .sidebar-resize-handle, .tab-item')) {
      dragActive = true; void update();
    }
  };
  const up = () => { dragActive = false; void update(); };
  const visibility = () => { void update(); };
  document.addEventListener('pointerdown', down, true);
  document.addEventListener('pointerup', up, true);
  document.addEventListener('pointercancel', up, true);
  document.addEventListener('visibilitychange', visibility);
  refresh();
  const lifetime = ++sequence;
  return () => {
    observer.disconnect(); document.removeEventListener('pointerdown', down, true);
    document.removeEventListener('pointerup', up, true); document.removeEventListener('pointercancel', up, true);
    document.removeEventListener('visibilitychange', visibility);
    if (sequence === lifetime) { overlayCount = 0; dragActive = false; observedBlocked = false; }
  };
}
