// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../stores/useAppStore';
import { resetStoresForTests } from '../../stores/resetStores';
import type { ContextMenuEntry } from '../shared/ContextMenu';

const mocks = vi.hoisted(() => ({
  toggleConnection: vi.fn(async () => {}),
  writeClipboardText: vi.fn(async () => {}),
  readText: vi.fn(async () => 'pasted-cmd'),
  notifyError: vi.fn(),
  ttyAttach: vi.fn(),
  ttyDetach: vi.fn(),
  ttySend: vi.fn(),
  ttyResize: vi.fn(),
  ttyClear: vi.fn(),
  flushAndReset: vi.fn(),
  clearTerminal: vi.fn(),
  fitFn: vi.fn(),
  termInstances: [] as Array<{
    options: Record<string, unknown>;
    cols: number;
    rows: number;
    open: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
    paste: ReturnType<typeof vi.fn>;
    getSelection: ReturnType<typeof vi.fn>;
    hasSelection: ReturnType<typeof vi.fn>;
    loadAddon: ReturnType<typeof vi.fn>;
    onData: ReturnType<typeof vi.fn>;
    onResize: ReturnType<typeof vi.fn>;
    attachCustomKeyEventHandler: ReturnType<typeof vi.fn>;
    customKeyHandler?: (e: KeyboardEvent) => boolean;
  }>,
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
    open = vi.fn();
    dispose = vi.fn();
    clear = vi.fn();
    paste = vi.fn();
    getSelection = vi.fn(() => 'selected-tty');
    hasSelection = vi.fn(() => true);
    loadAddon = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    onResize = vi.fn(() => ({ dispose: vi.fn() }));
    customKeyHandler?: (e: KeyboardEvent) => boolean;
    attachCustomKeyEventHandler = vi.fn((fn: (e: KeyboardEvent) => boolean) => {
      this.customKeyHandler = fn;
    });
    constructor(opts: Record<string, unknown>) {
      this.options = { ...opts };
      mocks.termInstances.push(this);
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = mocks.fitFn;
  },
}));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ readText: mocks.readText }));
vi.mock('../../utils/clipboard', () => ({ writeClipboardText: mocks.writeClipboardText }));
vi.mock('../../stores/useToastStore', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../stores/useToastStore')>(),
  notifyError: mocks.notifyError,
}));
vi.mock('../../hooks', () => ({ useSerialConnection: () => ({ toggleConnection: mocks.toggleConnection }) }));
vi.mock('../../utils/ttyService', () => ({
  ttyService: {
    attach: mocks.ttyAttach,
    detach: mocks.ttyDetach,
    send: mocks.ttySend,
    resize: mocks.ttyResize,
    clear: mocks.ttyClear,
  },
}));
vi.mock('../../utils/rxPipeline', () => ({
  getRxPipeline: () => ({ flushAndReset: mocks.flushAndReset }),
}));
vi.mock('../../utils/terminal/viewportManager', () => ({
  clearTerminal: mocks.clearTerminal,
}));
vi.mock('../../utils/flowRuntime', () => ({
  isFlowRunning: () => false,
  useFlowStatus: () => null,
}));
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../shared/ContextMenu', () => ({
  default: ({ items, onClose }: { items: ContextMenuEntry[]; onClose: () => void }) => (
    <div role="menu">
      {items.map((item, idx) =>
        'label' in item ? (
          <button key={idx} disabled={item.disabled} onClick={() => { item.onClick(); onClose(); }}>
            {item.label}
          </button>
        ) : null,
      )}
    </div>
  ),
}));
vi.mock('../shared/ConfirmDialog', () => ({
  default: ({ open, onConfirm, onCancel }: { open: boolean; onConfirm: () => void; onCancel: () => void }) =>
    open ? (
      <div role="dialog" data-testid="switch-trx-dialog">
        <button type="button" onClick={onConfirm}>confirm-switch</button>
        <button type="button" onClick={onCancel}>cancel-switch</button>
      </div>
    ) : null,
}));

