/**
 * 日志命令（日志文件管理 / 手动导出 / 目录迁移）。
 *
 * 参数约定见 `./tauri.ts` 文件头。
 */
import { invoke } from '@tauri-apps/api/core';

/** 日志文件信息（后端 `#[serde(rename_all = "camelCase")]` 序列化）。 */
export interface LogFileInfoResult {
  path: string;
  portId: string;
  createdAt: number;
  size: number;
}

export const logService = {
  saveLogAs: (portId: string, path: string): Promise<void> => {
    return invoke<void>('save_log_as', { portId, path });
  },

  exportTerminalLog: (path: string, content: string): Promise<void> => {
    return invoke<void>('export_terminal_log', { path, content });
  },

  getLogFiles: (): Promise<LogFileInfoResult[]> => {
    return invoke<LogFileInfoResult[]>('get_log_files');
  },

  startLogging: (portId: string): Promise<void> => {
    return invoke<void>('start_logging', { portId });
  },

  stopLogging: (portId: string): Promise<void> => {
    return invoke<void>('stop_logging', { portId });
  },

  /** 用系统默认程序打开文件或目录 */
  openPath: (path: string): Promise<void> => {
    return invoke<void>('open_path', { path });
  },

  /** 打开当前日志目录（资源管理器/Finder/xdg） */
  openLogDirectory: (): Promise<void> => {
    return invoke<void>('open_log_directory');
  },

  /** 将旧日志目录中的 .log 文件迁移到新目录，返回迁移文件数 */
  migrateLogDirectory: (oldDir: string, newDir: string): Promise<number> => {
    return invoke<number>('migrate_log_directory', { oldDir, newDir });
  },
};
