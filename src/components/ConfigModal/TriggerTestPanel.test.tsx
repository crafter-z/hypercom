// @vitest-environment jsdom
/**
 * TriggerTestPanel is a render-only preview of the current draft snapshot.
 * These tests intentionally keep the component outside Zustand/Tauri/send hooks:
 * a preview must be able to exercise matching without sending bytes or mutating
 * the committed rule store.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SerialPort, TriggerRule } from '../../types';
import TriggerTestPanel from './TriggerTestPanel';
import PANEL_SOURCE from './TriggerTestPanel.tsx?raw';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({ t: (key: string) => key }),
}));

const rule = (overrides: Partial<TriggerRule> = {}): TriggerRule => ({
  id: 'trigger-error',
  name: 'Error alert',
  pattern: 'ERROR',
  isRegex: false,
  matchType: 'contains',
  actionType: 'alert',
  actionContent: 'device error',
  actionIsHex: false,
  isEnabled: true,
  ...overrides,
});

const port = (): SerialPort => ({
  id: 'COM1',
  name: 'COM1',
  status: 'disconnected',
  type: 'real',
  isHidden: false,
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(overrides: Partial<React.ComponentProps<typeof TriggerTestPanel>> = {}): Promise<void> {
  await act(async () => root.render(createElement(TriggerTestPanel, {
    rules: [rule()],
    ports: [port()],
    ...overrides,
  })));
}

async function changeInput(element: HTMLTextAreaElement | HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    const prototype = element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}

describe('TriggerTestPanel matching preview', () => {
  it('shows a text rule hit from the supplied draft rules', async () => {
    await render();
    const input = container.querySelector<HTMLTextAreaElement>('#trigger-test-input');
    expect(input).not.toBeNull();

    await changeInput(input!, 'RX: ERROR while connecting');

    const result = container.querySelector('.trigger-test-result');
    expect(result).not.toBeNull();
    expect(result?.textContent).toContain('Error alert');
    expect(result?.textContent).toContain('RX: ERROR while connecting');
    expect(result?.textContent).toContain('trigger.actionPreview');
  });

  it('reports invalid HEX input and produces no preview action', async () => {
    const hexRule = rule({ matchType: 'hex', pattern: 'AA' });
    await render({ rules: [hexRule], selectedRule: hexRule });
    const mode = container.querySelector<HTMLSelectElement>('#trigger-test-mode');
    const input = container.querySelector<HTMLTextAreaElement>('#trigger-test-input');
    expect(mode).not.toBeNull();
    expect(input).not.toBeNull();

    // Odd nibble is invalid under the shared strict HEX contract.
    await changeInput(mode!, 'hex');
    await changeInput(input!, 'A');

    expect(container.querySelector('[role="alert"]')?.textContent).toBe('trigger.invalidHexInput');
    expect(container.querySelector('.trigger-test-result')).toBeNull();
    expect(container.textContent).toContain('trigger.enterValidHex');
  });
});

describe('TriggerTestPanel side-effect boundary', () => {
  it('contains no send or committed-store access', () => {
    // The component has no action callback by design. Keep this static guard
    // alongside the render tests so a future refactor cannot accidentally wire
    // preview evaluation into TX or a Zustand runtime setter.
    expect(PANEL_SOURCE).not.toMatch(/\b(?:sendToPort|sendData|send_file|invoke)\b/);
    expect(PANEL_SOURCE).not.toMatch(/\buse(?:Rule|App|Operation)Store\b/);
    expect(PANEL_SOURCE).not.toMatch(/\b(?:onSend|onSave)\b/);
  });

  it('does not call browser network or transport APIs while rendering a hit', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await render();
    const input = container.querySelector<HTMLTextAreaElement>('#trigger-test-input')!;
    await changeInput(input, 'ERROR');

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});


