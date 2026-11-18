// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SearchAdvancedOptions, { countAdvancedSearchOptions } from './SearchAdvancedOptions';
import { DEFAULT_SEARCH_SPEC, type SearchSpec } from '../../utils/terminal/search/searchTypes';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../shared/usePluginViewOverlay', () => ({ usePluginViewOverlay: () => true }));
let root: Root, host: HTMLDivElement;
function Harness() {
  const [spec, setSpec] = useState<SearchSpec>({ ...DEFAULT_SEARCH_SPEC, query: 'keep query' });
  return <><SearchAdvancedOptions spec={spec} onChange={setSpec} /><output>{JSON.stringify(spec)}</output></>;
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const trigger = () => host.querySelector<HTMLButtonElement>('.search-advanced-trigger')!;
const panel = () => document.querySelector<HTMLDivElement>('.search-advanced-panel');
const state = () => JSON.parse(host.querySelector('output')!.textContent!) as SearchSpec;

describe('secondary search options', () => {
  it('counts only changed conditions and treats missing direction members as a condition', () => {
    expect(countAdvancedSearchOptions(DEFAULT_SEARCH_SPEC)).toBe(0);
    expect(countAdvancedSearchOptions({ ...DEFAULT_SEARCH_SPEC, mode: 'fuzzy', multiline: true, directions: ['RX'] })).toBe(3);
    expect(countAdvancedSearchOptions({ ...DEFAULT_SEARCH_SPEC, mode: 'hex', caseSensitive: true, wholeWord: true, multiline: true })).toBe(1);
  });
  it('stays collapsed by default, preserves enabled settings when dismissed, and resets without clearing the query', async () => {
    await act(async () => root.render(<Harness />));
    expect(panel()).toBeNull(); expect(trigger().getAttribute('aria-expanded')).toBe('false');
    await act(async () => trigger().click());
    expect(panel()).not.toBeNull();
    await act(async () => panel()!.querySelector<HTMLButtonElement>('[role="radio"]:nth-child(3)')!.click());
    await act(async () => panel()!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[2].click());
    expect(state().mode).toBe('fuzzy'); expect(state().multiline).toBe(true);
    await act(async () => panel()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(panel()).toBeNull(); expect(trigger().querySelector('.search-advanced-count')?.textContent).toBe('2');
    expect(document.activeElement).toBe(trigger());
    await act(async () => trigger().click());
    await act(async () => panel()!.querySelector<HTMLButtonElement>('.search-advanced-reset')!.click());
    expect(state()).toEqual({ ...DEFAULT_SEARCH_SPEC, query: 'keep query' });
    expect(trigger().querySelector('.search-advanced-count')).toBeNull();
  });
  it('traps Tab in the secondary panel and only closes that panel on Escape', async () => {
    await act(async () => root.render(<Harness />)); await act(async () => trigger().click());
    const last = panel()!.querySelector<HTMLButtonElement>('.search-advanced-reset')!;
    last.focus();
    await act(async () => last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(panel()!.querySelector('button'));
    await act(async () => panel()!.querySelector('button')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(panel()).toBeNull(); expect(host.querySelector('output')).not.toBeNull();
  });
});
