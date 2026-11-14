// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginView } from '../../../types';
import Modal from '../../shared/Modal';

// React needs this flag for `act()` outside its own test renderer.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const plugin: PluginView = {
  id: 'com.example.slow', installGeneration: 'gen-1', enabled: true, dir: '',
  grantedPermissions: ['ui:view'], declaredPermissions: ['ui:view'], knownPermissions: ['ui:view'],
  manifestError: null, installedAt: null,
  manifest: {
    id: 'com.example.slow', name: 'Slow plugin', version: '1.0.0', description: 'demo', apiVersion: '1.0',
    entry: 'main.js', permissions: ['ui:view'], ui: { buttons: [], menuItems: [], views: [] },
  },
};
const uninstallPlugin = vi.fn();

vi.mock('../../../hooks/usePlugins', () => ({
  usePluginList: () => ({
    plugins: [plugin], loading: false, refresh: vi.fn(),
    installPlugin: vi.fn(), reloadPlugin: vi.fn(), grantAllAndEnable: vi.fn(),
    uninstallPlugin: (...args: unknown[]) => uninstallPlugin(...args),
    setEnabled: vi.fn(), togglePermission: vi.fn(), setTrustedWeb: vi.fn(), clearWebData: vi.fn(),
  }),
  isPluginReplaceConfirmationError: () => false,
  replacementTargetId: () => undefined,
}));

const { default: PluginSettings } = await import('./PluginSettings');
const { default: i18n } = await import('../../../i18n');
const { resetStoresForTests } = await import('../../../stores/resetStores');
const label = (key: string, options?: Record<string, unknown>): string => i18n.t(key, options);

let container: HTMLDivElement;
let root: Root;
let frames: FrameRequestCallback[];

function overlay(): Element | null { return container.querySelector('.plugin-uninstall-overlay'); }
function uninstallButton(): HTMLButtonElement {
  return [...container.querySelectorAll('button')]
    .find(button => (button.textContent ?? '').includes(label('plugins.uninstall')))!;
}
/** The panel must be committed before the command so the window never looks dead. */
async function flushPaint(): Promise<void> {
  await act(async () => { frames.splice(0).forEach(callback => callback(0)); });
}

beforeEach(() => {
  resetStoresForTests();
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('confirm', () => true);
  uninstallPlugin.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('plugin uninstall progress', () => {
  it('keeps focus and Escape in the non-cancellable progress overlay, not the parent settings dialog', async () => {
    const parentClose = vi.fn();
    let finish!: () => void;
    uninstallPlugin.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    await act(async () => root.render(createElement(Modal, { open: true, label: 'settings', onClose: parentClose, children: createElement(PluginSettings) })));
    await act(async () => uninstallButton().click());
    expect(document.activeElement).toBe(overlay());
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    await act(async () => overlay()!.dispatchEvent(escape));
    expect(escape.defaultPrevented).toBe(true);
    expect(parentClose).not.toHaveBeenCalled();
    await flushPaint(); await flushPaint();
    await act(async () => finish());
  });
  it('paints the progress panel before the uninstall command starts', async () => {
    let finish!: () => void;
    uninstallPlugin.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    await act(async () => { root.render(createElement(PluginSettings)); });

    await act(async () => { uninstallButton().click(); });

    // Shown, yet the (UI-thread-blocking) command has not been sent: the user
    // learns why the window is busy before it can stop responding.
    expect(overlay()).not.toBeNull();
    expect(container.textContent).toContain(label('plugins.uninstalling', { name: 'Slow plugin' }));
    expect(uninstallPlugin).not.toHaveBeenCalled();

    await flushPaint(); // outer rAF
    expect(uninstallPlugin).not.toHaveBeenCalled();
    await flushPaint(); // inner rAF: commit + paint done
    expect(uninstallPlugin).toHaveBeenCalledWith(plugin.id);

    await act(async () => { finish(); });
    expect(overlay()).toBeNull();
  });

  it('keeps the panel up and reports elapsed time while uninstall is still running', async () => {
    let finish!: () => void;
    uninstallPlugin.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    await act(async () => { root.render(createElement(PluginSettings)); });

    vi.useFakeTimers({ now: new Date('2060-01-01T00:00:00Z') });
    try {
      await act(async () => { uninstallButton().click(); });
      await flushPaint(); await flushPaint();
      await act(async () => { vi.advanceTimersByTime(3000); });
      expect(overlay()).not.toBeNull();
      expect(container.textContent).toContain(label('plugins.uninstallElapsed', { seconds: 3 }));
    } finally {
      vi.useRealTimers();
    }
    await act(async () => { finish(); });
  });
});
