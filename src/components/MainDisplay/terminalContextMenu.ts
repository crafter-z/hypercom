/**
 * Terminal right-click menu factory (pure — no React, no store access).
 *
 * Builds the ContextMenuEntry[] for TerminalView: clipboard actions for the
 * resolved selection range, HEX <-> text conversions of the browser
 * selection, and TXT/CSV exports written to real files via the save()
 * dialog + Rust `std::fs::write` (logService.exportTerminalLog).
 *
 * Receives exactly the data + callbacks it needs as arguments so it stays
 * unit-testable and free of component coupling.
 */
import type { TFunction } from 'i18next';
import { save } from '@tauri-apps/plugin-dialog';
import { logService } from '../../services/tauri';
import { hexToString, stringToHex } from '../../utils/hexUtils';
import { formatTerminalTimestamp } from '../../utils/timeFormat';
import { formatLineForCopy } from './terminalSearch';
import { notifyError } from '../../stores/useToastStore';
import type { ContextMenuEntry } from '../shared/ContextMenu';
import type { TerminalLine, TimestampFormat } from '../../types';

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
  t: TFunction;
  /** Select-all needs the scroll container ref, so it stays a callback. */
  onSelectAll: () => void;
}

export function buildTerminalContextMenuItems(
  data: TerminalContextMenuData
): ContextMenuEntry[] {
  const {
    portId, lines, range, timestampMode, isFirstInRound,
    connectedAt, timestampFormat, t, onSelectAll,
  } = data;

  // Timestamp cell for a given line index, honoring per-round muting.
  const lineTimestamp = (idx: number): string =>
    timestampMode === 'perRound' && idx > 0 && !isFirstInRound(idx)
      ? '-'
      : formatTerminalTimestamp(lines, idx, connectedAt, timestampFormat);

  const copySelected = () => {
    if (!range) return;
    const text = lines.slice(range.start, range.end + 1).map(formatLineForCopy).join('\n');
    if (text) navigator.clipboard.writeText(text);
  };

  const copyAll = () => {
    const text = lines.map(formatLineForCopy).join('\n');
    if (text) navigator.clipboard.writeText(text);
  };

  const copyBrowserSelection = () => {
    const sel = window.getSelection();
    if (sel && sel.toString()) navigator.clipboard.writeText(sel.toString());
  };

  const exportLines = async (ext: 'txt' | 'csv') => {
    const body = ext === 'txt'
      ? lines.map((l, idx) => `[${lineTimestamp(idx)}] ${l.direction} ${l.content}`).join('\n')
      : 'timestamp,direction,content\n' + lines.map((l, idx) =>
          `"${lineTimestamp(idx)}","${l.direction}","${l.content.replace(/"/g, '""')}"`
        ).join('\n');
    const filePath = await save({
      title: t(ext === 'txt' ? 'terminalView.saveDialog.title.txt' : 'terminalView.saveDialog.title.csv'),
      defaultPath: `${portId}-${exportTimestamp()}.${ext}`,
      filters: ext === 'txt'
        ? [{ name: t('terminalView.saveDialog.filterName'), extensions: ['txt'] }]
        : [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (filePath === null) return;
    try {
      await logService.exportTerminalLog(filePath, body);
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
      const sel = window.getSelection();
      if (sel && sel.toString()) navigator.clipboard.writeText(stringToHex(sel.toString()));
    }},
    { label: t('terminalView.contextMenu.hexToText'), onClick: () => {
      const sel = window.getSelection();
      if (sel && sel.toString()) navigator.clipboard.writeText(hexToString(sel.toString()));
    }},
    { type: 'separator' },
    { label: t('terminalView.contextMenu.exportTxt'), onClick: () => { void exportLines('txt'); } },
    { label: t('terminalView.contextMenu.exportCsv'), onClick: () => { void exportLines('csv'); } },
  ];
}
