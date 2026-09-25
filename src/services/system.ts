/**
 * 系统命令（状态读取 / 阻止息屏与休眠）。
 *
 * 参数约定见 `./tauri.ts` 文件头。
 */
import { invoke } from '@tauri-apps/api/core';

/** 系统状态（后端 `#[serde(rename_all = "camelCase")]` 序列化） */
export interface SystemStatusResult {
  status: string;
  memoryUsedMb: number;
  cpuUsage: number;
}

export const systemService = {
  getSystemStatus: (): Promise<SystemStatusResult> => {
    return invoke<SystemStatusResult>('get_system_status');
  },

  preventScreenOff: (enable: boolean): Promise<void> => {
    return invoke<void>('prevent_screen_off', { enable });
  },

  preventSleep: (enable: boolean): Promise<void> => {
    return invoke<void>('prevent_sleep', { enable });
  },
};
