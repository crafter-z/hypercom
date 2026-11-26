// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import SidebarResizeHandle from './SidebarResizeHandle';
import { useSystemStore } from '../../stores/useSystemStore';
import { resetStoresForTests } from '../../stores/resetStores';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  resetStoresForTests();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('SidebarResizeHandle keyboard & ARIA semantics', () => {
  it('exposes separator ARIA attributes and resizes via Arrow / Shift+Arrow / double-click', () => {
    act(() => root.render(createElement(SidebarResizeHandle)));
    const handle = container.querySelector<HTMLElement>('[role="separator"]');
    expect(handle).not.toBeNull();
    expect(handle!.tabIndex).toBe(0);
    expect(handle!.getAttribute('aria-orientation')).toBe('vertical');
    expect(handle!.getAttribute('aria-valuenow')).toBe('260');
    expect(handle!.getAttribute('aria-valuemin')).toBe('200');
    expect(handle!.getAttribute('aria-valuemax')).toBe('400');

    act(() => {
      handle!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    });
    expect(useSystemStore.getState().ui.sidebarWidth).toBe(268);

    act(() => {
      handle!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true, bubbles: true, cancelable: true }));
    });
    expect(useSystemStore.getState().ui.sidebarWidth).toBe(228);

    act(() => {
      handle!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(useSystemStore.getState().ui.sidebarWidth).toBe(260);
  });
});
