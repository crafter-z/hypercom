import React, { useRef, useEffect, useCallback, useState } from 'react';
import type { TerminalState } from '../../types';
import ContextMenu, { type ContextMenuEntry } from '../shared/ContextMenu';
import { applyHighlightSets } from '../../utils/highlightEngine';
import { useAppStore } from '../../stores/useAppStore';
import { useVirtualizer } from '@tanstack/react-virtual';
import { save } from '@tauri-apps/plugin-dialog';
import { logService } from '../../services/tauri';

interface TerminalViewProps {
  portId: string;
  terminal: TerminalState | undefined;
}

function hexToString(hex: string): string {
  const bytes = hex.trim().split(/\s+/);
  return bytes.map(b => {
    const code = parseInt(b, 16);
    return isNaN(code) ? '?' : String.fromCharCode(code);
  }).join('');
}

function stringToHex(str: string): string {
  return Array.from(str).map(c => c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function exportTimestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

const TerminalView: React.FC<TerminalViewProps> = ({ portId, terminal }) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; items: ContextMenuEntry[] } | null>(null);
  const lines = terminal?.lines ?? [];
  const highlightRuleSets = useAppStore((s) => s.highlightRuleSets);
  const setTerminalConfig = useAppStore((s) => s.setTerminalConfig);
  const autoScrollRef = useRef(true);

  // Keep a stable ref to the latest lines array so virtualizer callbacks
  // (getScrollElement, estimateSize, getItemKey) have stable identities
  // across renders. Without this, each new function reference causes
  // useVirtualizer's internal memos (getMeasurementOptions) to detect a
  // dep change → onChange → notify() → rerender() DURING render → infinite loop.
  const linesRef = useRef(lines);
  linesRef.current = lines;

  // Sync store's scrollLocked to local ref (for OperationPanel toggle)
  useEffect(() => {
    if (terminal?.scrollLocked !== undefined) {
      autoScrollRef.current = terminal.scrollLocked;
    }
  }, [terminal?.scrollLocked]);

  // Stabilize virtualizer callbacks: closures over refs so function identity
  // is stable (empty dep array). The refs are kept current on every render.
  const getScrollElement = useCallback(() => scrollRef.current, []);
  const estimateSize = useCallback(() => 22, []);
  const getItemKey = useCallback((index: number) => linesRef.current[index]?.id ?? index, []);

  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement,
    estimateSize,
    overscan: 12,
    getItemKey,
    useFlushSync: false,         // Prevent flushSync → synchronous render cascades
  });

  // Auto-scroll to bottom when new lines arrive
  useEffect(() => {
    if (autoScrollRef.current && lines.length > 0) {
      virtualizer.scrollToIndex(lines.length - 1, { align: 'end', behavior: 'auto' });
    }
  }, [lines.length, virtualizer]);

  // Ctrl+Scroll to adjust font size
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const store = useAppStore.getState();
    const current = store.config.terminalFontSize;
    const delta = e.deltaY > 0 ? -1 : 1;
    const next = Math.max(8, Math.min(48, current + delta));
    if (next !== current) {
      document.documentElement.style.setProperty('--font-size-terminal', `${next}px`);
      store.setConfig({ terminalFontSize: next });
    }
  }, []);

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const el = scrollRef.current;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
    if (atBottom !== autoScrollRef.current) {
      autoScrollRef.current = atBottom;
      if (portId && terminal) {
        setTerminalConfig(portId, { scrollLocked: atBottom });
      }
    }
  }, [portId, terminal, setTerminalConfig]);

  const handleSelectAll = useCallback(() => {
    const sel = window.getSelection();
    if (sel && scrollRef.current) {
      const range = document.createRange();
      range.selectNodeContents(scrollRef.current);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }, []);

  const handleCopy = useCallback(() => {
    const sel = window.getSelection();
    if (sel && sel.toString()) {
      navigator.clipboard.writeText(sel.toString());
    }
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const currentLines = useAppStore.getState().terminals[portId]?.lines ?? [];
    const items: ContextMenuEntry[] = [
      { label: '全选', onClick: handleSelectAll },
      { label: '复制', onClick: handleCopy },
      { type: 'separator' },
      { label: '复制为 HEX', onClick: () => {
        const sel = window.getSelection();
        if (sel && sel.toString()) navigator.clipboard.writeText(stringToHex(sel.toString()));
      }},
      { label: '从 HEX 转文本', onClick: () => {
        const sel = window.getSelection();
        if (sel && sel.toString()) navigator.clipboard.writeText(hexToString(sel.toString()));
      }},
      { type: 'separator' },
      { label: '导出为 TXT', onClick: async () => {
        const text = currentLines.map(l => `[${formatTimestamp(l.timestamp)}] ${l.direction} ${l.content}`).join('\n');
        const filePath = await save({
          title: '导出为 TXT',
          defaultPath: `${portId}-${exportTimestamp()}.txt`,
          filters: [{ name: 'Text', extensions: ['txt'] }],
        });
        if (filePath === null) return;
        try {
          await logService.exportTerminalLog(filePath, text);
        } catch (e) {
          console.error('Failed to export TXT:', e);
        }
      }},
      { label: '导出为 CSV', onClick: async () => {
        const csv = 'timestamp,direction,content\n' + currentLines.map(l =>
          `"${formatTimestamp(l.timestamp)}","${l.direction}","${l.content.replace(/"/g, '""')}"`
        ).join('\n');
        const filePath = await save({
          title: '导出为 CSV',
          defaultPath: `${portId}-${exportTimestamp()}.csv`,
          filters: [{ name: 'CSV', extensions: ['csv'] }],
        });
        if (filePath === null) return;
        try {
          await logService.exportTerminalLog(filePath, csv);
        } catch (e) {
          console.error('Failed to export CSV:', e);
        }
      }},
    ];
    setContextMenu({ x: e.clientX, y: e.clientY, items });
  }, [handleSelectAll, handleCopy, portId]);

  const directionColor = (dir: string) => {
    if (dir === 'TX') return 'var(--terminal-tx-color)';
    return 'var(--terminal-rx-color)';
  };

  return (
    <div className="terminal-view-container">
      <div
        ref={scrollRef}
        className="terminal-view"
        onContextMenu={handleContextMenu}
        onScroll={handleScroll}
        onWheel={handleWheel}
      >
        <div style={{ height: `${virtualizer.getTotalSize()}px`, width: '100%', position: 'relative' }}>
          {virtualizer.getVirtualItems().map((vRow) => {
            const line = lines[vRow.index];
            const displayText = terminal?.displayFormat === 'hex' && line.rawData
              ? line.rawData.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')
              : line.content;
            return (
              <div
                key={vRow.key}
                data-index={vRow.index}
                ref={virtualizer.measureElement}
                className="terminal-line"
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${vRow.start}px)`,
                }}
              >
                {terminal?.showTimestamp !== false && (
                  <span className="terminal-timestamp">{formatTimestamp(line.timestamp)}</span>
                )}
                <span
                  className="terminal-direction"
                  style={{ color: directionColor(line.direction) }}
                >
                  {line.direction}
                </span>
                <span className="terminal-content"
                  dangerouslySetInnerHTML={{
                    __html: applyHighlightSets(displayText, highlightRuleSets)
                  }}
                />
              </div>
            );
          })}
        </div>
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
};

export default TerminalView;
