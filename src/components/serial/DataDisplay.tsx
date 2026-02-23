import { useRef, useEffect, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Trash2, Download, FileText, FileSpreadsheet, FileJson, CheckCircle, AlertCircle, X } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { useSerialStore } from '../../stores';
import { formatTimestamp, cn } from '../../utils';

type ExportFormat = 'txt' | 'csv' | 'json';

interface ToastState {
  show: boolean;
  type: 'success' | 'error';
  message: string;
}

export function DataDisplay() {
  const { receivedData, clearData, status } = useSerialStore();
  const parentRef = useRef<HTMLDivElement>(null);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [toast, setToast] = useState<ToastState>({ show: false, type: 'success', message: '' });

  // 显示 toast 通知
  const showToast = (type: 'success' | 'error', message: string) => {
    setToast({ show: true, type, message });
    setTimeout(() => {
      setToast((prev) => ({ ...prev, show: false }));
    }, 3000);
  };

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

  // 格式化数据为文本
  const formatDataAsText = () => {
    return receivedData
      .map((packet) => {
        const timestamp = formatTimestamp(packet.timestamp);
        const direction = packet.direction === 'tx' ? 'TX' : 'RX';
        return `[${timestamp}] ${direction} ${packet.data}`;
      })
      .join('\n');
  };

  // 导出数据
  const handleExport = async (format: ExportFormat) => {
    if (receivedData.length === 0) return;

    setExporting(true);
    setShowExportMenu(false);

    try {
      const extension = format;
      const defaultName = `hypercom_export_${new Date().toISOString().slice(0, 10)}.${extension}`;

      const path = await save({
        defaultPath: defaultName,
        filters: [
          { name: format.toUpperCase(), extensions: [extension] },
        ],
      });

      if (!path) {
        setExporting(false);
        return;
      }

      const data = formatDataAsText();

      await invoke('export_data', {
        request: {
          data,
          format,
          path,
        },
      });

      // 显示成功提示
      showToast('success', '导出成功');
    } catch (error) {
      console.error('Export failed:', error);
      // 显示错误提示
      showToast('error', `导出失败: ${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* 工具栏 */}
      <div className="h-10 px-4 flex items-center justify-between border-b border-border">
        <span className="text-sm text-muted-foreground">
          数据记录 ({receivedData.length})
        </span>
        
        <div className="flex items-center gap-2">
          {/* 导出按钮 */}
          <div className="relative">
            <button
              onClick={() => setShowExportMenu(!showExportMenu)}
              disabled={receivedData.length === 0 || exporting}
              className="h-7 px-2 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              <Download className="w-4 h-4" />
              导出
            </button>

            {/* 导出格式菜单 */}
            {showExportMenu && (
              <div className="absolute right-0 top-full mt-1 z-10 bg-background border rounded-lg shadow-lg py-1 min-w-[120px]">
                <button
                  onClick={() => handleExport('txt')}
                  className="w-full px-3 py-1.5 flex items-center gap-2 text-sm hover:bg-accent"
                >
                  <FileText className="w-4 h-4" />
                  TXT 格式
                </button>
                <button
                  onClick={() => handleExport('csv')}
                  className="w-full px-3 py-1.5 flex items-center gap-2 text-sm hover:bg-accent"
                >
                  <FileSpreadsheet className="w-4 h-4" />
                  CSV 格式
                </button>
                <button
                  onClick={() => handleExport('json')}
                  className="w-full px-3 py-1.5 flex items-center gap-2 text-sm hover:bg-accent"
                >
                  <FileJson className="w-4 h-4" />
                  JSON 格式
                </button>
              </div>
            )}
          </div>

          {/* 清空按钮 */}
          <button
            onClick={clearData}
            disabled={receivedData.length === 0}
            className="h-7 px-2 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            <Trash2 className="w-4 h-4" />
            清空
          </button>
        </div>
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

      {/* 导出中遮罩 */}
      {exporting && (
        <div className="absolute inset-0 bg-background/50 flex items-center justify-center">
          <div className="flex items-center gap-2">
            <div className="animate-spin rounded-full h-4 w-4 border-2 border-primary border-t-transparent" />
            <span className="text-sm">导出中...</span>
          </div>
        </div>
      )}
    </div>
  );
}
