/**
 * 外部工具命令（关闭串口 → 运行命令 → 流式输出 → 退出 → 重开串口）。
 *
 * 参数约定见 `./tauri.ts` 文件头。
 */
import { invoke } from '@tauri-apps/api/core';

export const toolService = {
  /** 执行外部工具：关闭串口 → 运行命令 → 流式输出 → 退出 → 重开串口 */
  runPortTool: (params: { portId: string; command: string; workdir?: string }): Promise<number> => {
    return invoke<number>('run_port_tool', { args: {
      port_id: params.portId,
      command: params.command,
      workdir: params.workdir ?? null,
    }});
  },

  /** 终止正在运行的外部工具进程 */
  killPortTool: (portId: string): Promise<void> => {
    return invoke<void>('kill_port_tool', { portId });
  },
};
