// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TabBar from './TabBar';
import { useAppStore } from '../../stores/useAppStore';
import { resetStoresForTests } from '../../stores/resetStores';
import { lostPortIds } from '../../hooks/disconnectTracking';
import type { LeafPane, SerialPort, TabItem } from '../../types';

vi.mock('react-i18next', async importOriginal => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => opts?.target ? `${key}:${opts.target}` : key }),
}));
vi.mock('../shared/usePluginViewOverlay', () => ({ usePluginViewOverlay: () => true }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const makePort = (id: string, status: SerialPort['status']): SerialPort => ({
  id, name: id, status, type: 'real', isHidden: false,
});

const makeTab = (id: string, portId: string, overrides?: Partial<TabItem>): TabItem => ({
  kind: 'serial',
  id,
  portId,
  title: portId,
  isPinned: false,
  splitPaneId: 'pane1',
  ...overrides,
} as TabItem);

beforeEach(() => {
  resetStoresForTests();
  lostPortIds.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  lostPortIds.clear();
  container.remove();
  vi.clearAllMocks();
});

describe('TabBar status signals and ergonomics', () => {
  it('binds status dots to actual port.status and reserves warning icon for lost or error ports', () => {
    const t1 = makeTab('t1', 'COM1');
    const t2 = makeTab('t2', 'COM2');
    const t3 = makeTab('t3', 'COM3');
    const t4 = makeTab('t4', 'COM4');
    lostPortIds.add('COM3');
    useAppStore.setState({
      ports: [
        makePort('COM1', 'connected'),
        makePort('COM2', 'disconnected'),
        makePort('COM3', 'disconnected'),
        makePort('COM4', 'error'),
      ],
      tabs: [t1, t2, t3, t4],
      activeTabId: 't2',
      paneTree: { id: 'pane1', type: 'leaf', tabIds: ['t1', 't2', 't3', 't4'], size: 1 },
    });

    act(() => root.render(createElement(TabBar, {
      tabs: [t1, t2, t3, t4],
      activeTabId: 't2',
      onTabClick: vi.fn(),
      onTabClose: vi.fn(),
      onTabPin: vi.fn(),
      onCloseToRight: vi.fn(),
      onCloseToLeft: vi.fn(),
      onCloseOthers: vi.fn(),
    })));

    const tabEl = (id: string) => container.querySelector<HTMLElement>(`[data-tab-id="${id}"]`)!;
    expect(tabEl('t1').querySelector('.tab-status-dot')?.classList.contains('status-connected')).toBe(true);
    expect(tabEl('t1').querySelector('.tab-warning-icon')).toBeNull();

    // Normally disconnected tab gets gray dot and NO warning icon.
    expect(tabEl('t2').querySelector('.tab-status-dot')?.classList.contains('status-disconnected')).toBe(true);
    expect(tabEl('t2').querySelector('.tab-warning-icon')).toBeNull();

    // Unexpectedly lost port gets warning icon with tooltip.
    expect(tabEl('t3').querySelector('.tab-warning-icon')?.getAttribute('title')).toBe('tabBar.portLostWarning');

    // Error port gets error dot and warning icon with tooltip.
    expect(tabEl('t4').querySelector('.tab-status-dot')?.classList.contains('status-error')).toBe(true);
    expect(tabEl('t4').querySelector('.tab-warning-icon')?.getAttribute('title')).toBe('tabBar.portErrorWarning');
  });

  it('closes unpinned tabs on middle-click and Cmd/Ctrl+W, and shows human-readable Move-to-Pane labels', () => {
    const onTabClose = vi.fn();
    const t1 = makeTab('t1', 'COM1', { isPinned: true });
    const t2 = makeTab('t2', 'COM2');
    const t3 = makeTab('t3', 'COM4', { splitPaneId: 'pane-abcd1234' });
    const pane1: LeafPane = { id: 'pane1', type: 'leaf', tabIds: ['t1', 't2'], size: 0.5 };
    const pane2: LeafPane = { id: 'pane-abcd1234', type: 'leaf', tabIds: ['t3'], size: 0.5 };

    useAppStore.setState({
      ports: [makePort('COM1', 'connected'), makePort('COM2', 'disconnected'), makePort('COM4', 'connected')],
      tabs: [t1, t2, t3],
      activeTabId: 't2',
      paneTree: { id: 'root', type: 'branch', direction: 'vertical', children: [pane1, pane2], size: 1 },
    });

    act(() => root.render(createElement(TabBar, {
      tabs: [t1, t2],
      activeTabId: 't2',
      isMultiPane: true,
      moveToPaneTargets: [pane2],
      onTabClick: vi.fn(),
      onTabClose,
      onTabPin: vi.fn(),
      onCloseToRight: vi.fn(),
      onCloseToLeft: vi.fn(),
      onCloseOthers: vi.fn(),
      onMoveToPane: vi.fn(),
      onSplitVertical: vi.fn(),
      onSplitHorizontal: vi.fn(),
      onClosePane: vi.fn(),
    })));

    const pinnedEl = container.querySelector<HTMLElement>('[data-tab-id="t1"]')!;
    const regularEl = container.querySelector<HTMLElement>('[data-tab-id="t2"]')!;

    // Middle-click on pinned tab does not close.
    act(() => { pinnedEl.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true })); });
    expect(onTabClose).not.toHaveBeenCalled();

    // Middle-click on unpinned tab closes it.
    act(() => { regularEl.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true })); });
    expect(onTabClose).toHaveBeenCalledWith('t2');

    // Meta+W (macOS Cmd+W) closes focused unpinned tab.
    act(() => { regularEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', metaKey: true, bubbles: true, cancelable: true })); });
    expect(onTabClose).toHaveBeenCalledTimes(2);

    // Context menu shows human-readable pane label ("2 — COM4") and disables Close on pinned tab.
    act(() => { pinnedEl.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
    const menuItems = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const closeItem = menuItems.find(el => el.textContent?.trim() === 'tabBar.contextMenu.close');
    expect(closeItem?.getAttribute('aria-disabled')).toBe('true');
    const closeLeftItem = menuItems.find(el => el.textContent?.trim() === 'tabBar.contextMenu.closeToLeft');
    expect(closeLeftItem?.getAttribute('aria-disabled')).toBe('true');
    const moveItem = menuItems.find(el => el.textContent?.includes('tabBar.contextMenu.moveToPane:2 — COM4'));
    expect(moveItem).toBeDefined();
  });
});
