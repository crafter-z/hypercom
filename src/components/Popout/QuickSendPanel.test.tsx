// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import QuickSendPanel from './QuickSendPanel';
import type { TextSendConfig } from '../../types';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../services/tauri', () => ({ popoutEventService: { emitSendCommand: vi.fn() } }));
vi.mock('./usePopoutSync', () => ({ usePopoutSync: () => ({
  sets: [], activePortId: 'COM1', ports: [{ id: 'COM1', name: 'COM1' }], connectedPortIds: new Set(['COM1']),
  dirtyIds: new Set(), ready: true, dirty: false, pending: false, saving: false, error: null,
}) }));
vi.mock('./usePanelTextConfig', async () => {
  const { useState } = await import('react');
  return { usePanelTextConfig: () => {
    const [config, setConfig] = useState<TextSendConfig>({ portId: '', lineEnding: '\\r\\n', isHex: false, sendIntervalMs: 1, roundIntervalMs: 0 });
    return { config, patchConfig: (patch: Partial<TextSendConfig>) => setConfig(current => ({ ...current, ...patch })) };
  } };
});
vi.mock('./QuickSendList', () => ({ default: () => null }));
vi.mock('./QuickSendText', () => ({ default: () => null }));

let root: Root;
let host: HTMLDivElement;
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<QuickSendPanel />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const ending = () => host.querySelector<HTMLSelectElement>('[aria-label="quickSend.lineEnding"]')!;
const formats = () => host.querySelectorAll<HTMLButtonElement>('[role="radiogroup"][aria-label="quickSend.format"] [role="radio"]');

describe('popout send options use shared semantics', () => {
  it('disables ineffective HEX line endings without losing the text-mode preference', async () => {
    expect(ending().disabled).toBe(false);
    expect(ending().value).toBe('\\r\\n');
    await act(async () => formats()[1].click());
    expect(ending().disabled).toBe(true);
    expect(ending().value).toBe('\\r\\n');
    expect(host.querySelector('.quicksend-target-meta')?.textContent?.trim()).toBe('HEX');
    await act(async () => formats()[0].click());
    expect(ending().disabled).toBe(false);
    expect(ending().value).toBe('\\r\\n');
    expect(host.querySelector('.quicksend-target-meta')?.textContent).toContain('sendSection.lineEnding.crlf');
  });

  it('uses the same radio keyboard contract as the main-window mode control', async () => {
    formats()[0].focus();
    const event = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
    await act(async () => formats()[0].dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(formats()[1].getAttribute('aria-checked')).toBe('true');
    expect(formats()[1].tabIndex).toBe(0);
    expect(document.activeElement).toBe(formats()[1]);
    await act(async () => formats()[1].click());
    expect(formats()[1].getAttribute('aria-checked')).toBe('true');
  });
});
