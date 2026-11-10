// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginViewState, PluginViewFailureCode } from '../../types/pluginViews';
import type { TabItem } from '../../types';

// React needs this flag for `act()` outside its own test renderer.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The surface's whole job for a rejected page is to explain it and stop offering a
// retry that cannot succeed — so drive it with explicit runtime state and assert on
// the rendered affordances.
let viewState: PluginViewState;
const retryPluginView = vi.fn();
const selectSerialPluginView = vi.fn();
const preference = { pluginId: 'com.example.views', installGeneration: 'gen-1', viewId: 'table' };

// `useSyncExternalStore` compares snapshots by identity: these must be stable.
const NO_PLUGIN_VIEWS: never[] = [];
const NO_CHOICES: never[] = [];
vi.mock('../../utils/pluginViewRuntime', async () => {
  const actual = await vi.importActual<typeof import('../../utils/pluginViewRuntime')>('../../utils/pluginViewRuntime');
  return {
    ...actual,
    getPluginViewState: () => viewState,
    subscribePluginViewState: () => () => {},
    getTabViewPreference: () => preference,
    getAvailablePluginViews: () => NO_CHOICES,
    placePluginView: () => {},
    retryPluginView: (...args: unknown[]) => retryPluginView(...args),
    selectSerialPluginView: (...args: unknown[]) => selectSerialPluginView(...args),
  };
});
vi.mock('../../utils/pluginConfigSnapshot', () => ({
  subscribePluginViews: () => () => {},
  getPluginViews: () => NO_PLUGIN_VIEWS,
}));
vi.mock('../../utils/tabContentPlacement', () => ({
  setTabContentPlacement: () => {},
  removeTabContentPlacement: () => {},
  subscribeTabContentPlacement: () => () => {},
  getTabContentPlacements: () => ({}),
}));
vi.mock('./TimelineControls', () => ({ TimelineButton: () => null }));

const { default: PluginViewSurface } = await import('./PluginViewSurface');
const { default: i18n } = await import('../../i18n');
/** The app initializes i18n transitively, so compare against real translations. */
const label = (key: string): string => i18n.t(key);
const { useSystemStore } = await import('../../stores/useSystemStore');
const { resetStoresForTests } = await import('../../stores/resetStores');

const tab: TabItem = {
  kind: 'plugin', id: 'tab-1', title: 'Table', splitPaneId: 'main', isPinned: false,
  pluginId: 'com.example.views', installGeneration: 'gen-1', viewId: 'table',
  boundPortId: null, instanceKey: 'default', restoreOnStartup: true,
};

let container: HTMLDivElement;
let root: Root;
function stateWith(code: PluginViewFailureCode | null): PluginViewState {
  return { status: code ? 'unavailable' : 'loading', error: code ? `failure: ${code}` : null, instanceId: null, code };
}
async function render(): Promise<void> {
  await act(async () => {
    root.render(createElement(PluginViewSurface, { tab, hidden: false }));
  });
}
function buttonLabels(): string[] {
  // Icons render as leading spaces in textContent; compare on trimmed labels.
  return [...container.querySelectorAll('button')].map(button => (button.textContent ?? '').trim());
}

beforeEach(() => {
  resetStoresForTests();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  retryPluginView.mockClear(); selectSerialPluginView.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('plugin view failure surface', () => {
  it('explains a structural rejection and offers the settings page instead of a dead retry', async () => {
    viewState = stateWith('install-changed');
    await render();
    const labels = buttonLabels();
    expect(labels).toContain(label('pluginViews.openSettings'));
    expect(labels).not.toContain(label('pluginViews.retry'));
    expect(container.textContent).toContain(label('pluginViews.failure.install-changed'));
    expect(container.textContent).toContain(label('pluginViews.failureHint'));
  });

  it('opens the plugin settings page from the rejection panel', async () => {
    viewState = stateWith('grant-missing');
    await render();
    const settings = [...container.querySelectorAll('button')]
      .find(button => button.textContent?.includes(label('pluginViews.openSettings')))!;
    await act(async () => { settings.click(); });
    expect(useSystemStore.getState().ui.isConfigOpen).toBe(true);
    expect(useSystemStore.getState().ui.configActiveTab).toBe('plugins');
  });

  it('keeps the retry for a transient failure', async () => {
    viewState = stateWith('init-timeout');
    await render();
    const retry = [...container.querySelectorAll('button')]
      .find(button => button.textContent?.includes(label('pluginViews.retry')))!;
    expect(retry).toBeTruthy();
    await act(async () => { retry.click(); });
    expect(retryPluginView).toHaveBeenCalledWith('tab-1');
  });

  it('shows no failure panel while the page is merely loading', async () => {
    viewState = stateWith(null);
    await render();
    expect(buttonLabels()).not.toContain(label('pluginViews.openSettings'));
    expect(container.textContent).toContain(label('pluginViews.loading'));
  });

  it('keeps the reason and the settings entry when a serial tab falls back to the raw terminal', async () => {
    viewState = stateWith('view-missing');
    const serial: TabItem = { kind: 'serial', id: 'tab-1', portId: 'COM3', title: 'COM3', splitPaneId: 'main', isPinned: false };
    await act(async () => { root.render(createElement(PluginViewSurface, { tab: serial, hidden: false })); });
    // The raw terminal took over, but the user must still learn why.
    expect(container.querySelector('.plugin-view-toolbar')).not.toBeNull();
    expect(container.textContent).toContain(label('pluginViews.failure.view-missing'));
    expect(buttonLabels()).toContain(label('pluginViews.openSettings'));
    expect(buttonLabels()).not.toContain(label('pluginViews.retry'));
  });

  it('never offers a retry for any structural code and always offers one for transient codes', async () => {
    const structural: PluginViewFailureCode[] = [
      'plugin-missing', 'plugin-disabled', 'install-changed', 'view-missing', 'grant-missing',
      'trusted-web', 'port-binding', 'port-unavailable', 'port-mode',
    ];
    for (const code of structural) {
      viewState = stateWith(code);
      await render();
      expect([code, buttonLabels().includes(label('pluginViews.retry'))]).toEqual([code, false]);
      expect([code, buttonLabels().includes(label('pluginViews.openSettings'))]).toEqual([code, true]);
    }
    const transient: PluginViewFailureCode[] = ['worker-unavailable', 'worker-stopped', 'init-timeout', 'capacity', 'runtime'];
    for (const code of transient) {
      viewState = stateWith(code);
      await render();
      expect([code, buttonLabels().includes(label('pluginViews.retry'))]).toEqual([code, true]);
    }
  });
});
