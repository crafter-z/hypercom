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

describe('NotificationCenter rows, Escape lifecycle, and unread badge', () => {
  it('renders sibling buttons without nested interactive ARIA and opens Settings → Plugins', () => {
    pushToast({ message: '2 plugin updates', action: 'open-plugin-settings', durationMs: 0 });
    renderCenter();
    const item = row();
    const mainBtn = item.querySelector<HTMLButtonElement>('button.notify-row-main');
    const dismissBtn = item.querySelector<HTMLButtonElement>('button.notify-row-dismiss');
    expect(mainBtn).not.toBeNull();
    expect(dismissBtn).not.toBeNull();
    // Ensure sibling structure — dismiss button is NOT nested inside the action button.
    expect(mainBtn!.contains(dismissBtn!)).toBe(false);
    expect(mainBtn!.getAttribute('title')).toBeTruthy();

    act(() => mainBtn!.click());

    expect(ui().isConfigOpen).toBe(true);
    expect(ui().configActiveTab).toBe('plugins');
    expect(useToastStore.getState().centerOpen).toBe(false);
  });

  it('keeps ordinary notifications non-actionable with only a dismiss button', () => {
    pushToast({ message: 'plain', durationMs: 4000 });
    renderCenter();
    const item = row();
    expect(item.querySelector('button.notify-row-main')).toBeNull();
    const mainDiv = item.querySelector<HTMLDivElement>('div.notify-row-main');
    expect(mainDiv).not.toBeNull();

    act(() => mainDiv!.click());

    expect(ui().isConfigOpen).toBe(false);
    expect(useToastStore.getState().centerOpen).toBe(true);
  });

  it('closes ConfirmDialog on Escape without closing the underlying NotificationCenter', () => {
    pushToast({ message: 'clear me', durationMs: 4000 });
    renderCenter();
    const clearBtn = container.querySelector<HTMLButtonElement>('.notify-clear-all');
    expect(clearBtn).not.toBeNull();
    act(() => clearBtn!.click());
    expect(document.querySelector('[aria-modal="true"]')).not.toBeNull();

    press(document.body, 'Escape');

    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
    expect(useToastStore.getState().centerOpen).toBe(true);
  });

  it('tracks unread count with neutral vs urgent styling and marks read on open', () => {
    useToastStore.setState({ centerOpen: false });
    renderCenter();
    expect(container.querySelector('.notify-badge')).toBeNull();

    act(() => { pushToast({ severity: 'info', message: 'hello' }); });
    const neutralBadge = container.querySelector('.notify-badge');
    expect(neutralBadge?.textContent).toBe('1');
    expect(neutralBadge?.classList.contains('is-urgent')).toBe(false);

    act(() => { pushToast({ severity: 'error', message: 'boom' }); });
    const urgentBadge = container.querySelector('.notify-badge');
    expect(urgentBadge?.textContent).toBe('2');
    expect(urgentBadge?.classList.contains('is-urgent')).toBe(true);

    // Opening NotificationCenter marks existing items read.
    act(() => { container.querySelector<HTMLButtonElement>('.notify-btn')!.click(); });
    expect(container.querySelector('.notify-badge')).toBeNull();

    // Closing keeps them read until a new notification arrives.
    act(() => { container.querySelector<HTMLButtonElement>('.notify-btn')!.click(); });
    expect(container.querySelector('.notify-badge')).toBeNull();

    act(() => { pushToast({ severity: 'warning', message: 'warn' }); });
    const nextBadge = container.querySelector('.notify-badge');
    expect(nextBadge?.textContent).toBe('1');
    expect(nextBadge?.classList.contains('is-urgent')).toBe(true);
  });
});
