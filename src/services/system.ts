/**
 * 系统命令（状态读取 / 阻止息屏与休眠 / 原生关闭审批）。
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

/**
 * `editor:close-requested` 事件载荷。
 *
 * 关闭审批由后端发起：Rust 生成一次性 `requestId`（pending 60s 过期）并随事件下发；
 * 前端只能带同一个 id 调 `complete_editor_close` 放行，或用 `cancel_editor_close`
 * 撤销，不能自行发起关闭。`forceExit` 只用于前端展示与本地意图升级，最终以
 * 后端 pending 状态为准。
 */
export interface EditorCloseRequest {
  requestId: string;
  forceExit: boolean;
}

export const systemService = {
  /** Acknowledge receipt and continued renderer liveness for a native request. */
  acknowledgeEditorClose: (requestId: string): Promise<void> => invoke<void>('acknowledge_editor_close', { requestId }),

  /** Finish a native close request after the editor guard succeeds. */
  completeEditorClose: (requestId: string): Promise<void> => {
    return invoke<void>('complete_editor_close', { requestId });
  },

  /** Withdraw a native close request (the user chose "keep editing"). */
  cancelEditorClose: (requestId: string): Promise<void> => {
    return invoke<void>('cancel_editor_close', { requestId });
  },

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
