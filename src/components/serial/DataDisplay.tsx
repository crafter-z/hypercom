import { useRef, useEffect } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Trash2 } from 'lucide-react';
import { useSerialStore } from '../../stores';
import { formatTimestamp, cn } from '../../utils';

export function DataDisplay() {
  const { receivedData, clearData, status } = useSerialStore();
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: receivedData.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 24,
    overscan: 10,
  });

  // 自动滚动到底部
  useEffect(() => {
    if (parentRef.current && receivedData.length > 0) {
      virtualizer.scrollToIndex(receivedData.length - 1, { align: 'end' });
    }
  }, [receivedData.length, virtualizer]);

  const items = virtualizer.getVirtualItems();

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* 工具栏 */}
      <div className="h-10 px-4 flex items-center justify-between border-b border-border">
        <span className="text-sm text-muted-foreground">
          数据记录 ({receivedData.length})
        </span>
        <button
          onClick={clearData}
          className="h-7 px-2 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <Trash2 className="w-4 h-4" />
          清空
        </button>
      </div>

      {/* 数据显示区 */}
      <div
        ref={parentRef}
        className="flex-1 overflow-auto bg-muted/30"
      >
        {receivedData.length === 0 ? (
          <div className="h-full flex items-center justify-center text-muted-foreground">
            {status === 'open' ? '等待数据...' : '请先连接串口'}
          </div>
        ) : (
          <div
            className="relative w-full"
            style={{ height: `${virtualizer.getTotalSize()}px` }}
          >
            {items.map((virtualRow) => {
              const packet = receivedData[virtualRow.index];
              return (
                <div
                  key={virtualRow.key}
                  className="absolute top-0 left-0 w-full px-2"
                  style={{
                    height: `${virtualRow.size}px`,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <div
                    className={cn(
                      "h-full flex items-center gap-2 text-sm terminal-text",
                      packet.direction === 'tx' ? 'text-blue-500' : 'text-foreground'
                    )}
                  >
                    <span className="text-muted-foreground shrink-0">
                      [{formatTimestamp(packet.timestamp)}]
                    </span>
                    <span
                      className={cn(
                        "shrink-0 px-1 rounded text-xs",
                        packet.direction === 'tx'
                          ? 'bg-blue-500/20 text-blue-500'
                          : 'bg-green-500/20 text-green-500'
                      )}
                    >
                      {packet.direction === 'tx' ? 'TX' : 'RX'}
                    </span>
                    <span className="break-all">{packet.data}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
