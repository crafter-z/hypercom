// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';
import { buildTerminalContextMenuItems, selectionText, type TerminalContextMenuData } from './terminalContextMenu';
import type { ContextMenuItem } from '../shared/ContextMenu';

const clipboardWrite = vi.hoisted(() => vi.fn());
const notifyError = vi.hoisted(() => vi.fn());
vi.mock('../../utils/clipboard', () => ({ writeClipboardText: clipboardWrite }));
vi.mock('../../stores/useToastStore', () => ({ notifyError }));
vi.mock('../../services/tauri', () => ({ fileService: { pickTextFileAndWrite: vi.fn() } }));

const menuData: TerminalContextMenuData = {
  portId: 'COM1',
  lines: [{ timestamp: 1, direction: 'RX', content: 'buffer line', isHex: false }],
  range: { start: 0, end: 0 }, timestampMode: 'perLine',
  isFirstInRound: () => true, connectedAt: null, timestampFormat: 'absolute',
  t: ((key: string) => key) as TFunction, onSelectAll: () => undefined,
};
function items(data: Partial<TerminalContextMenuData> = {}) {
  return buildTerminalContextMenuItems({ ...menuData, ...data }).filter((item): item is ContextMenuItem => 'label' in item);
}
function select(root: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(root);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

beforeEach(() => {
  clipboardWrite.mockReset().mockResolvedValue(undefined);
  notifyError.mockReset();
});
afterEach(() => { document.body.replaceChildren(); window.getSelection()?.removeAllRanges(); });

describe('terminal selection copying', () => {
  it('retains hidden pinned rows and block boundaries instead of concatenating lines', () => {
    const root = document.createElement('div');
    root.innerHTML = '<div class="terminal-line">first</div><div class="terminal-line" style="display:none">parked</div><div class="terminal-line">last</div>';
    document.body.append(root);
    select(root);
    expect(selectionText(root)).toBe('first\nparked\nlast');
    const other = document.createElement('div');
    document.body.append(other);
    expect(selectionText(other)).toBe('');
  });

  it('copies the menu-open snapshot after menu focus replaces the document selection', () => {
    const root = document.createElement('div');
    root.textContent = 'selected before menu';
    document.body.append(root);
    select(root);
    const menu = items();
    window.getSelection()?.removeAllRanges();
    menu.find(item => item.label === 'terminalView.contextMenu.copy')!.onClick();
    expect(clipboardWrite).toHaveBeenCalledExactlyOnceWith('selected before menu');
  });

  it('uses the explicit snapshot for copy and conversions without re-reading later selections', () => {
    const menu = items({ browserSelectionText: '41 42' });
    menu.find(item => item.label === 'terminalView.contextMenu.hexToText')!.onClick();
    expect(clipboardWrite).toHaveBeenLastCalledWith('AB');
    menu.find(item => item.label === 'terminal.context.copyVisible')!.onClick();
    expect(clipboardWrite).toHaveBeenLastCalledWith('41 42');
  });

  it('honors an explicitly empty snapshot even when another view has a selection', () => {
    const root = document.createElement('div');
    root.textContent = 'other view';
    document.body.append(root);
    select(root);
    const menu = items({ browserSelectionText: '' });
    menu.find(item => item.label === 'terminalView.contextMenu.copy')!.onClick();
    expect(clipboardWrite).not.toHaveBeenCalled();
  });

  it('reports rejected writes for every copy action without unhandled rejections', async () => {
    const failed = new Error('clipboard write failed');
    clipboardWrite.mockRejectedValue(failed);
    const menu = items({ browserSelectionText: '41 42' });
    const labels = ['terminal.context.copySelectedLines', 'terminal.context.copyVisible', 'terminal.context.copyAll',
      'terminalView.contextMenu.copy', 'terminalView.contextMenu.copyAsHex', 'terminalView.contextMenu.hexToText'];
    for (const label of labels) menu.find(item => item.label === label)!.onClick();
    await Promise.resolve();
    expect(notifyError).toHaveBeenCalledTimes(labels.length);
    expect(notifyError).toHaveBeenLastCalledWith(failed);
  });
});
