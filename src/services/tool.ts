/**
 * 外部工具命令（关闭串口 → 运行命令 → 流式输出 → 退出 → 重开串口）。
 *
 * 参数约定见 `./tauri.ts` 文件头。
 */
import { invoke } from '@tauri-apps/api/core';

/** Mirrors the native `render_port_tool_command` for the settings preview only. */
export function previewPortToolCommand(template: string, portId: string): string {
  const port = /^COM([0-9]+)$/i.exec(portId)?.[1] ?? portId;
  return template.replace(/\{port\}/g, () => port);
}

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
