// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SendCommand } from '../../../types';
import { resetStoresForTests } from '../../../stores/resetStores';
import { useAppStore } from '../../../stores/useAppStore';
import { QuickSendStrip } from './QuickSendStrip';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({ t: (key: string) => key }),
}));
const openPopout = vi.fn((name: string) => { void name; return Promise.resolve(); });
vi.mock('../../../services/tauri', () => ({
  popoutService: { openPopout: (name: string) => openPopout(name) },
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type MutableRect = { width: number; height?: number };
const rect = ({ width, height = 28 }: MutableRect): DOMRect => ({
  width,
  height,
  top: 0,
  left: 0,
  right: width,
  bottom: height,
  x: 0,
  y: 0,
  toJSON: () => ({}),
});

const commands: SendCommand[] = [
  { id: 'text', name: 'Text', order: 0, delay: 0, type: 'string', content: 'AT', appendLineEnding: '\\r\\n' },
  { id: 'hex', name: 'HEX command', order: 1, delay: 0, type: 'hex', content: '41 54', appendLineEnding: '\\r\\n' },
];
const unknown = {
  ...commands[0], id: 'unknown', name: 'Unknown', kind: 'unknown',
} as unknown as SendCommand;

let container: HTMLDivElement;
let root: Root;
let rectSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetStoresForTests();
  vi.clearAllMocks();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('op-quick-send-row')) return rect({ width: 500 });
    if (this.classList.contains('op-quick-panel-btn')) return rect({ width: 40 });
    if (this.classList.contains('op-quick-cmd')) return rect({ width: 100 });
    return rect({ width: 0 });
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  rectSpy.mockRestore();
  vi.unstubAllGlobals();
});

function render(props: Partial<React.ComponentProps<typeof QuickSendStrip>> = {}) {
  act(() => {
    root.render(createElement(QuickSendStrip, {
      commands,
      isPortActive: true,
      onSendCommand: vi.fn(),
      onConfigure: vi.fn(),
      ...props,
    }));
  });
}

function commandButtons() {
  return [...container.querySelectorAll<HTMLButtonElement>('.op-quick-send-row > .op-quick-cmd')];
}

describe('inline quick-send strip states', () => {
  it('hides the inline layout completely when inline count is zero', () => {
    useAppStore.getState().setConfig({ quickSendInlineCount: 0 });
    render();
    expect(container.querySelector('.op-quick-send-row')).toBeNull();
  });

  it('renders HEX commands with an explicit marker and keeps their action executable', () => {
    const send = vi.fn();
    render({ onSendCommand: send });
    const hex = commandButtons().find(button => button.title.startsWith('HEX command'))!;
    expect(hex.querySelector('.op-quick-cmd-hex')?.textContent).toBe('HEX');
    expect(hex.querySelector('.op-quick-cmd-content')?.textContent).toBe('41 54');
    expect(hex.disabled).toBe(false);
    act(() => { hex.click(); });
    expect(send).toHaveBeenCalledWith(commands[1]);
  });

  it.each([
    ['inactive port', { isPortActive: false }],
    ['exclusive flow', { isBusy: true }],
  ])('disables every inline command while %s', (_label, props) => {
    render(props);
    expect(commandButtons()).toHaveLength(2);
    expect(commandButtons().every(button => button.disabled)).toBe(true);
    // Opening the dedicated panel remains available even when sending is blocked.
    expect(container.querySelector<HTMLButtonElement>('.op-quick-panel-btn')?.disabled).toBe(false);
  });

  it('keeps unknown imported actions disabled even on an active port', () => {
    render({ commands: [unknown] });
    const button = commandButtons()[0];
    expect(button.disabled).toBe(true);
    act(() => { button.click(); });
    expect(openPopout).not.toHaveBeenCalled();
  });

  it('opens the dedicated panel without changing inline command state', async () => {
    render();
    await act(async () => { container.querySelector<HTMLButtonElement>('.op-quick-panel-btn')!.click(); });
    expect(openPopout).toHaveBeenCalledWith('quick-send');
  });
});

export {};
