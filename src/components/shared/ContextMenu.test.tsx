// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startPluginViewOverlayGuard } from '../../utils/pluginViewOverlay';
import { useContextMenu, type ContextMenuEntry } from './ContextMenu';

const suppress = vi.hoisted(() => vi.fn<(blocked: boolean, rects: unknown[]) => Promise<void>>());
vi.mock('../../utils/pluginViewRuntime', () => ({ suppressPluginViews: suppress }));

const rootRect = { x: 20, y: 30, width: 180, height: 100 };
const submenuRect = { x: 200, y: 60, width: 180, height: 80 };
const item = { label: 'Open', onClick: () => {} };
let host: HTMLDivElement;
let root: Root;
let stop: () => void;

function Harness({ items }: { items: ContextMenuEntry[] }) {
  const { show, element } = useContextMenu();
  return <>
    <button type="button" className="tab-item" onContextMenu={event => show(event, items)}>COM1</button>
    {element}
  </>;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return DOMRect.fromRect(this.classList.contains('context-submenu') ? submenuRect : rootRect);
  });
  suppress.mockReset().mockResolvedValue(undefined);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  stop = startPluginViewOverlayGuard();
});

afterEach(async () => {
  await act(async () => root.unmount());
  stop();
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function rightClick(items: ContextMenuEntry[]) {
  await act(async () => root.render(<Harness items={items} />));
  const trigger = host.querySelector('button')!;
  const options = { bubbles: true, cancelable: true, button: 2, clientX: rootRect.x, clientY: rootRect.y };
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('pointerdown', options));
    trigger.dispatchEvent(new MouseEvent('contextmenu', options));
  });
}

async function press(target: EventTarget, key: string) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

describe('context menu over native plugin views', () => {
  it('cuts out only the right-click menu and removes that cutout on Escape', async () => {
    await rightClick([item]);
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(menu.style.visibility).toBe('visible');
    expect(suppress).toHaveBeenLastCalledWith(false, [rootRect]);
    expect(suppress.mock.calls.every(([blocked]) => !blocked)).toBe(true);

    await press(menu.querySelector('[role="menuitem"]')!, 'Escape');
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(suppress).toHaveBeenLastCalledWith(false, []);
  });

  it('waits for the submenu cutout and releases it without removing the parent cutout', async () => {
    await rightClick([{ label: 'More', onClick: () => {}, submenu: [item] }]);
    const parentItem = document.querySelector<HTMLElement>('[aria-haspopup="menu"]')!;
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    suppress.mockImplementation((_blocked, rects) => rects.length === 2 ? pending : Promise.resolve());

    await press(parentItem, 'ArrowRight');
    const submenu = document.querySelector<HTMLElement>('.context-submenu')!;
    expect(suppress).toHaveBeenLastCalledWith(false, [rootRect, submenuRect]);
    expect(submenu.style.visibility).toBe('hidden');
    expect(document.activeElement).toBe(parentItem);

    await act(async () => finish());
    expect(submenu.style.visibility).toBe('visible');
    const childItem = submenu.querySelector('[role="menuitem"]')!;
    expect(document.activeElement).toBe(childItem);

    await press(childItem, 'ArrowLeft');
    expect(document.querySelector('.context-submenu')).toBeNull();
    expect(document.activeElement).toBe(parentItem);
    expect(suppress).toHaveBeenLastCalledWith(false, [rootRect]);
    expect(suppress.mock.calls.every(([blocked]) => !blocked)).toBe(true);
  });
});
