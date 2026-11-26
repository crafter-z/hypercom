// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStoresForTests } from '../../stores/resetStores';
import { useAppStore } from '../../stores/useAppStore';
import { useOperationStore } from '../../stores/useOperationStore';
import { useTerminalStore } from '../../stores/useTerminalStore';
import type { SendHistoryEntry } from '../../types';
import SendSection from './SendSection';
import { normalizeHexPaste } from './hooks/useHexCompose';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('./components/QuickSendStrip', () => ({
  QuickSendStrip: () => createElement('div', { className: 'op-quick-send-row' }),
}));
vi.mock('./components/SendFileControls', () => ({
  SendFileButton: () => null,
  FileSendProgress: () => null,
}));
vi.mock('./hooks/useFileSend', () => ({
  useFileSend: () => ({ progress: null, startFileSend: vi.fn(), cancelFileSend: vi.fn() }),
}));
vi.mock('../../utils/commandExecution', () => ({ executeQuickCommand: vi.fn() }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
const history = (): SendHistoryEntry | null => null;

beforeEach(() => {
  resetStoresForTests();
  useOperationStore.getState().setOpState({ sendInput: '41', sendIsHex: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('SendSection HEX layout & compose UX', () => {
  it('does not add a no-line-ending hint row in HEX mode and places byte chip in footer', () => {
    act(() => root.render(createElement(SendSection, {
      activePortId: null,
      isPortActive: false,
      isConnected: false,
      sendData: vi.fn(async () => 0),
      historyUp: history,
      historyDown: history,
    })));

    expect(container.querySelector('.op-send-hex-suffix')).toBeNull();
    expect(container.querySelector<HTMLSelectElement>('.op-line-ending-select')?.disabled).toBe(true);
    expect(container.querySelector('.op-send-input-wrap .op-send-byte-chip')).toBeNull();
    expect(container.querySelector('.op-send-footer .op-send-byte-chip')?.textContent).toBe('1 B');
  });

  it('renders byteCount.label for GBK encoding instead of hardcoded bytes', () => {
    useAppStore.setState({ ports: [{ id: 'COM1', name: 'COM1', status: 'connected', type: 'real', isHidden: false }] });
    useAppStore.getState().openTab('COM1');
    useTerminalStore.getState().ensureTerminal('COM1');
    useTerminalStore.getState().setTerminalEncoding('COM1', 'GBK');
    useOperationStore.getState().setOpState({ sendInput: '你好', sendIsHex: false });
    act(() => root.render(createElement(SendSection, {
      activePortId: 'COM1',
      isPortActive: true,
      isConnected: true,
      sendData: vi.fn(async () => 0),
      historyUp: history,
      historyDown: history,
    })));
    expect(container.querySelector('.op-send-byte-chip')?.textContent).toBe('2 chars · ? bytes');
  });

  it('normalizes 0x prefixes and delimiters in HEX smart paste without padding odd nibbles', () => {
    expect(normalizeHexPaste('0xAA, 0xBB, 0x01')).toBe('AA BB 01');
    expect(normalizeHexPaste('AA:BB:CC')).toBe('AA BB CC');
    expect(normalizeHexPaste('0X0A; 0X0D')).toBe('0A 0D');
    expect(normalizeHexPaste('0xA, 0xB')).toBe('A B');
    expect(normalizeHexPaste('AA BB CC')).toBeNull();
  });

  it('allows multiline ArrowUp/ArrowDown navigation and only recalls at first/last line without wiping input on null', () => {
    const up = vi.fn(() => null);
    const down = vi.fn(() => null);
    useOperationStore.getState().setOpState({ sendInput: 'line1\nline2\nline3', sendIsHex: false });
    act(() => root.render(createElement(SendSection, {
      activePortId: 'COM1',
      isPortActive: true,
      isConnected: true,
      sendData: vi.fn(async () => 0),
      historyUp: up,
      historyDown: down,
    })));
    const textarea = container.querySelector<HTMLTextAreaElement>('.op-send-input')!;
    // Middle line: neither ArrowUp nor ArrowDown should recall history.
    textarea.setSelectionRange(8, 8);
    act(() => { textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })); });
    act(() => { textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })); });
    expect(up).not.toHaveBeenCalled();
    expect(down).not.toHaveBeenCalled();

    // First line: ArrowUp recalls, and null result must NOT wipe sendInput.
    textarea.setSelectionRange(2, 2);
    act(() => { textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })); });
    expect(up).toHaveBeenCalledTimes(1);
    expect(useOperationStore.getState().sendInput).toBe('line1\nline2\nline3');

    // Last line: ArrowDown recalls, and null result must NOT wipe sendInput.
    textarea.setSelectionRange(15, 15);
    act(() => { textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })); });
    expect(down).toHaveBeenCalledTimes(1);
    expect(useOperationStore.getState().sendInput).toBe('line1\nline2\nline3');
  });

  it('sends on Ctrl+Enter / Cmd+Enter when sendOnEnter is false and lets plain Enter insert natively', async () => {
    const sendData = vi.fn(async () => 2);
    useAppStore.setState({
      ports: [{ id: 'COM1', name: 'COM1', status: 'connected', type: 'real', isHidden: false }],
    });
    useAppStore.getState().setConfig({ sendOnEnter: false });
    useAppStore.setState({ activeTabId: useAppStore.getState().openTab('COM1') });
    useOperationStore.getState().setOpState({ sendInput: 'AT', sendIsHex: false });
    act(() => root.render(createElement(SendSection, {
      activePortId: 'COM1',
      isPortActive: true,
      isConnected: true,
      sendData,
      historyUp: history,
      historyDown: history,
    })));
    const textarea = container.querySelector<HTMLTextAreaElement>('.op-send-input')!;
    const plainEnter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    act(() => { textarea.dispatchEvent(plainEnter); });
    expect(plainEnter.defaultPrevented).toBe(false);
    expect(sendData).not.toHaveBeenCalled();

    const ctrlEnter = new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => { textarea.dispatchEvent(ctrlEnter); });
    expect(ctrlEnter.defaultPrevented).toBe(true);
    expect(sendData).toHaveBeenCalledTimes(1);

    const clearBtn = container.querySelector<HTMLButtonElement>('.op-send-clear-btn')!;
    expect(clearBtn).not.toBeNull();
    act(() => { clearBtn.click(); });
    expect(useOperationStore.getState().sendInput).toBe('');
  });
});

export {};
