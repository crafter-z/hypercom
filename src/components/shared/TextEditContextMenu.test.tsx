// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTextEditContextMenu } from './TextEditContextMenu';
import type { ContextMenuEntry } from './ContextMenu';

const writeClipboard = vi.hoisted(() => vi.fn());
const notifyError = vi.hoisted(() => vi.fn());
vi.mock('../../utils/clipboard', () => ({ writeClipboardText: writeClipboard }));
vi.mock('../../stores/useToastStore', () => ({ notifyError }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('./ContextMenu', () => ({
  default: ({ items, onClose }: { items: ContextMenuEntry[]; onClose: () => void }) => (
    <div role="menu">{items.map((item, index) => 'label' in item ? (
      <button key={index} disabled={item.disabled} onClick={() => { item.onClick(); onClose(); }}>{item.label}</button>
    ) : null)}</div>
  ),
}));

let root: Root;
let container: HTMLDivElement;
const execCommand = vi.fn();
function Harness({ controlled = false }: { controlled?: boolean }) {
  const { element } = useTextEditContextMenu();
  const [value, setValue] = useState('alpha beta gamma');
  return <>{controlled && <><input aria-label="controlled" value={value} onChange={e => setValue(e.target.value)} /><output>{value}</output></>}{element}</>;
}

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  writeClipboard.mockReset().mockResolvedValue(undefined);
  notifyError.mockReset();
  execCommand.mockReset().mockReturnValue(false);
  Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  window.getSelection()?.removeAllRanges();
  Reflect.deleteProperty(document, 'execCommand');
});

function field(tag?: 'input'): HTMLInputElement;
function field(tag: 'textarea'): HTMLTextAreaElement;
function field(tag: 'input' | 'textarea' = 'input') {
  const input = document.createElement(tag);
  input.value = 'alpha beta gamma';
  document.body.append(input);
  input.focus();
  input.setSelectionRange(6, 10);
  return input;
}
async function open(target: HTMLElement) {
  await act(async () => { target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
}
function button(command: string) {
  const found = [...container.querySelectorAll('button')].find(item => item.textContent === `contextMenu.${command}`);
  if (!found) throw new Error(`Missing menu command: ${command}`);
  return found;
}
async function activate(command: string) {
  await act(async () => { button(command).click(); });
}

describe('global text-edit clipboard actions', () => {
  it('restores the input selection after menu focus and copies through the shared writer', async () => {
    const input = field();
    await open(input);
    button('copy').focus();
    input.setSelectionRange(0, 0);
    await activate('copy');
    expect(writeClipboard).toHaveBeenCalledExactlyOnceWith('beta');
    expect(execCommand).not.toHaveBeenCalled();
    expect(input.selectionStart).toBe(6);
    expect(input.selectionEnd).toBe(10);
  });

  it('waits for successful writing before cutting and updates controlled input state', async () => {
    await act(async () => root.render(<Harness controlled />));
    const input = container.querySelector('input')!;
    input.focus();
    input.setSelectionRange(6, 10);
    let finish!: () => void;
    writeClipboard.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    await open(input);
    await activate('cut');
    expect(input.value).toBe('alpha beta gamma');
    await act(async () => finish());
    expect(execCommand).toHaveBeenCalledExactlyOnceWith('delete');
    expect(input.value).toBe('alpha  gamma');
    expect(container.querySelector('output')?.textContent).toBe('alpha  gamma');
  });

  it('keeps a failed cut intact and reports failure without an unhandled rejection', async () => {
    const input = field('textarea');
    const failed = new Error('clipboard denied');
    writeClipboard.mockRejectedValue(failed);
    await open(input);
    await activate('cut');
    expect(input.value).toBe('alpha beta gamma');
    expect(execCommand).not.toHaveBeenCalled();
    expect(notifyError).toHaveBeenCalledExactlyOnceWith(failed);
  });

  it.each(['value', 'selection', 'focus', 'disconnect'])('does not delete newer state after an async cut (%s)', async change => {
    const input = field();
    let finish!: () => void;
    writeClipboard.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    await open(input);
    await activate('cut');
    if (change === 'value') input.value = 'new edit';
    if (change === 'selection') input.setSelectionRange(0, 0);
    if (change === 'focus') { const other = field(); other.focus(); }
    if (change === 'disconnect') input.remove();
    await act(async () => finish());
    expect(input.value).toBe(change === 'value' ? 'new edit' : 'alpha beta gamma');
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('copies read-only text but disables destructive commands and password extraction', async () => {
    const input = field();
    input.readOnly = true;
    await open(input);
    expect(button('cut').disabled).toBe(true);
    expect(button('paste').disabled).toBe(true);
    expect(button('copy').disabled).toBe(false);
    await activate('copy');
    input.readOnly = false;
    input.type = 'password';
    input.setSelectionRange(0, 5);
    await open(input);
    expect(button('cut').disabled).toBe(true);
    expect(button('copy').disabled).toBe(true);
    await activate('copy');
    expect(writeClipboard).toHaveBeenCalledTimes(1);
  });

  it('does not call unsupported selection APIs for email/number inputs', async () => {
    const input = field();
    input.type = 'email';
    await open(input);
    expect(button('copy').disabled).toBe(true);
    await activate('selectAll');
    expect(notifyError).not.toHaveBeenCalled();
    input.type = 'number';
    await open(input);
    await activate('selectAll');
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('finds a contentEditable host through nested spans and restores its range', async () => {
    const host = document.createElement('div');
    host.contentEditable = 'true';
    host.setAttribute('contenteditable', 'true');
    host.tabIndex = 0;
    host.innerHTML = '<span>alpha beta</span>';
    document.body.append(host);
    host.focus();
    const text = host.querySelector('span')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 6);
    range.setEnd(text, 10);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    await open(host.querySelector('span')!);
    window.getSelection()?.removeAllRanges();
    await activate('cut');
    expect(writeClipboard).toHaveBeenCalledExactlyOnceWith('beta');
    expect(host.textContent).toBe('alpha ');
    expect(document.activeElement).toBe(host);
  });

  it('handles editable copy events but leaves passwords and component-owned events native', async () => {
    const input = field();
    const event = new Event('copy', { bubbles: true, cancelable: true });
    await act(async () => { input.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(writeClipboard).toHaveBeenCalledExactlyOnceWith('beta');
    input.type = 'password';
    input.setSelectionRange(0, 5);
    const passwordEvent = new Event('copy', { bubbles: true, cancelable: true });
    input.dispatchEvent(passwordEvent);
    expect(passwordEvent.defaultPrevented).toBe(false);
    input.type = 'text';
    input.setSelectionRange(0, 5);
    input.addEventListener('copy', e => e.preventDefault(), { once: true });
    input.dispatchEvent(new Event('copy', { bubbles: true, cancelable: true }));
    expect(writeClipboard).toHaveBeenCalledTimes(1);
  });
});
