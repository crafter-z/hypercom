/**
 * Terminal right-click menu factory (pure — no React, no store access).
 *
 * Builds the ContextMenuEntry[] for TerminalView: clipboard actions for the
 * resolved selection range, HEX <-> text conversions of the browser
 * selection, and TXT/CSV exports written to real files via the save()
 * host-owned save dialog + Rust `pick_text_file_and_write`.
 *
 * Receives exactly the data + callbacks it needs as arguments so it stays
 * unit-testable and free of component coupling.
 */
import type { TFunction } from 'i18next';
import { fileService } from '../../services/tauri';
import { hexToString, stringToHex } from '../../utils/hexUtils';
import { formatTerminalTimestamp } from '../../utils/timeFormat';
import { formatLineForCopy } from '../../utils/terminalSearch';
import { getLineText } from '../../utils/lineText';
import { notifyError } from '../../stores/useToastStore';
import { writeClipboardText } from '../../utils/clipboard';
import type { ContextMenuEntry } from '../shared/ContextMenu';
import type { Encoding, TerminalLine, TimestampFormat } from '../../types';

/** File-name timestamp: YYYYMMDD-HHmmss (matches the export defaultPath). */
function exportTimestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export interface TerminalContextMenuData {
  portId: string;
  /** Live line buffer (read from the store at menu-build time). */
  lines: TerminalLine[];
  /** Resolved copy range; null disables "copy selected lines". */
  range: { start: number; end: number } | null;
  timestampMode: 'perLine' | 'perRound';
  /** On-demand first-in-round check (O(1) per line); entries muted to '-' when not first in round. */
  isFirstInRound: (idx: number) => boolean;
  connectedAt: number | null;
  timestampFormat: TimestampFormat;
  /** Current encoding — lazily decodes RX lines without `content` (issue #14). */
  encoding?: Encoding | string;
  t: TFunction;
  /** Select-all needs the scroll container ref, so it stays a callback. */
  onSelectAll: () => void;
  /** Captured before opening/focusing the menu; empty means no selection. */
  browserSelectionText?: string;
}

/**
 * Selection text that ignores layout visibility.
 *
 * `Selection.toString()` walks the LAYOUT — content inside display:none
 * (rows the renderer parks while their selection is pinned, issue #18)
 * is omitted, so copying a selection whose rows scrolled out of the
 * viewport would yield ''. Cloning each range's subtree instead copies
 * every text node the Range anchors, parked or not. Line boundaries are
 * preserved because each row is a block-level div.
 */
export function selectionText(root?: HTMLElement): string {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return '';
  const parts: string[] = [];
  for (let i = 0; i < sel.rangeCount; i++) {
    const r = sel.getRangeAt(i);
    if (r.collapsed || (root && (!root.contains(r.startContainer) || !root.contains(r.endContainer)))) continue;
    const div = document.createElement('div');
    div.appendChild(r.cloneContents());
    // Clone textContent includes parked rows even when their live nodes are
    // display:none; unlike Selection.toString it does not add block line
    // breaks itself.
    const rows = div.querySelectorAll('.terminal-line');
    rows.forEach((row, index) => { if (index < rows.length - 1) row.append('\n'); });
    div.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
    const text = div.textContent ?? '';
    if (text) parts.push(text);
  }
  return parts.join('\n');
}

export function buildTerminalContextMenuItems(
  data: TerminalContextMenuData
): ContextMenuEntry[] {
  const {
    portId, lines, range, timestampMode, isFirstInRound,
    connectedAt, timestampFormat, encoding, t, onSelectAll,
  } = data;
  // Capture once, before ContextMenu moves focus; callbacks must not read a
  // possibly collapsed/replaced document selection at activation time.
  const browserSelectionText = data.browserSelectionText ?? selectionText();

  // Timestamp cell for a given line index, honoring per-round muting.
  const lineTimestamp = (idx: number): string =>
    timestampMode === 'perRound' && idx > 0 && !isFirstInRound(idx)
      ? '-'
      : formatTerminalTimestamp(lines, idx, connectedAt, timestampFormat);

  const copySelected = () => {
    if (!range) return;
    const text = lines.slice(range.start, range.end + 1).map((l) => formatLineForCopy(l, encoding)).join('\n');
    if (text) void writeClipboardText(text).catch(notifyError);
  };

  const copyAll = () => {
    const text = lines.map((l) => formatLineForCopy(l, encoding)).join('\n');
    if (text) void writeClipboardText(text).catch(notifyError);
  };

  // issue #18: Chromium's Selection.toString() serializes by LAYOUT
  // visibility — rows the renderer parks (display:none, selection pinned)
  // drop out of it. Range.cloneContents() is a pure tree clone and keeps
  // parked rows' text, so copy what the Range anchors, not what is visible.
  const copyBrowserSelection = () => {
    const text = browserSelectionText;
    if (text) void writeClipboardText(text).catch(notifyError);
  };

  const exportLines = async (ext: 'txt' | 'csv') => {
    const enc = encoding ?? 'UTF-8';
    const body = ext === 'txt'
      ? lines.map((l, idx) => `[${lineTimestamp(idx)}] ${l.direction} ${getLineText(l, enc)}`).join('\n')
      : 'timestamp,direction,content\n' + lines.map((l, idx) =>
          `"${lineTimestamp(idx)}","${l.direction}","${getLineText(l, enc).replace(/"/g, '""')}"`
        ).join('\n');
    try {
      const saved = await fileService.pickTextFileAndWrite(body, {
        title: t(ext === 'txt' ? 'terminalView.saveDialog.title.txt' : 'terminalView.saveDialog.title.csv'),
        defaultFileName: `${portId}-${exportTimestamp()}.${ext}`,
        filters: ext === 'txt'
          ? [{ name: t('terminalView.saveDialog.filterName'), extensions: ['txt'] }]
          : [{ name: 'CSV', extensions: ['csv'] }],
      });
      if (saved === null) return;
    } catch (err) {
      console.error(`Failed to export ${ext.toUpperCase()}:`, err);
      notifyError(err);
    }
  };

  return [
    { label: t('terminal.context.copySelectedLines'), onClick: copySelected, disabled: range === null },
    { label: t('terminal.context.copyVisible'), onClick: copyBrowserSelection },
    { label: t('terminal.context.copyAll'), onClick: copyAll, disabled: lines.length === 0 },
    { type: 'separator' },
    { label: t('terminalView.contextMenu.selectAll'), onClick: onSelectAll },
    { label: t('terminalView.contextMenu.copy'), onClick: copyBrowserSelection },
    { type: 'separator' },
    { label: t('terminalView.contextMenu.copyAsHex'), onClick: () => {
      const text = browserSelectionText;
      if (text) void writeClipboardText(stringToHex(text)).catch(notifyError);
    }},
    { label: t('terminalView.contextMenu.hexToText'), onClick: () => {
      const text = browserSelectionText;
      if (text) void writeClipboardText(hexToString(text)).catch(notifyError);
    }},
    { type: 'separator' },
    { label: t('terminalView.contextMenu.exportTxt'), onClick: () => { void exportLines('txt'); } },
    { label: t('terminalView.contextMenu.exportCsv'), onClick: () => { void exportLines('csv'); } },
  ];
}
