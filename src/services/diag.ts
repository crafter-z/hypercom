/**
 * 诊断日志命令（活跃文件路径 / 读取 / 清空 / 前端日志转发）。
 *
 * 参数约定见 `./tauri.ts` 文件头。
 */
import { invoke } from '@tauri-apps/api/core';

/** 前端转发到后端诊断日志文件的条目（与后端日志同文件）。 */
export interface DiagLogEntry {
  timestamp: string;
  level: string;
  message: string;
}

export const diagLogService = {
  /** 返回诊断日志活跃文件路径。 */
  getDiagLogPath: (): Promise<string> => invoke<string>('get_diag_log_path'),

  /** 读取最近 `limit` 行诊断日志（缺省 2000）。 */
  readDiagLog: (limit?: number): Promise<string> =>
    invoke<string>('read_diag_log', { limit }),

  /** 清空全部诊断日志（活跃文件 + 轮转备份）。 */
  clearDiagLog: (): Promise<void> => invoke<void>('clear_diag_log'),

  /** 追加一批前端 `console.*` 日志到诊断日志文件。 */
  appendDiagLog: (entries: DiagLogEntry[]): Promise<void> =>
    invoke<void>('append_diag_log', { entries }),
};
