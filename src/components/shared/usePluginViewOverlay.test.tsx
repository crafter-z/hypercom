// @vitest-environment jsdom
import { act, createElement, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquirePluginViewOverlay } from '../../utils/pluginViewOverlay';
import { notifyError } from '../../stores/useToastStore';
import { usePluginViewOverlay } from './usePluginViewOverlay';

vi.mock('../../utils/pluginViewOverlay', () => ({ acquirePluginViewOverlay: vi.fn() }));
vi.mock('../../stores/useToastStore', () => ({ notifyError: vi.fn() }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function Probe({ open, cutout = false }: { open: boolean; cutout?: boolean }) {
  const element = useRef<HTMLDivElement>(null);
  const ready = usePluginViewOverlay(open, cutout ? element : undefined);
  return createElement('div', { ref: element, 'data-ready': String(ready) });
}
let root: Root;
let host: HTMLDivElement;
let guard: ReturnType<typeof acquirePluginViewOverlay>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  guard = { ready: Promise.resolve(), updateRect: vi.fn(async () => {}), release: vi.fn() };
  vi.mocked(acquirePluginViewOverlay).mockReturnValue(guard);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('plugin overlay failure visibility and retry', () => {
  it('never reveals the overlay before the native handshake settles', async () => {
    const pending = deferred();
    guard.ready = pending.promise;
    await act(async () => { root.render(createElement(Probe, { open: true })); });
    expect(host.firstElementChild?.getAttribute('data-ready')).toBe('false');
    await act(async () => { pending.resolve(); });
    expect(host.firstElementChild?.getAttribute('data-ready')).toBe('true');
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('surfaces failure once and allows closing and reopening to retry', async () => {
    guard.ready = Promise.reject(new Error('native hide rejected'));
    await act(async () => { root.render(createElement(Probe, { open: true })); });
    expect(host.firstElementChild?.getAttribute('data-ready')).toBe('false');
    expect(notifyError).toHaveBeenCalledExactlyOnceWith(undefined, 'pluginViews.overlayFailed');
    await act(async () => { root.render(createElement(Probe, { open: false })); });
    expect(guard.release).toHaveBeenCalledTimes(1);
    guard = { ready: Promise.resolve(), updateRect: vi.fn(async () => {}), release: vi.fn() };
    vi.mocked(acquirePluginViewOverlay).mockReturnValue(guard);
    await act(async () => { root.render(createElement(Probe, { open: true })); });
    expect(host.firstElementChild?.getAttribute('data-ready')).toBe('true');
    expect(notifyError).toHaveBeenCalledTimes(1);
  });

  it('does not spam errors for repeatedly rejected cutout updates', async () => {
    const error = new Error('native clip rejected');
    guard.ready = Promise.reject(error);
    vi.mocked(guard.updateRect).mockRejectedValue(error);
    await act(async () => { root.render(createElement(Probe, { open: true, cutout: true })); });
    for (let index = 0; index < 3; index++) {
      await act(async () => { window.dispatchEvent(new Event('resize')); });
    }
    expect(host.firstElementChild?.getAttribute('data-ready')).toBe('false');
    expect(notifyError).toHaveBeenCalledTimes(1);
  });

  it('ignores a failed handshake after its owner closes', async () => {
    const pending = deferred();
    guard.ready = pending.promise;
    await act(async () => { root.render(createElement(Probe, { open: true })); });
    await act(async () => { root.render(createElement(Probe, { open: false })); });
    await act(async () => { pending.reject(new Error('late failure')); });
    expect(notifyError).not.toHaveBeenCalled();
    expect(host.firstElementChild?.getAttribute('data-ready')).toBe('false');
  });
});
