// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../../stores/useAppStore';
import { useOperationStore } from '../../../stores/useOperationStore';
import { resetStoresForTests } from '../../../stores/resetStores';
import { LINE_ENDING_VALUES } from '../../../utils/sendUtils';
import { LineEndingSelect } from './LineEndingSelect';
import DisplaySettings from '../../ConfigModal/pages/DisplaySettings';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  resetStoresForTests();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('send line-ending choices', () => {
  it('reuses the common values and only changes the live send choice', () => {
    act(() => root.render(createElement(LineEndingSelect)));
    const select = container.querySelector('select')!;
    expect(Array.from(select.options, option => option.value)).toEqual(LINE_ENDING_VALUES);
    expect(select.getAttribute('aria-label')).toBe('quickSend.lineEnding');
    const defaultEnding = useAppStore.getState().config.defaultLineEnding;
    act(() => { select.value = '\\n'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(useOperationStore.getState().sendAppendLineEnding).toBe('\\n');
    expect(useAppStore.getState().config.defaultLineEnding).toBe(defaultEnding);
  });

  it('disables the ignored HEX setting while retaining its text-mode value', () => {
    act(() => {
      useOperationStore.getState().setOpState({ sendAppendLineEnding: '\\r\\n' });
      root.render(createElement(LineEndingSelect));
    });
    const select = container.querySelector('select')!;
    expect(select.disabled).toBe(false);
    act(() => useOperationStore.getState().setOpState({ sendIsHex: true }));
    expect(select.disabled).toBe(true);
    expect(select.value).toBe('\\r\\n');
    expect(useOperationStore.getState().sendAppendLineEnding).toBe('\\r\\n');
    act(() => useOperationStore.getState().setOpState({ sendIsHex: false }));
    expect(select.disabled).toBe(false);
    expect(select.value).toBe('\\r\\n');
  });

  it('associates the settings default label and keeps default editing separate from live sends', () => {
    // A default for future text sends remains editable even if the live composer is HEX.
    useOperationStore.getState().setOpState({ sendIsHex: true, sendAppendLineEnding: '\\r' });
    act(() => root.render(createElement(DisplaySettings)));
    const label = Array.from(container.querySelectorAll('label')).find(item => item.textContent === 'displaySettings.defaultLineEndingLabel')!;
    const select = document.getElementById(label.htmlFor) as HTMLSelectElement;
    expect(select).not.toBeNull();
    expect(select.labels?.[0]).toBe(label);
    expect(select.disabled).toBe(false);
    expect(Array.from(select.options, option => option.value)).toEqual(LINE_ENDING_VALUES);
    act(() => { select.value = 'None'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(useAppStore.getState().config.defaultLineEnding).toBe('None');
    expect(useOperationStore.getState().sendAppendLineEnding).toBe('\\r');
  });
});
