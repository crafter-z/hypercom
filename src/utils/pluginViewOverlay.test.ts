import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const suppress = vi.hoisted(() => vi.fn());
vi.mock('./pluginViewRuntime', () => ({ suppressPluginViews: suppress }));

// Each case intentionally reloads the singleton to isolate suppression/guard state;
// a static import would keep the previous case's rejected pending promise.

let listeners: Map<string, () => void>;
let hidden: boolean;

beforeEach(() => {
  vi.resetModules();
  suppress.mockReset().mockResolvedValue(undefined);
  hidden = false;
  listeners = new Map();
  vi.stubGlobal('document', {
    get hidden() { return hidden; },
    body: {},
    querySelectorAll: () => [],
    addEventListener: (type: string, callback: () => void) => { listeners.set(type, callback); },
    removeEventListener: (type: string) => { listeners.delete(type); },
  });
  vi.stubGlobal('MutationObserver', class {
    constructor(_callback: () => void) {}
    observe() {}
    disconnect() {}
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function settle() { for (let index = 0; index < 5; index++) await Promise.resolve(); }

describe('overlay suppression rejection consumers', () => {
  it('preserves rejection of explicit readiness while logging the internal release failure', async () => {
    const error = new Error('native destroy failed');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    suppress.mockRejectedValue(error);
    const { acquirePluginViewOverlay } = await import('./pluginViewOverlay');
    const guard = acquirePluginViewOverlay();
    await expect(guard.ready).rejects.toBe(error);
    expect(logged).not.toHaveBeenCalled();
    guard.release(); await settle();
    expect(logged).toHaveBeenCalledWith('[pluginView] overlay suppression', error);
  });

  it('does not suppress native views for a context-menu pointer press', async () => {
    const { startPluginViewOverlayGuard } = await import('./pluginViewOverlay');
    const stop = startPluginViewOverlayGuard();
    try {
      const pointerdown = listeners.get('pointerdown')! as (event: PointerEvent) => void;
      pointerdown({ button: 2, target: { closest: () => ({}) } } as unknown as PointerEvent);
      await settle();
      expect(suppress).not.toHaveBeenCalledWith(true);
    } finally { stop(); }
  });

  it('keeps live menu cutouts across nested modal and menu lifetimes', async () => {
    const { acquirePluginViewOverlay } = await import('./pluginViewOverlay');
    const first = { x: 20, y: 30, width: 180, height: 240 };
    const second = { x: 320, y: 40, width: 260, height: 200 };
    const menu = acquirePluginViewOverlay(first);
    await menu.ready;
    expect(suppress).toHaveBeenLastCalledWith(false, [first]);
    const nested = acquirePluginViewOverlay(second);
    await nested.ready;
    const modal = acquirePluginViewOverlay();
    await modal.ready;
    expect(suppress).toHaveBeenLastCalledWith(true, [first, second]);
    menu.release();
    expect(suppress).toHaveBeenLastCalledWith(true, [second]);
    modal.release();
    expect(suppress).toHaveBeenLastCalledWith(false, [second]);
    const moved = { ...second, x: 280 };
    await nested.updateRect(moved);
    expect(suppress).toHaveBeenLastCalledWith(false, [moved]);
    nested.release();
    expect(suppress).toHaveBeenLastCalledWith(false, []);
  });
});
