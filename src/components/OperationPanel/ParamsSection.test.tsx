// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../stores/useAppStore';
import { resetStoresForTests } from '../../stores/resetStores';
import { clearTerminal, releaseViewportManager } from '../../utils/terminal/viewportManager';
import { getRxPipeline } from '../../utils/rxPipeline';
import { ttyService } from '../../utils/ttyService';
import ParamsSection from './ParamsSection';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../services/tauri', () => ({ storageService: { loadPortPresets: vi.fn(async () => []) } }));
vi.mock('../../utils/terminal/viewportManager', () => ({ clearTerminal: vi.fn(), releaseViewportManager: vi.fn() }));
vi.mock('../../utils/rxPipeline', () => {
  const pipeline = { flushAndReset: vi.fn() };
  return { getRxPipeline: () => pipeline };
});
vi.mock('../../utils/ttyService', () => ({ ttyService: { clear: vi.fn() } }));
// Only isolate modal infrastructure. The request/cancel/confirm wiring remains real.
vi.mock('../shared/ConfirmDialog', () => ({ default: ({ open, onConfirm, onCancel }: {
  open: boolean; onConfirm: () => void; onCancel: () => void;
}) => open ? createElement('div', { role: 'dialog' },
  createElement('button', { onClick: onConfirm }, 'Confirm'),
  createElement('button', { onClick: onCancel }, 'Cancel')) : null }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
let tabs: string[];
const radios = () => Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
const mode = (portId: string) => useAppStore.getState().ports.find(port => port.id === portId)?.mode;
const dialogButton = (text: string) => Array.from(container.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find(button => button.textContent === text)!;
const expectNoClear = () => {
  expect(clearTerminal).not.toHaveBeenCalled();
  expect(releaseViewportManager).not.toHaveBeenCalled();
  expect(getRxPipeline().flushAndReset).not.toHaveBeenCalled();
  expect(ttyService.clear).not.toHaveBeenCalled();
};

beforeEach(async () => {
  vi.clearAllMocks();
  resetStoresForTests();
  useAppStore.setState({ ports: ['COM1', 'COM2'].map(id => ({ id, name: id, status: 'connected', type: 'real', isHidden: false, mode: 'trx' })) });
  tabs = ['COM1', 'COM2'].map(id => useAppStore.getState().openTab(id));
  useAppStore.setState({ activeTabId: tabs[0] });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(ParamsSection, { isPortActive: true })));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('ParamsSection mode selection', () => {
  it('uses a named, single-selection radio group and does not confirm the selected mode again', () => {
    expect(container.querySelector('[role="radiogroup"]')?.getAttribute('aria-label')).toBe('params.mode');
    act(() => radios()[0].click());
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(radios().map(button => button.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    expectNoClear();
  });

  it('leaves the mode and buffers untouched until confirmation, including keyboard requests', () => {
    act(() => radios()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(mode('COM1')).toBe('trx');
    expect(radios().map(button => button.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    expectNoClear();
    act(() => dialogButton('Cancel').click());
    expect(mode('COM1')).toBe('trx');
    expectNoClear();
  });

  it('flushes old-mode RX before clearing and releasing its TRX display on acceptance', () => {
    act(() => radios()[1].click());
    act(() => dialogButton('Confirm').click());
    expect(mode('COM1')).toBe('tty');
    expect(getRxPipeline().flushAndReset).toHaveBeenCalledExactlyOnceWith('COM1');
    expect(clearTerminal).toHaveBeenCalledExactlyOnceWith('COM1');
    expect(releaseViewportManager).toHaveBeenCalledExactlyOnceWith('COM1');
    expect(ttyService.clear).toHaveBeenCalledExactlyOnceWith('COM1');
    expect(vi.mocked(getRxPipeline().flushAndReset).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(clearTerminal).mock.invocationCallOrder[0]);
    expect(vi.mocked(clearTerminal).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(releaseViewportManager).mock.invocationCallOrder[0]);
    expect(radios().map(button => button.getAttribute('aria-checked'))).toEqual(['false', 'true']);
  });

  it('keeps the confirmed target fixed when focus changes while confirmation is pending', () => {
    act(() => radios()[1].click());
    act(() => useAppStore.setState({ activeTabId: tabs[1] }));
    act(() => dialogButton('Confirm').click());
    expect(mode('COM1')).toBe('tty');
    expect(mode('COM2')).toBe('trx');
    expect(clearTerminal).toHaveBeenCalledExactlyOnceWith('COM1');
    expect(ttyService.clear).toHaveBeenCalledExactlyOnceWith('COM1');
    // The selector still reflects the newly focused port, not the requested port.
    expect(radios()[0].getAttribute('aria-checked')).toBe('true');
  });

  it.each(['removed', 'already applied'])('does not clear buffers if the pending target was %s', reason => {
    act(() => radios()[1].click());
    act(() => {
      if (reason === 'removed') useAppStore.setState(state => ({ ports: state.ports.filter(port => port.id !== 'COM1') }));
      else useAppStore.getState().setPortMode('COM1', 'tty');
    });
    act(() => dialogButton('Confirm').click());
    expectNoClear();
  });

  it('does not release the new TRX display when switching back from TTY', () => {
    act(() => useAppStore.getState().setPortMode('COM1', 'tty'));
    act(() => radios()[0].click());
    act(() => dialogButton('Confirm').click());
    expect(mode('COM1')).toBe('trx');
    expect(releaseViewportManager).not.toHaveBeenCalled();
    expect(clearTerminal).toHaveBeenCalledExactlyOnceWith('COM1');
  });

  it('disables mode changes when there is no active port', async () => {
    await act(async () => root.render(createElement(ParamsSection, { isPortActive: false })));
    expect(radios().every(button => button.disabled)).toBe(true);
    act(() => radios()[1].click());
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expectNoClear();
  });
});
