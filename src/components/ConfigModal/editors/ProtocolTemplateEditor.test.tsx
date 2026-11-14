// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProtocolTemplate } from '../../../types';
import ProtocolTemplateEditor from './ProtocolTemplateEditor';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
const change = vi.fn();
const remove = vi.fn();
const template: ProtocolTemplate = {
  id: 'protocol-1', name: 'Custom', isEnabled: true,
  headerBytes: 'AA 55', lengthFieldOffset: 2, lengthFieldSize: 2, lengthEndian: 'big', lengthAdjust: 2,
  checksumAlgorithm: 'crc8', checksumOffset: 0, footerBytes: '0D 0A',
  colorHeader: '#4fc3f7', colorLength: '#ce9178', colorPayload: '#dcdcaa', colorChecksum: '#b5cea8', colorFooter: '#6a9955',
};

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root.render(createElement(ProtocolTemplateEditor, { template, onChange: change, onDelete: remove })); });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('protocol structure summary', () => {
  it('renders one truthful segment for each configured frame field', () => {
    const segments = container.querySelectorAll('.protocol-structure-summary__segment');
    expect(segments).toHaveLength(5);
    expect(container.textContent).toContain('AA 55');
    expect(container.textContent).toContain('0D 0A');
    expect(container.textContent).toContain('2 · protocolEditor.lengthFieldSize.2bytes · protocolEditor.lengthEndian.big');
    expect(container.textContent).toContain('protocolEditor.payloadSummary');
    expect(container.textContent).toContain('CRC-8');
  });

  it('lets keyboard-activatable summary buttons locate their form fields', () => {
    const segments = container.querySelectorAll<HTMLButtonElement>('.protocol-structure-summary__segment');
    act(() => { segments[0].click(); });
    expect(document.activeElement?.id).toBe('protocol-header-protocol-1');
    act(() => { segments[2].click(); });
    expect(document.activeElement?.id).toBe('protocol-length-offset-protocol-1');
    act(() => { segments[3].click(); });
    expect(document.activeElement?.id).toBe('protocol-checksum-algorithm-protocol-1');
    act(() => { segments[4].click(); });
    expect(document.activeElement?.id).toBe('protocol-footer-protocol-1');
  });
});
