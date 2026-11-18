// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GlobalTerminalSearchPanel from './GlobalTerminalSearchPanel';
import { isGlobalTerminalSearchShortcut } from './MainDisplay';
import { clearGlobalTerminalSearchRegistryForTests, getGlobalTerminalSearchSources, registerGlobalTerminalSearch } from './globalTerminalSearch';

vi.mock('react-i18next', async importOriginal => ({ ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string, options?: Record<string, unknown>) =>
    key === 'globalSearch.page' ? `Page ${options?.current} / ${options?.total}` : key }) }));
vi.mock('../shared/usePluginViewOverlay', () => ({ usePluginViewOverlay: () => true }));
const sessionState = vi.hoisted(() => ({ instances: [] as Array<{ sources: any[]; cancel: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }> }));
vi.mock('../../utils/terminal/search/searchMatcher', () => ({ validateSearchSpec: () => null }));
vi.mock('../../utils/terminal/search/searchSession', () => ({
  TerminalSearchSession: class {
    cancel = vi.fn(); dispose = vi.fn();
    constructor(public sources: any[], _spec: unknown, private listener: (snapshot: any) => void) { sessionState.instances.push(this); }
    start() {
      const hits = Array.from({ length: 75 }, (_, index) => ({ sourceId: 'serial:a', generation: 1, startSeq: index, endSeq: index,
        spans: [{ seq: index, start: 0, end: 2 }], timestamp: index, direction: 'RX' }));
      this.listener({ status: 'ready', hits, scanned: 75, truncated: false, incomplete: false });
    }
  },
}));
function manager(id = 'serial:a') {
  return { createSearchSource: vi.fn(() => ({ id, getState: () => ({ generation: 1, revision: 0, firstSeq: 0, lastSeq: 74, configKey: '', available: true }), readRecord: () => null })), previewSearchHit: vi.fn(() => 'preview'), isSearchHitValid: vi.fn(() => true) };
}
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  clearGlobalTerminalSearchRegistryForTests(); sessionState.instances.length = 0;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); clearGlobalTerminalSearchRegistryForTests(); container.remove();
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
async function mount(open = true, onClose = vi.fn()) { await act(async () => root.render(<GlobalTerminalSearchPanel open={open} onClose={onClose} />)); return onClose; }
async function typeQuery(value = 'needle') {
  await act(async () => {
    const query = container.querySelector<HTMLInputElement>('.global-terminal-search-query')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(query, value);
    query.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => vi.advanceTimersByTime(210));
}

describe('global terminal search registry and panel', () => {
  it('distinguishes global Ctrl/Cmd+Shift+F from local Ctrl/Cmd+F', () => {
    expect(isGlobalTerminalSearchShortcut(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isGlobalTerminalSearchShortcut(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true }))).toBe(false);
    expect(isGlobalTerminalSearchShortcut(new KeyboardEvent('keydown', { key: 'F', metaKey: true, shiftKey: true }))).toBe(true);
  });
  it('uses cached registration snapshots and does not retire a replacement through an old cleanup', () => {
    const cleanup = registerGlobalTerminalSearch({ id: 'a', manager: manager(), onReveal: vi.fn() });
    expect(getGlobalTerminalSearchSources()).toBe(getGlobalTerminalSearchSources());
    registerGlobalTerminalSearch({ id: 'a', manager: manager(), onReveal: vi.fn() }); cleanup();
    expect(getGlobalTerminalSearchSources()).toHaveLength(1);
  });
  it('creates no session while closed or empty, then renders only one 50-result page', async () => {
    const entry = { id: 'serial:a', portId: 'A', manager: manager(), onReveal: vi.fn() };
    registerGlobalTerminalSearch(entry); await mount(false); expect(sessionState.instances).toHaveLength(0);
    await mount(); expect(sessionState.instances).toHaveLength(0);
    const onClose = await mount(); await typeQuery();
    expect(container.querySelectorAll('.global-terminal-search-result')).toHaveLength(50);
    expect(entry.manager.previewSearchHit).toHaveBeenCalledTimes(50);
    expect(container.textContent).toContain('Page 1 / 2');
    await act(async () => (container.querySelector('.global-terminal-search-result') as HTMLButtonElement).click());
    expect(entry.onReveal).toHaveBeenCalledTimes(1); expect(onClose).toHaveBeenCalledTimes(1);
  });
  it('lets users select sources without ever auto-discovering TTY buffers', async () => {
    registerGlobalTerminalSearch({ id: 'serial:a', portId: 'A', manager: manager(), onReveal: vi.fn() });
    registerGlobalTerminalSearch({ id: 'serial:b', portId: 'B', manager: manager('serial:b'), onReveal: vi.fn() });
    await mount(); await typeQuery();
    expect(sessionState.instances[sessionState.instances.length - 1]?.sources).toHaveLength(2);
    await act(async () => (container.querySelector('.search-advanced-trigger') as HTMLButtonElement).click());
    await act(async () => (document.querySelector('.search-advanced-panel .global-terminal-search-sources input') as HTMLInputElement).click());
    await act(async () => vi.advanceTimersByTime(210));
    expect(sessionState.instances[sessionState.instances.length - 1]?.sources).toHaveLength(1);
  });
  it('keeps advanced settings collapsed and does not restart the session just to open or close them', async () => {
    registerGlobalTerminalSearch({ id: 'serial:a', manager: manager(), onReveal: vi.fn() });
    await mount(); await typeQuery();
    expect(document.querySelector('.search-advanced-panel')).toBeNull();
    const trigger = container.querySelector('.search-advanced-trigger') as HTMLButtonElement;
    await act(async () => trigger.click());
    expect(document.querySelector('.search-advanced-panel')).not.toBeNull();
    expect(document.querySelectorAll('.search-advanced-panel .global-terminal-search-sources input')).toHaveLength(1);
    await act(async () => vi.advanceTimersByTime(210));
    expect(sessionState.instances).toHaveLength(1);
    await act(async () => document.querySelector('.search-advanced-panel')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(document.querySelector('.search-advanced-panel')).toBeNull();
    expect(container.querySelector('.global-terminal-search-query')).not.toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(sessionState.instances).toHaveLength(1);
  });

  it('rejects expired hits before invoking terminal navigation', async () => {
    const entry = { id: 'serial:a', manager: { ...manager(), isSearchHitValid: vi.fn(() => false) }, onReveal: vi.fn() };
    registerGlobalTerminalSearch(entry); await mount(); await typeQuery();
    await act(async () => (container.querySelector('.global-terminal-search-result') as HTMLButtonElement).click());
    expect(entry.onReveal).not.toHaveBeenCalled(); expect(container.textContent).toContain('globalSearch.stale');
  });
  it('disposes an active session on close and on unmount without retaining timers', async () => {
    registerGlobalTerminalSearch({ id: 'serial:a', manager: manager(), onReveal: vi.fn() });
    await mount(); await typeQuery(); const session = sessionState.instances[0];
    await act(async () => (container.querySelector('.global-terminal-search-header .icon-btn') as HTMLButtonElement).click());
    expect(session.dispose).toHaveBeenCalled();
    await mount(false); expect(vi.getTimerCount()).toBe(0);
  });
});
