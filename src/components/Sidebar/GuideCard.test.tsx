// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GuideCard from './GuideCard';

const overlay = vi.hoisted(() => ({ ready: false }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../shared/usePluginViewOverlay', () => ({ usePluginViewOverlay: () => overlay.ready }));
let host: HTMLDivElement;
let root: Root;
const props = { onEnableSimulation: () => {}, simulationAvailable: true };
beforeEach(() => {
  overlay.ready = false;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe('quick-start dialog shares modal lifecycle', () => {
  it('waits for native-view suppression, traps focus and restores the trigger on Escape', async () => {
    await act(async () => root.render(<GuideCard {...props} />));
    const trigger = host.querySelector<HTMLButtonElement>('.guide-card-quickstart-link')!;
    trigger.focus();
    await act(async () => trigger.click());
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    overlay.ready = true;
    await act(async () => root.render(<GuideCard {...props} />));
    const close = host.querySelector<HTMLButtonElement>('.guide-quickstart-footer button')!;
    expect(document.activeElement).toBe(close);
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    await act(async () => close.dispatchEvent(tab));
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(close);
    await act(async () => close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
