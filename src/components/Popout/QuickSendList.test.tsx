// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import QuickSendList from './QuickSendList';
import type { SendCommandSet } from '../../types';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const baseline: SendCommandSet[] = [
  { id: 'set', name: 'First', isLoop: false, loopDelay: 0, repeatCount: 0, commands: [
    { id: 'a', name: 'Alpha', content: 'A', order: 0, delay: 0, type: 'string', appendLineEnding: 'None' },
    { id: 'b', name: 'Beta', content: 'B', order: 1, delay: 0, type: 'string', appendLineEnding: 'None' },
  ] },
  { id: 'other', name: 'Other', isLoop: false, loopDelay: 0, repeatCount: 0, commands: [] },
];
let container: HTMLDivElement;
let root: Root;
let current: SendCommandSet[];
const send = vi.fn();
const save = vi.fn(async () => false);
function Harness() {
  const [sets, setSets] = useState(baseline);
  const [selected, setSelected] = useState('set');
  const [listMode, setListMode] = useState(true);
  current = sets;
  const dirty = JSON.stringify(sets) !== JSON.stringify(baseline);
  return <>
    <button id="mode" onClick={() => setListMode(value => !value)}>mode</button>
    <div hidden={!listMode}><QuickSendList active={listMode} sets={sets} selectedSet={sets.find(set => set.id === selected) ?? sets[0]}
      onSelectSet={setSelected} flashingId={null} onSend={send} onOpenSetEditor={() => {}}
      ready dirty={dirty} dirtyIds={new Set(dirty ? ['set'] : [])} pending={false} saving={false} error={null} canSend
      onReplaceSets={setSets} onSave={save} onDiscard={async () => { setSets(baseline); return true; }} /></div>
  </>;
}
function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
function click(selector: string) { (container.querySelector(selector) as HTMLButtonElement).click(); }
beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root.render(createElement(Harness)); });
});
afterEach(() => { act(() => { root.unmount(); }); container.remove(); });

describe('staged popout command list', () => {
  it('flushes a numeric-only buffer before Save even when the published draft is clean', async () => {
    const delay = container.querySelector<HTMLInputElement>('.quicksend-set-fields input[type="number"]')!;
    act(() => { delay.focus(); type(delay, '500'); });
    expect(current[0].loopDelay).toBe(0);
    const saveButton = container.querySelector<HTMLButtonElement>('.quicksend-draft-actions button')!;
    expect(saveButton.disabled).toBe(false);
    save.mockImplementationOnce(async () => {
      expect(current[0].loopDelay).toBe(500);
      return false;
    });
    await act(async () => { saveButton.click(); });
    expect(save).toHaveBeenCalledOnce();
    expect(current[0].loopDelay).toBe(500);
  });
  it('retains edited fields across set navigation, mode unmount and failed Save', async () => {
    act(() => { click('.quicksend-edit-btn'); });
    act(() => { type(container.querySelector('.quicksend-edit-form textarea') as HTMLTextAreaElement, 'unsaved text'); });
    const selection = container.querySelector('.quicksend-set-select') as HTMLSelectElement;
    act(() => { selection.value = 'other'; selection.dispatchEvent(new Event('change', { bubbles: true })); });
    act(() => { selection.value = 'set'; selection.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(current[0].commands[0].content).toBe('unsaved text');
    act(() => { click('#mode'); });
    act(() => { click('#mode'); });
    expect((container.querySelector('.quicksend-edit-form textarea') as HTMLTextAreaElement).value).toBe('unsaved text');
    await act(async () => { click('.quicksend-draft-actions button'); });
    expect(save).toHaveBeenCalledTimes(1);
    expect((container.querySelector('.quicksend-edit-form textarea') as HTMLTextAreaElement).value).toBe('unsaved text');
  });

  it('suppresses row and keyboard sends immediately after editing, and ignores drag-handle Enter', async () => {
    act(() => { click('.quicksend-row'); });
    expect(send).toHaveBeenCalledTimes(1);
    act(() => { click('.quicksend-edit-btn'); });
    act(() => { type(container.querySelector('.quicksend-edit-form textarea') as HTMLTextAreaElement, 'dirty'); });
    act(() => { click('.quicksend-row'); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(send).toHaveBeenCalledTimes(1);
    await act(async () => { click('.quicksend-draft-actions button:last-child'); });
    const handle = container.querySelector('.quicksend-row .editor-drag-handle') as HTMLButtonElement;
    act(() => { handle.focus(); handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('densely renumbers commands after inserting before the first row and deleting that draft', () => {
    act(() => { click('.quicksend-command-actions button[title="editor.insertAbove"]'); });
    expect(current[0].commands[1].id).toBe('a');
    expect(current[0].commands.map(command => command.order)).toEqual([0, 1, 2]);
    act(() => { click('.quicksend-command-actions button[title="sendCmdEditor.delete"]'); });
    expect(current[0].commands.map(command => command.id)).toEqual(['a', 'b']);
    expect(current[0].commands.map(command => command.order)).toEqual([0, 1]);
  });

  it('stages command delay/type/line-ending and set loop settings without saving', () => {
    act(() => { click('.quicksend-edit-btn'); });
    const name = container.querySelector('.quicksend-edit-form input') as HTMLInputElement;
    act(() => { type(name, 'Renamed'); });
    const delay = container.querySelector<HTMLInputElement>('.quicksend-edit-form input[type="number"]')!;
    act(() => { type(delay, '125'); });
    act(() => { delay.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    const format = container.querySelector('.quicksend-edit-form select[aria-label="quickSend.format"]') as HTMLSelectElement;
    act(() => { format.value = 'hex'; format.dispatchEvent(new Event('change', { bubbles: true })); });
    const ending = container.querySelector('.quicksend-edit-form select[aria-label="quickSend.lineEnding"]') as HTMLSelectElement;
    act(() => { ending.value = '\\r\\n'; ending.dispatchEvent(new Event('change', { bubbles: true })); });
    act(() => { click('.quicksend-set-fields input[type="checkbox"]'); });
    const numbers = container.querySelectorAll<HTMLInputElement>('.quicksend-set-fields input[type="number"]');
    act(() => { type(numbers[0], '500'); });
    act(() => { numbers[0].dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    act(() => { type(numbers[1], '4'); });
    act(() => { numbers[1].dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    expect(current[0]).toMatchObject({ isLoop: true, loopDelay: 500, repeatCount: 4 });
    expect(current[0].commands[0]).toMatchObject({ name: 'Renamed', delay: 125, type: 'hex', appendLineEnding: '\\r\\n' });
    expect(save).not.toHaveBeenCalled();
  });

  it('disables both command and set drag handles while search is active', () => {
    act(() => { type(container.querySelector('.quicksend-search') as HTMLInputElement, 'Alpha'); });
    expect(container.querySelector<HTMLButtonElement>('.quicksend-set-manager .editor-drag-handle')!.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('.quicksend-row .editor-drag-handle')!.disabled).toBe(true);
  });
});
