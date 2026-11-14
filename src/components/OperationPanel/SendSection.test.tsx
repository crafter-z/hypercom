// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStoresForTests } from '../../stores/resetStores';
import { useOperationStore } from '../../stores/useOperationStore';
import type { SendHistoryEntry } from '../../types';
import SendSection from './SendSection';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('./components/QuickSendStrip', () => ({
  QuickSendStrip: () => createElement('div', { className: 'op-quick-send-row' }),
}));
vi.mock('./components/SendFileControls', () => ({
  SendFileButton: () => null,
  FileSendProgress: () => null,
}));
vi.mock('./hooks/useFileSend', () => ({
  useFileSend: () => ({ progress: null, startFileSend: vi.fn(), cancelFileSend: vi.fn() }),
}));
vi.mock('../../utils/commandExecution', () => ({ executeQuickCommand: vi.fn() }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
const history = (): SendHistoryEntry | null => null;

beforeEach(() => {
  resetStoresForTests();
  useOperationStore.getState().setOpState({ sendInput: '41', sendIsHex: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('SendSection HEX layout', () => {
  it('does not add a no-line-ending hint row in HEX mode', () => {
    act(() => root.render(createElement(SendSection, {
      activePortId: null,
      isPortActive: false,
      isConnected: false,
      sendData: vi.fn(async () => 0),
      historyUp: history,
      historyDown: history,
    })));

    expect(container.querySelector('.op-send-hex-suffix')).toBeNull();
    expect(container.querySelector<HTMLSelectElement>('.op-line-ending-select')?.disabled).toBe(true);
  });
});

export {};
