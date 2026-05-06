/**
 * 终端显示视图
 * 显示串口输入输出内容，支持语法高亮、右键菜单、编码切换
 * 内容只读，不可修改
 */

import React, { useRef, useEffect } from 'react';
import type { TerminalLine, TerminalState } from '../../types';

interface TerminalViewProps {
  portId: string;
  terminal: TerminalState;
}

// ==================== 模拟数据 ====================
const mockLines: TerminalLine[] = [
  { id: '1', timestamp: Date.now() - 10000, direction: 'RX', content: 'System start, version: 1.2.3', isHex: false },
  { id: '2', timestamp: Date.now() - 9000, direction: 'RX', content: 'Heap size: 520KB, Stack: 8KB', isHex: false },
  { id: '3', timestamp: Date.now() - 8000, direction: 'RX', content: 'Temperature high: 65.3°C', isHex: false },
  { id: '4', timestamp: Date.now() - 7000, direction: 'RX', content: '41 42 43 44 45 46 47 48 | ABCDEFGH', isHex: true },
  { id: '5', timestamp: Date.now() - 6000, direction: 'TX', content: 'AT+PING', isHex: false },
  { id: '6', timestamp: Date.now() - 5000, direction: 'RX', content: '+PONG: OK', isHex: false },
  { id: '7', timestamp: Date.now() - 4000, direction: 'RX', content: 'Sensor read failed! code=0x02', isHex: false },
  { id: '8', timestamp: Date.now() - 3000, direction: 'RX', content: 'Line with keyword ALERT: Battery low!', isHex: false },
  { id: '9', timestamp: Date.now() - 2000, direction: 'RX', content: '0A 0D 1B 7F 55 AA 10 20 30 40', isHex: true },
];

const TerminalView: React.FC<TerminalViewProps> = ({ portId: _portId, terminal }) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const lines = terminal?.lines?.length ? terminal.lines : mockLines;

  // 自动滚动到底部
  useEffect(() => {
    if (scrollRef.current && terminal?.scrollLocked) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines, terminal?.scrollLocked]);

  const formatTimestamp = (ts: number): string => {
    const d = new Date(ts);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}.${d.getMilliseconds().toString().padStart(3, '0')}`;
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    // TODO: 显示右键菜单（全选、复制、HEX转换等）
  };

  return (
    <div
      ref={scrollRef}
      style={{
        flex: 1,
        overflow: 'auto',
        padding: '8px 12px',
        background: 'var(--bg-primary)',
        fontFamily: 'var(--font-terminal)',
        fontSize: 'var(--font-size-terminal)',
        lineHeight: 'var(--line-height-terminal)',
        cursor: 'text',
        userSelect: 'text',
      }}
      onContextMenu={handleContextMenu}
    >
      {lines.map((line) => (
        <div
          key={line.id}
          style={{
            display: 'flex',
            gap: 8,
            padding: '1px 0',
            color: line.direction === 'TX' ? 'var(--text-warning)' : 'var(--text-primary)',
          }}
        >
          {/* 时间戳 */}
          {terminal?.showTimestamp !== false && (
            <span style={{ color: 'var(--text-secondary)', flexShrink: 0, userSelect: 'none' }}>
              {formatTimestamp(line.timestamp)}
            </span>
          )}

          {/* 方向标识 */}
          <span
            style={{
              color: line.direction === 'TX' ? 'var(--text-warning)' : 'var(--text-link)',
              fontWeight: 600,
              flexShrink: 0,
              minWidth: 24,
              userSelect: 'none',
            }}
          >
            {line.direction}
          </span>

          {/* 内容 */}
          <span style={{ wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>
            {line.content}
          </span>
        </div>
      ))}

      {/* 底部占位，确保滚动空间 */}
      <div style={{ height: 8 }} />
    </div>
  );
};

export default TerminalView;
