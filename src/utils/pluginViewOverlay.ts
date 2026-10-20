import { suppressPluginViews } from './pluginViewRuntime';
import type { PluginViewportRect } from '../types/pluginViews';

type OverlayRect = PluginViewportRect;
const cutouts = new Map<object, OverlayRect>();

const overlaySelector = '.modal-overlay, .context-menu:not([data-plugin-view-cutout]), .notify-panel, .tab-drag-overlay, .toast';
let activeGuards = 0;
let overlayCount = 0;
let dragActive = false;
let sequence = 0;
let observedLayout = '';
let suppressionPending: Promise<void> = Promise.resolve();

function update(): Promise<void> {
  const blocked = activeGuards > 0 || overlayCount > 0 || dragActive || document.hidden || cutouts.size > 64;
  const occlusions = cutouts.size <= 64 ? [...cutouts.values()] : [];
  const layout = JSON.stringify([blocked, occlusions]);
  if (layout === observedLayout) return suppressionPending;
  observedLayout = layout;
  suppressionPending = suppressPluginViews(blocked, occlusions).catch((error) => {
    // Do not cache a rejected handshake for an unchanged layout: host modals
    // would stay hidden forever after a transient native destroy failure.
    if (observedLayout === layout) observedLayout = '';
    throw error;
  });
  return suppressionPending;
}

function updateObservedOverlay(): void {
  void update().catch(error => console.error('[pluginView] overlay suppression', error));
}

/** Await either a full hide or a native input/paint cutout before showing host UI. */
export function acquirePluginViewOverlay(rect?: OverlayRect): {
  ready: Promise<void>; updateRect: (rect: OverlayRect) => Promise<void>; release: () => void;
} {
  const key = {};
  if (rect) cutouts.set(key, rect); else activeGuards++;
  const ready = update();
  let released = false;
  return {
    ready,
    updateRect: next => {
      if (released || !rect) return suppressionPending;
      cutouts.set(key, next);
      return update();
    },
    release: () => {
      if (released) return;
      released = true;
      if (rect) cutouts.delete(key); else activeGuards--;
      updateObservedOverlay();
    },
  };
}

/** Catch host-local overlays and pointer drags; explicit overlay components use the handshake above. */
export function startPluginViewOverlayGuard(): () => void {
  const refresh = () => {
    overlayCount = document.querySelectorAll(overlaySelector).length;
    updateObservedOverlay();
  };
  const observer = new MutationObserver(refresh);
  observer.observe(document.body, { childList: true, subtree: true });
  const down = (event: PointerEvent) => {
    if (event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('.pane-resize-handle, .operation-panel-resize-handle, .sidebar-resize-handle, .tab-item')) {
      dragActive = true; updateObservedOverlay();
    }
  };
  const up = () => { dragActive = false; updateObservedOverlay(); };
  const visibility = () => { updateObservedOverlay(); };
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
    if (sequence === lifetime) { overlayCount = 0; dragActive = false; observedLayout = ''; }
  };
}