const { default: TtyView } = await import('./TtyView');

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 1; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(640);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(320);
  resetStoresForTests();
  mocks.termInstances.length = 0;
  mocks.toggleConnection.mockClear();
  mocks.writeClipboardText.mockClear();
  mocks.readText.mockClear();
  mocks.notifyError.mockClear();
  mocks.ttyClear.mockClear();
  mocks.fitFn.mockClear();
  mocks.flushAndReset.mockClear();
  mocks.clearTerminal.mockClear();
  useAppStore.setState({
    ports: [{ id: 'COM3', name: 'COM3', status: 'disconnected', type: 'real', isHidden: false, mode: 'tty' }],
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('TtyView UX controls and shortcuts', () => {
  it('shows disconnected hint, suppresses cursorBlink while disconnected, and enables it on connect', async () => {
    await act(async () => root.render(<TtyView portId="COM3" />));
    const term = mocks.termInstances[0];
    expect(term.options.cursorBlink).toBe(false);
    expect(host.querySelector('.tty-disconnected-hint')).not.toBeNull();
    const connectBtn = host.querySelector<HTMLButtonElement>('.tty-connect-btn')!;
    await act(async () => connectBtn.click());
    expect(mocks.toggleConnection).toHaveBeenCalledWith('COM3');

    await act(async () => {
      useAppStore.getState().updatePort('COM3', { status: 'connected' });
    });
    expect(term.options.cursorBlink).toBe(true);
    expect(host.querySelector('.tty-disconnected-hint')).toBeNull();
  });

  it('supports right-click context menu, Ctrl+Shift+C/V, Ctrl+Wheel zoom with refit, and Switch to TRX confirmation', async () => {
    useAppStore.getState().updatePort('COM3', { status: 'connected' });
    await act(async () => root.render(<TtyView portId="COM3" />));
    const term = mocks.termInstances[0];

    // Ctrl+Shift+C copies selection, Ctrl+Shift+V pastes clipboard
    const copyEvt = new KeyboardEvent('keydown', { key: 'C', ctrlKey: true, shiftKey: true, cancelable: true });
    expect(term.customKeyHandler?.(copyEvt)).toBe(false);
    expect(mocks.writeClipboardText).toHaveBeenCalledWith('selected-tty');

    const pasteEvt = new KeyboardEvent('keydown', { key: 'V', ctrlKey: true, shiftKey: true, cancelable: true });
    await act(async () => {
      expect(term.customKeyHandler?.(pasteEvt)).toBe(false);
      await Promise.resolve();
    });
    expect(term.paste).toHaveBeenCalledWith('pasted-cmd');

    // Right-click menu offers Copy, Paste, Clear
    const ttyContainer = host.querySelector<HTMLDivElement>('.tty-container')!;
    await act(async () => { ttyContainer.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
    const clearItem = [...host.querySelectorAll('[role="menu"] button')].find(b => b.textContent === 'sendSection.clearButton') as HTMLButtonElement;
    expect(clearItem).toBeTruthy();
    await act(async () => clearItem.click());
    expect(mocks.ttyClear).toHaveBeenCalledWith('COM3');
    expect(term.clear).toHaveBeenCalled();

    // Native non-passive Ctrl+Wheel updates font size and re-fits xterm
    mocks.fitFn.mockClear();
    const beforeSize = useAppStore.getState().config.terminalFontSize;
    const wheelEvt = new WheelEvent('wheel', { ctrlKey: true, deltaY: -100, bubbles: true, cancelable: true });
    await act(async () => { host.querySelector('.tty-view')!.dispatchEvent(wheelEvt); });
    expect(wheelEvt.defaultPrevented).toBe(true);
    expect(useAppStore.getState().config.terminalFontSize).toBe(beforeSize + 1);
    expect(mocks.fitFn).toHaveBeenCalled();

    // Switch to TRX prompts ConfirmDialog and switches mode cleanly
    await act(async () => { host.querySelector<HTMLButtonElement>('.tty-switch-trx-btn')!.click(); });
    expect(host.querySelector('[data-testid="switch-trx-dialog"]')).not.toBeNull();
    await act(async () => {
      ([...host.querySelectorAll('button')].find(b => b.textContent === 'confirm-switch') as HTMLButtonElement).click();
    });
    expect(useAppStore.getState().ports.find(p => p.id === 'COM3')?.mode).toBe('trx');
    expect(mocks.flushAndReset).toHaveBeenCalledWith('COM3');
    expect(mocks.clearTerminal).toHaveBeenCalledWith('COM3');
  });
});
