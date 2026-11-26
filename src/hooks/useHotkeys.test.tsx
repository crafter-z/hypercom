// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useHotkeys } from './useHotkeys';
import { useAppStore } from '../stores/useAppStore';
import { useSystemStore } from '../stores/useSystemStore';
import { resetStoresForTests } from '../stores/resetStores';
import { clearTerminal } from '../utils/terminal/viewportManager';

const toggle = vi.hoisted(() => vi.fn());
vi.mock('./useSerialConnection', () => ({ useSerialConnection: () => ({ toggleConnection: toggle }) }));
vi.mock('../utils/terminal/viewportManager', async original => ({ ...await original<typeof import('../utils/terminal/viewportManager')>(), clearTerminal: vi.fn() }));
let root: Root;
let host: HTMLDivElement;
function Probe() { useHotkeys(); return null; }
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks(); resetStoresForTests();
  useAppStore.getState().openTab('COM1');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<Probe />));
});
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals(); });
const key = (
  target: HTMLElement,
  value: string,
  ctrlKey = true,
  extra: Partial<KeyboardEventInit> = {},
) => target.dispatchEvent(new KeyboardEvent('keydown', { key: value, ctrlKey, bubbles: true, cancelable: true, ...extra }));

describe('global shortcuts yield to modal owners', () => {
  it('does not clear/connect or dismiss background UI even if its listener predates the dialog', () => {
    useSystemStore.getState().setUIState({ isHotkeyHelpOpen: true });
    const modal = document.createElement('div'); modal.setAttribute('aria-modal', 'true');
    const button = document.createElement('button'); modal.append(button); document.body.append(modal); button.focus();
    key(button, 'l'); key(button, 'k'); key(button, 'Escape', false);
    expect(clearTerminal).not.toHaveBeenCalled();
    expect(toggle).not.toHaveBeenCalled();
    expect(useSystemStore.getState().ui.isHotkeyHelpOpen).toBe(true);
  });

  it('retains non-modal clear/connect and pending-help Escape fallbacks', () => {
    key(document.body, 'l'); key(document.body, 'k');
    expect(clearTerminal).toHaveBeenCalledExactlyOnceWith('COM1');
    expect(toggle).toHaveBeenCalledExactlyOnceWith('COM1');
    useSystemStore.getState().setUIState({ isHotkeyHelpOpen: true });
    key(document.body, 'Escape', false);
    expect(useSystemStore.getState().ui.isHotkeyHelpOpen).toBe(false);
  });

  it('guards single-modifier shortcuts against extra Shift/Alt modifiers', () => {
    key(document.body, 'L', true, { shiftKey: true });
    key(document.body, 'k', true, { altKey: true });
    expect(clearTerminal).not.toHaveBeenCalled();
    expect(toggle).not.toHaveBeenCalled();
  });

  it('allows non-editing shell chords inside form fields while keeping editing keys safe', () => {
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();

    key(input, 'b');
    expect(useSystemStore.getState().ui.sidebarCollapsed).toBe(true);

    key(input, '/');
    expect(useSystemStore.getState().ui.isHotkeyHelpOpen).toBe(true);

    key(input, ',');
    expect(useSystemStore.getState().ui.isConfigOpen).toBe(true);

    key(input, 'l');
    key(input, 'k');
    expect(clearTerminal).not.toHaveBeenCalled();
    expect(toggle).not.toHaveBeenCalled();
  });

  it('delegates Ctrl+F to terminal search and Ctrl+W to close unpinned active tab', () => {
    const onSearch = vi.fn();
    const onClose = vi.fn();
    window.addEventListener('hypercom:open-terminal-search', onSearch);
    window.addEventListener('hypercom:close-active-tab', onClose);
    try {
      key(document.body, 'f');
      expect(onSearch).toHaveBeenCalledTimes(1);

      key(document.body, 'w');
      expect(onClose).toHaveBeenCalledTimes(1);

      // Pinned tab must not dispatch close.
      const activeId = useAppStore.getState().activeTabId!;
      useAppStore.getState().pinTab(activeId);
      key(document.body, 'w');
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('hypercom:open-terminal-search', onSearch);
      window.removeEventListener('hypercom:close-active-tab', onClose);
    }
  });

  it('supports Ctrl+Tab, Ctrl+1..9 tab switching, and F6 pane cycling', () => {
    const t1 = useAppStore.getState().activeTabId!;
    const t2 = useAppStore.getState().openTab('COM2');
    const t3 = useAppStore.getState().openTab('COM3');
    expect(useAppStore.getState().activeTabId).toBe(t3);

    key(document.body, '1');
    expect(useAppStore.getState().activeTabId).toBe(t1);

    key(document.body, 'Tab', true);
    expect(useAppStore.getState().activeTabId).toBe(t2);

    key(document.body, 'Tab', true, { shiftKey: true });
    expect(useAppStore.getState().activeTabId).toBe(t1);

    // Split pane and verify F6 cycles between panes
    useAppStore.getState().splitPane('vertical');
    const afterSplitPane = useAppStore.getState().focusedPaneId;
    key(document.body, 'F6', false);
    expect(useAppStore.getState().focusedPaneId).not.toBe(afterSplitPane);
  });
});
