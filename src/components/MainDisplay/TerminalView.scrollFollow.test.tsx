// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TerminalView from './TerminalView';
import { TerminalViewportManager } from '../../utils/terminal/viewportManager';
import { timelineCoordinator } from '../../utils/timeline';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { resetStoresForTests } from '../../stores/resetStores';

vi.mock('react-i18next', async importOriginal => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../utils/pluginViewRuntime', () => ({
  getAvailablePluginViews: () => [], getTabViewPreference: () => null, selectSerialPluginView: vi.fn(),
}));
vi.mock('./terminalContextMenu', () => ({ buildTerminalContextMenuItems: () => [] }));

const roots: Root[] = [];
const managers: TerminalViewportManager[] = [];
let frames: Map<number, FrameRequestCallback>;
let frameId = 0;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-30T00:00:00Z'));
  frames = new Map();
  frameId = 0;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(180);
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(3600);
  resetStoresForTests();
});
afterEach(async () => {
  await act(async () => {
    roots.splice(0).forEach(root => root.unmount());
    for (const group of timelineCoordinator.getSnapshot().groups) timelineCoordinator.deleteGroup(group.id);
  });
  managers.splice(0).forEach(manager => manager.dispose());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function frame(count = 1) {
  await act(async () => {
    for (let index = 0; index < count; index++) {
      vi.advanceTimersByTime(16);
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach(callback => callback(performance.now()));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }
  });
}
async function mount(id: string, replay = false) {
  const manager = new TerminalViewportManager(id, { maxLines: 1000 });
  managers.push(manager);
  manager.appendLines(Array.from({ length: 200 }, (_, index) => ({
    timestamp: index * 10, direction: 'RX' as const,
    rawData: new TextEncoder().encode(`line ${index}`), isHex: false,
  })));
  useTerminalStore.getState().ensureTerminal(id);
  useTerminalStore.getState().setTerminalConfig(id, { scrollLocked: true });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(<TerminalView tabId={id} manager={manager}
    portId={replay ? undefined : id} sourceId={replay ? `replay:${id}` : undefined}
    timelineClockId={replay ? 'replay:session' : undefined}
    terminalConfig={replay ? { scrollLocked: true } : undefined} />));
  await frame(2);
  return {
    manager, host,
    container: host.querySelector<HTMLDivElement>('.terminal-view')!,
    pin: () => host.querySelector<HTMLButtonElement>('.terminal-filter-display-group button')!,
    bottom: () => host.querySelector<HTMLButtonElement>('.terminal-jump-btn.bottom')!,
  };
}
async function click(button: HTMLButtonElement) { await act(async () => button.click()); }
async function group(...slots: string[]) {
  let id = '';
  await act(async () => { id = timelineCoordinator.createGroup({ name: 'linked', memberSlots: slots }); });
  await frame(5);
  return id;
}
async function key(element: HTMLElement, value: string, ctrlKey = false) {
  await act(async () => { element.dispatchEvent(new KeyboardEvent('keydown', { key: value, ctrlKey, bubbles: true })); });
}

describe('TerminalView existing Pin + linked scrolling', () => {
  it('enables grouped Pins and derives their pressed state from group LIVE, not stale local locks', async () => {
    const a = await mount('a'), b = await mount('b');
    await group('a', 'b');
    expect(a.pin().disabled).toBe(false);
    expect(a.pin().title).toBe('timeline.groupScrollLock');
    expect(a.pin().getAttribute('aria-pressed')).toBe('false');
    expect(b.pin().getAttribute('aria-pressed')).toBe('false');
    await click(a.pin());
    expect(timelineCoordinator.groupForSlot('b')?.mode).toBe('live');
    expect(a.pin().getAttribute('aria-pressed')).toBe('true');
    expect(b.pin().getAttribute('aria-pressed')).toBe('true');
    await click(b.pin());
    expect(a.pin().getAttribute('aria-pressed')).toBe('false');
    expect(useTerminalStore.getState().terminals.a.scrollLocked).toBe(true);
    expect(useTerminalStore.getState().terminals.b.scrollLocked).toBe(true);
  });

  it('bare scroll cannot turn LIVE off; explicit vertical wheel can, and reaching bottom stays browse', async () => {
    const a = await mount('a');
    await group('a');
    await click(a.pin());
    await act(async () => {
      a.container.scrollTop = 200;
      a.container.dispatchEvent(new Event('scroll'));
      a.container.dispatchEvent(new WheelEvent('wheel', { deltaX: 20, deltaY: 0, bubbles: true }));
    });
    expect(a.pin().getAttribute('aria-pressed')).toBe('true');
    await act(async () => { a.container.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, bubbles: true })); });
    expect(timelineCoordinator.groupForSlot('a')?.mode).toBe('browse');
    expect(a.pin().getAttribute('aria-pressed')).toBe('false');
    await click(a.bottom());
    await frame(12);
    expect(timelineCoordinator.groupForSlot('a')?.mode).toBe('browse');
    expect(a.pin().getAttribute('aria-pressed')).toBe('false');
  });

  it('Pin cancels a pending navigation settle before restoring LIVE', async () => {
    const a = await mount('a');
    await group('a');
    await key(a.container, 'PageUp');
    const oldEpoch = timelineCoordinator.groupForSlot('a')!.navigationEpoch;
    await click(a.pin());
    expect(timelineCoordinator.groupForSlot('a')!.navigationEpoch).toBeGreaterThan(oldEpoch);
    await frame(15);
    await act(async () => { window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); });
    await frame(10);
    expect(timelineCoordinator.groupForSlot('a')?.mode).toBe('live');
    expect(a.pin().getAttribute('aria-pressed')).toBe('true');
  });

  it('opening search enters browse and closing it does not restart group follow', async () => {
    const a = await mount('a');
    await group('a');
    await click(a.pin());
    await key(a.container, 'f', true);
    expect(timelineCoordinator.groupForSlot('a')?.mode).toBe('browse');
    await key(a.container, 'Escape');
    await frame(12);
    expect(a.pin().getAttribute('aria-pressed')).toBe('false');
    expect(timelineCoordinator.groupForSlot('a')?.mode).toBe('browse');
  });

  it('disables incompatible replay/mixed group LIVE with an explanatory title', async () => {
    const a = await mount('a'), replay = await mount('history', true);
    await group('a', 'history');
    for (const view of [a, replay]) {
      expect(view.pin().disabled).toBe(true);
      expect(view.pin().title).toBe('timeline.liveUnavailable');
      expect(view.pin().getAttribute('aria-pressed')).toBe('false');
      await click(view.pin());
    }
    expect(timelineCoordinator.groupForSlot('history')?.mode).toBe('browse');
  });

  it('leaving a group preserves position, clears independent lock, and leaves Pin usable', async () => {
    const a = await mount('a');
    await group('a');
    // Explicit local positioning avoids depending on scheduler settlement here;
    // the adapter integration suite separately checks common-time seeking.
    await act(async () => a.manager.scrollToSeq(70, 'center'));
    await frame(2);
    const before = a.container.scrollTop;
    expect(before).toBeGreaterThan(0);
    expect(before).toBeLessThan(3000);
    await act(async () => timelineCoordinator.removeMember('a'));
    await frame(3);
    expect(a.container.scrollTop).toBe(before);
    expect(useTerminalStore.getState().terminals.a.scrollLocked).toBe(false);
    expect(a.pin().disabled).toBe(false);
    expect(a.pin().getAttribute('aria-pressed')).toBe('false');
    await click(a.pin());
    expect(useTerminalStore.getState().terminals.a.scrollLocked).toBe(true);
    expect(a.pin().getAttribute('aria-pressed')).toBe('true');
  });

  it('independent Pin synchronously clears the old lock and cancels its pending gesture', async () => {
    const a = await mount('a');
    const setLocked = vi.spyOn(a.manager, 'setLocked');
    await key(a.container, 'PageUp');
    await click(a.pin());
    expect(setLocked).toHaveBeenCalledWith(false);
    expect(useTerminalStore.getState().terminals.a.scrollLocked).toBe(false);
    await frame(12);
    expect(useTerminalStore.getState().terminals.a.scrollLocked).toBe(false);
  });
});
