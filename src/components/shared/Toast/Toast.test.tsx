// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Toast from './Toast';
import { useToastStore, type ToastPushInput } from '../../../stores/useToastStore';
import { useSystemStore } from '../../../stores/useSystemStore';
import { resetStoresForTests } from '../../../stores/resetStores';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

function pushToast(overrides: Partial<ToastPushInput> = {}): string {
  return useToastStore.getState().push({
    severity: 'info',
    message: 'notification',
    ...overrides,
  });
}

function renderToast(id: string): HTMLElement {
  const toast = useToastStore.getState().toasts.find((item) => item.id === id);
  if (!toast) throw new Error('toast was not pushed');
  act(() => root.render(createElement(Toast, { toast })));
  const element = container.querySelector<HTMLElement>('.toast');
  if (!element) throw new Error('toast did not render');
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
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe('Toast host action (linked plugin updates)', () => {
  it('opens Settings → Plugins and dismisses the toast when clicked', () => {
    const id = pushToast({ message: 'plugin updates', title: 'Plugins', action: 'open-plugin-settings', durationMs: 0 });
    const element = renderToast(id);
    expect(element.getAttribute('role')).toBe('button');
    expect(element.tabIndex).toBe(0);

    act(() => element.click());

    expect(ui().isConfigOpen).toBe(true);
    expect(ui().configActiveTab).toBe('plugins');
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it.each(['Enter', ' '])('opens Settings → Plugins with the %s key', (key) => {
    const id = pushToast({ message: 'plugin updates', action: 'open-plugin-settings', durationMs: 0 });
    const element = renderToast(id);
    press(element, key);

    expect(ui().isConfigOpen).toBe(true);
    expect(ui().configActiveTab).toBe('plugins');
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('dismisses through the close button without triggering the action', () => {
    const id = pushToast({ message: 'plugin updates', action: 'open-plugin-settings', durationMs: 0 });
    renderToast(id);
    const close = container.querySelector<HTMLButtonElement>('.toast-close');
    expect(close).not.toBeNull();

    act(() => close!.click());

    expect(useToastStore.getState().toasts).toHaveLength(0);
    expect(ui().isConfigOpen).toBe(false);
  });

  it.each(['Enter', ' '])('keyboard activation of the close button only dismisses (%s)', (key) => {
    const id = pushToast({ message: 'plugin updates', action: 'open-plugin-settings', durationMs: 0 });
    renderToast(id);
    const close = container.querySelector<HTMLButtonElement>('.toast-close');
    expect(close).not.toBeNull();

    act(() => {
      close!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      close!.click();
    });

    expect(useToastStore.getState().toasts).toHaveLength(0);
    expect(ui().isConfigOpen).toBe(false);
  });

  it('keeps ordinary toasts non-actionable', () => {
    const id = pushToast({ message: 'plain', durationMs: 4000 });
    const element = renderToast(id);
    expect(element.getAttribute('role')).toBe('alert');
    expect(element.tabIndex).toBe(-1);

    act(() => element.click());

    expect(ui().isConfigOpen).toBe(false);
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });
});
