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
const key = (target: HTMLElement, value: string, ctrlKey = true) => target.dispatchEvent(new KeyboardEvent('keydown', { key: value, ctrlKey, bubbles: true, cancelable: true }));

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
});
