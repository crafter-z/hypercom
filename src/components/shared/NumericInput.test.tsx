// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NumericInput } from './NumericInput';

let container: HTMLDivElement;
let root: Root;
let committed: number[];

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  committed = [];
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function render(value: number) {
  act(() => {
    root.render(createElement(NumericInput, { value, min: 8, max: 48, onCommit: (next) => committed.push(next) }));
  });
  return container.querySelector('input') as HTMLInputElement;
}

describe('NumericInput', () => {
  it('keeps an unclamped draft while typing and commits on blur', () => {
    const input = render(14);
    // Simulate select-all + typing "24": the intermediate "2" must stay visible.
    act(() => type(input, '2'));
    expect(input.value).toBe('2');
    act(() => type(input, '24'));
    expect(input.value).toBe('24');
    act(() => {
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(input.value).toBe('24');
    expect(committed).toEqual([24]);
  });

  it('clamps out-of-range input on Enter', () => {
    const input = render(14);
    act(() => type(input, '999'));
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(input.value).toBe('48');
    expect(committed).toEqual([48]);
  });
});
