import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const suppress = vi.hoisted(() => vi.fn());
vi.mock('./pluginViewRuntime', () => ({ suppressPluginViews: suppress }));

// Each case intentionally reloads the singleton to isolate suppression/guard state;
// a static import would keep the previous case's rejected pending promise.

let refresh: () => void;
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
    constructor(callback: () => void) { refresh = callback; }
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

  it('logs observer and visibility suppression failures without unhandled promises', async () => {
    const error = new Error('native hide failed');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { startPluginViewOverlayGuard } = await import('./pluginViewOverlay');
    const stop = startPluginViewOverlayGuard();
    try {
      suppress.mockRejectedValue(error);
      hidden = true; refresh(); await settle();
      expect(logged).toHaveBeenCalledWith('[pluginView] overlay suppression', error);
      logged.mockClear();
      listeners.get('visibilitychange')!(); await settle();
      expect(logged).toHaveBeenCalledWith('[pluginView] overlay suppression', error);
    } finally { stop(); }
  });
});
