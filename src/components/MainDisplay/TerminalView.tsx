import React, { useRef, useEffect, useCallback } from 'react';
import type { TerminalState } from '../../types';
import ContextMenu, { type ContextMenuEntry } from '../shared/ContextMenu';
import { useState } from 'react';
import { applyHighlightSets } from '../../utils/highlightEngine';
import { useAppStore } from '../../stores/useAppStore';

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

const TerminalView: React.FC<TerminalViewProps> = ({ portId, terminal }) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; items: ContextMenuEntry[] } | null>(null);
  const lines = terminal?.lines ?? [];
  const highlightRuleSets = useAppStore((s) => s.highlightRuleSets);
  const setTerminalConfig = useAppStore((s) => s.setTerminalConfig);
  const autoScrollRef = useRef(true);

  // Sync store's scrollLocked to local ref (for OperationPanel toggle)
  useEffect(() => {
    if (terminal?.scrollLocked !== undefined) {
      autoScrollRef.current = terminal.scrollLocked;
    }
  }, [terminal?.scrollLocked]);

  useEffect(() => {
    if (scrollRef.current && autoScrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines.length]);

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
      { label: '导出为 TXT', onClick: () => {
        const text = currentLines.map(l => `[${formatTimestamp(l.timestamp)}] ${l.direction} ${l.content}`).join('\n');
        navigator.clipboard.writeText(text);
      }},
      { label: '导出为 CSV', onClick: () => {
        const csv = 'timestamp,direction,content\n' + currentLines.map(l =>
          `"${formatTimestamp(l.timestamp)}","${l.direction}","${l.content.replace(/"/g, '""')}"`
        ).join('\n');
        navigator.clipboard.writeText(csv);
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
        {lines.map((line) => {
          const displayText = terminal?.displayFormat === 'hex' && line.rawData
            ? line.rawData.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')
            : line.content;
          return (
          <div
            key={line.id}
            className="terminal-line"
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
        )})}
        <div style={{ height: 8 }} />
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