// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NotificationCenter from './NotificationCenter';
import { useToastStore, type ToastPushInput } from '../../stores/useToastStore';
import { useSystemStore } from '../../stores/useSystemStore';
import { resetStoresForTests } from '../../stores/resetStores';

// Native plugin-view overlay suppression is irrelevant to this popover test.
vi.mock('../shared/usePluginViewOverlay', () => ({ usePluginViewOverlay: () => true }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

function pushToast(overrides: Partial<ToastPushInput> = {}): string {
  return useToastStore.getState().push({ severity: 'info', message: 'notification', ...overrides });
}

function renderCenter(): void {
  act(() => root.render(createElement(NotificationCenter)));
}

function row(): HTMLElement {
  const element = container.querySelector<HTMLElement>('.notify-row');
  if (!element) throw new Error('notification row did not render');
  return element;
}

function press(element: HTMLElement, key: string): void {
  act(() => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

const ui = () => useSystemStore.getState().ui;

beforeEach(() => {
  resetStoresForTests();
  useToastStore.setState({ centerOpen: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe('NotificationCenter rows', () => {
  it('opens Settings → Plugins from a linked plugin-update notification and closes the center', () => {
    pushToast({ message: '2 plugin updates', action: 'open-plugin-settings', durationMs: 0 });
    renderCenter();
    const item = row();
    expect(item.getAttribute('role')).toBe('button');
    expect(item.getAttribute('title')).toBeTruthy();

    act(() => item.click());

    expect(ui().isConfigOpen).toBe(true);
    expect(ui().configActiveTab).toBe('plugins');
    expect(useToastStore.getState().centerOpen).toBe(false);
  });

  it.each(['Enter', ' '])('activates the plugin-update row with %s', (key) => {
    pushToast({ message: '2 plugin updates', action: 'open-plugin-settings', durationMs: 0 });
    renderCenter();
    press(row(), key);

    expect(ui().isConfigOpen).toBe(true);
    expect(ui().configActiveTab).toBe('plugins');
  });

  it('keeps ordinary notifications non-actionable', () => {
    pushToast({ message: 'plain', durationMs: 4000 });
    renderCenter();
    const item = row();
    expect(item.getAttribute('role')).toBe('group');
    expect(item.tabIndex).toBe(-1);

    act(() => item.click());

    expect(ui().isConfigOpen).toBe(false);
    expect(useToastStore.getState().centerOpen).toBe(true);
  });
});
