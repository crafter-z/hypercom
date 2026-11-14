// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TerminalView from './TerminalView';
import { TerminalViewportManager } from '../../utils/terminal/viewportManager';
import { resetStoresForTests } from '../../stores/resetStores';
import type { ContextMenuEntry } from '../shared/ContextMenu';

const writeClipboard = vi.hoisted(() => vi.fn());
const notifyError = vi.hoisted(() => vi.fn());
vi.mock('../../utils/clipboard', () => ({ writeClipboardText: writeClipboard }));
vi.mock('../../stores/useToastStore', async importOriginal => ({
  ...await importOriginal<typeof import('../../stores/useToastStore')>(), notifyError,
}));
vi.mock('../../hooks', () => ({ useSerialConnection: () => ({ toggleConnection: vi.fn() }) }));
vi.mock('react-i18next', async importOriginal => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../utils/pluginViewRuntime', () => ({
  getAvailablePluginViews: () => [], getTabViewPreference: () => null, selectSerialPluginView: vi.fn(),
}));
vi.mock('../shared/ContextMenu', () => ({
  default: ({ items, onClose }: { items: ContextMenuEntry[]; onClose: () => void }) => (
    <div role="menu">{items.map((item, index) => 'label' in item ? (
      <button key={index} disabled={item.disabled} onClick={() => { item.onClick(); onClose(); }}>{item.label}</button>
    ) : null)}</div>
  ),
}));

let root: Root;
let host: HTMLDivElement;
let manager: TerminalViewportManager;
let frames: Map<number, FrameRequestCallback>;
let frameId = 0;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  frames = new Map();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(180);
  resetStoresForTests();
  writeClipboard.mockReset().mockResolvedValue(undefined);
  notifyError.mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  manager = new TerminalViewportManager('copy', { maxLines: 1000 });
});
afterEach(async () => {
  await act(async () => root.unmount());
  manager.dispose();
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function mount(displayFormat: 'string' | 'hex' = 'string') {
  manager.appendLines(['alpha', 'beta', 'gamma'].map(content => ({
    timestamp: 1, direction: 'RX' as const, isHex: false, rawData: new TextEncoder().encode(content),
  })));
  await act(async () => root.render(<TerminalView manager={manager} sourceId="copy" timelineEnabled={false}
    terminalConfig={{ showTimestamp: false, displayFormat }} />));
  await act(async () => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach(callback => callback(0));
  });
  return host.querySelector<HTMLDivElement>('.terminal-view')!;
}
function select(target: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(target);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
}
async function copy(target: HTMLElement) {
  const event = new Event('copy', { bubbles: true, cancelable: true });
  await act(async () => { target.dispatchEvent(event); });
  return event;
}
async function openMenu(target: HTMLElement) {
  await act(async () => { target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
}
async function activate(label: string) {
  const button = [...host.querySelectorAll('button')].find(item => item.textContent === label)!;
  button.focus();
  window.getSelection()?.removeAllRanges(); // real menu focus can replace the document selection
  await act(async () => button.click());
}

describe('TerminalView copy entry parity', () => {
  it('uses the same parked-row text and boundaries for keyboard and menu copy', async () => {
    const output = await mount();
    output.querySelectorAll<HTMLElement>('.terminal-line')[1].style.display = 'none';
    select(output);
    expect((await copy(output)).defaultPrevented).toBe(true);
    expect(writeClipboard).toHaveBeenLastCalledWith('RXalpha\nRXbeta\nRXgamma');
    await openMenu(output);
    await activate('terminalView.contextMenu.copy');
    expect(writeClipboard).toHaveBeenCalledTimes(2);
    expect(writeClipboard).toHaveBeenLastCalledWith('RXalpha\nRXbeta\nRXgamma');
  });

  it.each(['string', 'hex'] as const)('copies selected rendered content in %s mode, not a second buffer formatter', async format => {
    const output = await mount(format);
    const content = output.querySelector<HTMLElement>('.terminal-content')!;
    const expected = format === 'hex' ? '61 6C 70 68 61' : 'alpha';
    select(content);
    await copy(output);
    expect(writeClipboard).toHaveBeenLastCalledWith(expected);
    await openMenu(content);
    await activate('terminal.context.copyVisible');
    expect(writeClipboard).toHaveBeenCalledTimes(2);
    expect(writeClipboard).toHaveBeenLastCalledWith(expected);
  });

  it('does not copy another view selection through either entry', async () => {
    const output = await mount();
    const other = document.createElement('div');
    other.textContent = 'another view';
    document.body.append(other);
    select(other);
    expect((await copy(output)).defaultPrevented).toBe(false);
    await openMenu(output);
    await activate('terminalView.contextMenu.copy');
    expect(writeClipboard).not.toHaveBeenCalled();
  });

  it('reports keyboard-copy rejection just like the context-menu actions', async () => {
    const output = await mount();
    const failed = new Error('clipboard failed');
    writeClipboard.mockRejectedValue(failed);
    select(output.querySelector<HTMLElement>('.terminal-content')!);
    await copy(output);
    expect(notifyError).toHaveBeenCalledExactlyOnceWith(failed);
  });
});
