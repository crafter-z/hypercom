import React, { useRef, useEffect, useCallback, useMemo } from 'react';
import type { TerminalLine, TerminalState } from '../../types';
import ContextMenu, { type ContextMenuEntry } from '../shared/ContextMenu';
import { useState } from 'react';
import { applyHighlightSets } from '../../utils/highlightEngine';
import { useAppStore } from '../../stores/useAppStore';

interface TerminalViewProps {
  portId: string;
  terminal: TerminalState;
}

function generateMockLines(): TerminalLine[] {
  const now = Date.now();
  return [
    { id: '1', timestamp: now - 10000, direction: 'RX', content: 'System start, version: 1.2.3', isHex: false },
    { id: '2', timestamp: now - 9000, direction: 'RX', content: 'Heap size: 520KB, Stack: 8KB', isHex: false },
    { id: '3', timestamp: now - 8000, direction: 'RX', content: 'Temperature high: 65.3°C', isHex: false },
    { id: '4', timestamp: now - 7000, direction: 'RX', content: '41 42 43 44 45 46 47 48 | ABCDEFGH', isHex: true },
    { id: '5', timestamp: now - 6000, direction: 'TX', content: 'AT+PING', isHex: false },
    { id: '6', timestamp: now - 5000, direction: 'RX', content: '+PONG: OK', isHex: false },
    { id: '7', timestamp: now - 4000, direction: 'RX', content: 'Sensor read failed! code=0x02', isHex: false },
    { id: '8', timestamp: now - 3000, direction: 'RX', content: 'Line with keyword ALERT: Battery low!', isHex: false },
    { id: '9', timestamp: now - 2000, direction: 'RX', content: '0A 0D 1B 7F 55 AA 10 20 30 40', isHex: true },
  ];
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

const TerminalView: React.FC<TerminalViewProps> = ({ portId: _portId, terminal }) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; items: ContextMenuEntry[] } | null>(null);
  const mockLines = useMemo(() => generateMockLines(), []);
  const lines = terminal?.lines?.length ? terminal.lines : mockLines;
  const highlightRuleSets = useAppStore((s) => s.highlightRuleSets);

  useEffect(() => {
    if (scrollRef.current && terminal?.scrollLocked !== false) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines.length, terminal?.scrollLocked]);

  const formatTimestamp = (ts: number): string => {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  };

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
    ];
    setContextMenu({ x: e.clientX, y: e.clientY, items });
  }, [handleSelectAll, handleCopy]);

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
      >
        {lines.map((line) => (
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
                __html: applyHighlightSets(line.content, highlightRuleSets)
              }}
            />
          </div>
        ))}
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