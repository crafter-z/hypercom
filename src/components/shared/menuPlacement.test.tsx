// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useMenuPlacement } from './menuPlacement';

let root: Root, host: HTMLDivElement, width = 200, height = 100, resize: (() => void) | undefined;
function Menu({ x, y }: { x: number; y: number }) {
  const { ref, pos } = useMenuPlacement(x, y);
  return <div ref={ref} data-x={pos.x} data-y={pos.y} />;
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { resize = () => callback([], this as unknown as ResizeObserver); }
    observe() {} disconnect() {}
  });
  width = 200; height = 100;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON: () => ({}) }));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('follows a changed anchor even when the new position still fits the viewport', async () => {
  await act(async () => root.render(<Menu x={100} y={100} />));
  await act(async () => root.render(<Menu x={200} y={150} />));
  expect(host.firstElementChild?.getAttribute('data-x')).toBe('200');
  expect(host.firstElementChild?.getAttribute('data-y')).toBe('150');
});
it('re-clamps a growing secondary panel without allowing it beyond the viewport', async () => {
  await act(async () => root.render(<Menu x={window.innerWidth} y={window.innerHeight} />));
  width = 350; height = 250;
  await act(async () => resize?.());
  expect(Number(host.firstElementChild?.getAttribute('data-x'))).toBe(window.innerWidth - 350 - 8);
  expect(Number(host.firstElementChild?.getAttribute('data-y'))).toBe(window.innerHeight - 250 - 8);
});
