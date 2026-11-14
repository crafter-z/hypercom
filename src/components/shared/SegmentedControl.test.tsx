// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SegmentedControl, type SegmentedControlProps } from './SegmentedControl';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const change = vi.fn();
const options = [
  { value: 'trx', label: 'TRX' },
  { value: 'unavailable', label: 'Unavailable', disabled: true },
  { value: 'tty', label: 'TTY' },
] as const;

function render(props: Partial<SegmentedControlProps<string>> = {}) {
  act(() => root.render(createElement(SegmentedControl<string>, {
    value: 'trx', options, onChange: change, 'aria-label': 'Port mode', ...props,
  })));
}
const radios = () => Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
function press(button: HTMLButtonElement, key: string) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  act(() => { button.dispatchEvent(event); });
  return event;
}

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('SegmentedControl', () => {
  it('names its single-selection group and exposes exactly one checked radio and tab stop', () => {
    render();
    expect(container.querySelector('[role="radiogroup"]')?.getAttribute('aria-label')).toBe('Port mode');
    expect(radios().map(button => button.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    expect(radios().map(button => button.tabIndex)).toEqual([0, -1, -1]);
    expect(radios().every(button => button.type === 'button')).toBe(true);
  });

  it('does not clear or notify on reactivation, or submit the surrounding form', () => {
    const submit = vi.fn();
    act(() => root.render(createElement('form', { onSubmit: submit },
      createElement(SegmentedControl, { value: 'trx', options, onChange: change, 'aria-label': 'Port mode' }))));
    act(() => radios()[0].click());
    expect(change).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(radios()[0].getAttribute('aria-checked')).toBe('true');
  });

  it('is controlled: proposes only the next value and reflects an accepted update', () => {
    render();
    act(() => radios()[2].click());
    expect(change).toHaveBeenCalledExactlyOnceWith('tty');
    expect(radios()[0].getAttribute('aria-checked')).toBe('true');
    render({ value: 'tty' });
    expect(radios().map(button => button.tabIndex)).toEqual([-1, -1, 0]);
    expect(radios()[2].classList.contains('active')).toBe(true);
  });

  it.each([
    ['ArrowRight', 0, 2, 'tty'], ['ArrowDown', 0, 2, 'tty'],
    ['ArrowLeft', 0, 2, 'tty'], ['ArrowUp', 2, 0, 'trx'],
    ['Home', 2, 0, 'trx'], ['End', 0, 2, 'tty'],
  ] as const)('moves focus and selection with %s, wrapping and skipping disabled options', (key, from, to, value) => {
    render({ value: from === 0 ? 'trx' : 'tty' });
    radios()[from].focus();
    expect(press(radios()[from], key).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(radios()[to]);
    expect(change).toHaveBeenCalledExactlyOnceWith(value);
  });

  it('keeps a fully disabled group out of the tab order without losing the selection', () => {
    render({ disabled: true });
    expect(radios().every(button => button.disabled && button.tabIndex === -1)).toBe(true);
    act(() => radios()[2].click());
    press(radios()[0], 'ArrowRight');
    expect(change).not.toHaveBeenCalled();
    expect(radios()[0].getAttribute('aria-checked')).toBe('true');
  });

  it('does not intercept Tab or Enter, and a single enabled option never becomes empty', () => {
    render({ options: options.slice(0, 2) });
    expect(press(radios()[0], 'Tab').defaultPrevented).toBe(false);
    expect(press(radios()[0], 'Enter').defaultPrevented).toBe(false);
    press(radios()[0], 'ArrowRight');
    expect(change).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(radios()[0]);
  });

  it('retains the focused DOM node after a controlled keyboard selection', () => {
    function Example() {
      const [value, setValue] = useState('trx');
      return createElement(SegmentedControl, { value, options, onChange: setValue, 'aria-label': 'Port mode' });
    }
    act(() => root.render(createElement(Example)));
    const target = radios()[2];
    press(radios()[0], 'ArrowRight');
    expect(radios()[2]).toBe(target);
    expect(document.activeElement).toBe(target);
    expect(target.getAttribute('aria-checked')).toBe('true');
    expect(target.tabIndex).toBe(0);
  });
});
