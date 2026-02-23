import { useState, useEffect } from 'react';
import { FolderOpen, FileText, Play, Square } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { useSettingsStore } from '../../stores';
import type { LogStatus, LogConfig } from '../../types';

export function LogSettings() {
  const { settings, updateLog } = useSettingsStore();
  const { log } = settings;
  
  const [logStatus, setLogStatus] = useState<LogStatus>('Stopped');
  const [currentLogFile, setCurrentLogFile] = useState<string | null>(null);

  // 加载日志状态
  useEffect(() => {
    const loadLogStatus = async () => {
      try {
        const status = await invoke<LogStatus>('get_log_status');
        setLogStatus(status);
        
        const file = await invoke<string | null>('get_current_log_file');
        setCurrentLogFile(file);
      } catch (error) {
        console.error('Failed to load log status:', error);
      }
    };
    
    loadLogStatus();
    // 定期刷新状态
    const interval = setInterval(loadLogStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  // 选择日志目录
  const handleSelectDir = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: '选择日志存储目录',
      });
      
      if (selected && typeof selected === 'string') {
        updateLog({ logDir: selected });
      }
    } catch (error) {
      console.error('Failed to select directory:', error);
    }
  };

  // 开始记录日志
  const handleStartLogging = async () => {
    try {
      await invoke('start_logging', { logDir: log.logDir || null });
      setLogStatus('Recording');
      
      const file = await invoke<string | null>('get_current_log_file');
      setCurrentLogFile(file);
    } catch (error) {
      console.error('Failed to start logging:', error);
    }
  };

  // 停止记录日志
  const handleStopLogging = async () => {
    try {
      await invoke('stop_logging');
      setLogStatus('Stopped');
    } catch (error) {
      console.error('Failed to stop logging:', error);
    }
  };

  const isRecording = logStatus === 'Recording';

  return (
    <div className="space-y-4">
      <h4 className="text-sm font-medium">日志设置</h4>

      {/* 日志状态 */}
      <div className="flex items-center justify-between p-3 rounded-lg border bg-muted/30">
        <div className="flex items-center gap-2">
          <div
            className={`w-2 h-2 rounded-full ${
              isRecording ? 'bg-green-500 animate-pulse' : 'bg-gray-400'
            }`}
          />
          <span className="text-sm">
            {isRecording ? '正在记录' : '未记录'}
          </span>
        </div>
        
        {isRecording ? (
          <button
            onClick={handleStopLogging}
            className="flex items-center gap-1 px-3 py-1.5 rounded bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors"
          >
            <Square size={14} />
            停止
          </button>
        ) : (
          <button
            onClick={handleStartLogging}
            disabled={!log.logDir}
            className="flex items-center gap-1 px-3 py-1.5 rounded bg-primary/10 text-primary hover:bg-primary/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Play size={14} />
            开始
          </button>
        )}
      </div>

      {/* 当前日志文件 */}
      {currentLogFile && (
        <div className="p-3 rounded-lg border bg-muted/30">
          <div className="text-xs text-muted-foreground mb-1">当前日志文件</div>
          <div className="text-sm font-mono truncate flex items-center gap-2">
            <FileText size={14} className="text-muted-foreground flex-shrink-0" />
            {currentLogFile}
          </div>
        </div>
      )}

      {/* 日志目录 */}
      <div className="space-y-2">
        <label className="text-xs text-muted-foreground">日志存储目录</label>
        <div className="flex gap-2">
          <input
            type="text"
            value={log.logDir}
            onChange={(e) => updateLog({ logDir: e.target.value })}
            placeholder="选择日志存储目录..."
            className="flex-1 px-3 py-2 rounded-lg border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
          <button
            onClick={handleSelectDir}
            className="p-2 rounded-lg border hover:bg-accent transition-colors"
            title="选择目录"
          >
            <FolderOpen size={18} />
          </button>
        </div>
      </div>

      {/* 日志选项 */}
      <div className="space-y-3">
        <label className="text-xs text-muted-foreground">日志选项</label>
        
        {/* 最大文件大小 */}
        <div className="flex items-center justify-between">
          <span className="text-sm">最大文件大小 (MB)</span>
          <input
            type="number"
            value={log.maxFileSize}
            onChange={(e) => updateLog({ maxFileSize: Number(e.target.value) })}
            min={1}
            max={100}
            className="w-20 px-2 py-1 rounded border bg-background text-sm text-center focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
        </div>

        {/* 自动分片 */}
        <label className="flex items-center justify-between cursor-pointer">
          <span className="text-sm">自动分片</span>
          <input
            type="checkbox"
            checked={log.autoSplit}
            onChange={(e) => updateLog({ autoSplit: e.target.checked })}
            className="w-4 h-4 rounded border accent-primary"
          />
        </label>

        {/* 包含时间戳 */}
        <label className="flex items-center justify-between cursor-pointer">
          <span className="text-sm">包含时间戳</span>
          <input
            type="checkbox"
            checked={log.includeTimestamp}
            onChange={(e) => updateLog({ includeTimestamp: e.target.checked })}
            className="w-4 h-4 rounded border accent-primary"
          />
        </label>
      </div>
    </div>
  );
}
