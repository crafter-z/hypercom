// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetStoresForTests } from '../../stores/resetStores';
import { useSystemStore } from '../../stores/useSystemStore';
import OperationPanelResizeHandle from './OperationPanelResizeHandle';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  resetStoresForTests();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(createElement(OperationPanelResizeHandle)));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function dragTo(startY: number, endY: number) {
  const handle = container.querySelector<HTMLDivElement>('.operation-panel-resize-handle')!;
  act(() => {
    handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, buttons: 1, clientY: startY }));
  });
  act(() => {
    window.dispatchEvent(new MouseEvent('mousemove', { buttons: 1, clientY: endY }));
  });
  act(() => {
    window.dispatchEvent(new MouseEvent('mouseup', { buttons: 0, clientY: endY }));
  });
}

describe('operation panel resize handle', () => {
  it('grows upward, clamps to the maximum, and un-collapses the panel', () => {
    useSystemStore.getState().setUIState({ operationPanelHeight: 280, isOperationPanelCollapsed: true });
    dragTo(400, -500);
    expect(useSystemStore.getState().ui.operationPanelHeight).toBe(600);
    expect(useSystemStore.getState().ui.isOperationPanelCollapsed).toBe(false);
    expect(container.querySelector('.operation-panel-resize-handle')?.classList.contains('dragging')).toBe(false);
  });

  it('shrinks downward but never below the minimum height', () => {
    useSystemStore.getState().setUIState({ operationPanelHeight: 280, isOperationPanelCollapsed: false });
    dragTo(100, 500);
    expect(useSystemStore.getState().ui.operationPanelHeight).toBe(160);
  });
});

export {};
