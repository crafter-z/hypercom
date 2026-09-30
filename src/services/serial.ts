/**
 * 串口命令与模拟终端（GIT:BASH）命令。
 *
 * 参数约定见 `./tauri.ts` 文件头：公开参数一律 camelCase，wire 载荷在 invoke
 * 处显式构造（Rust 结构体字段名即 wire 名）；后端返回/推送的 payload 逐字段
 * 镜像 wire 名。
 */
import { invoke } from '@tauri-apps/api/core';

/** 后端返回的串口信息（后端未加 rename_all → wire 字段名保持 snake_case）。 */
export interface AvailablePortInfo {
  id: string;
  name: string;
  port_type: string; // "real" | "virtual" | "sim"
  manufacturer?: string;
  product?: string;
}

/** 打开串口参数（camelCase 公开 API；service 内部映射为 wire 的 snake_case）。 */
export interface OpenPortParams {
  portId: string;
  baudRate: number;
  dataBits: number;
  parity: string;
  stopBits: string;
  handshake: string;
  dtr: boolean;
  rts: boolean;
  /** TTY 模拟终端初始尺寸（issue #11）：缺省时后端回退 80×24。真实串口忽略。 */
  cols?: number;
  rows?: number;
}

/** 发送数据参数（camelCase 公开 API；service 内部映射为 wire 的 snake_case）。 */
export interface SendDataParams {
  portId: string;
  data: string;
  isHex: boolean;
  /** 追加的行尾字面量（'None' / '\r\n' / '\n' / '\r'）。 */
  appendLineEnding: string;
}

export const serialService = {
  listAvailablePorts: (): Promise<AvailablePortInfo[]> => {
    return invoke<AvailablePortInfo[]>('list_available_ports');
  },

  openSerialPort: (params: OpenPortParams): Promise<void> => {
    return invoke<void>('open_serial_port', { args: {
      port_id: params.portId,
      baud_rate: params.baudRate,
      data_bits: params.dataBits,
      parity: params.parity,
      stop_bits: params.stopBits,
      handshake: params.handshake,
      dtr: params.dtr,
      rts: params.rts,
      cols: params.cols,
      rows: params.rows,
    }});
  },

  closeSerialPort: (portId: string): Promise<void> => {
    return invoke<void>('close_serial_port', { portId });
  },

  sendSerialData: (params: SendDataParams): Promise<number> => {
    return invoke<number>('send_serial_data', { args: {
      port_id: params.portId,
      data: params.data,
      is_hex: params.isHex,
      append_line_ending: params.appendLineEnding,
    }});
  },

  /** 分块发送文件内容到串口，进度经 serial:file_progress 事件推送 */
  sendFile: (params: { portId: string; path: string; chunkSize: number; delayMs: number }): Promise<number> => {
    return invoke<number>('send_file', { args: {
      port_id: params.portId,
      path: params.path,
      chunk_size: params.chunkSize,
      delay_ms: params.delayMs,
    }});
  },

  setSerialParams: (portId: string, params: { baudRate: number; dataBits: number; parity: string; stopBits: string; handshake: string }) => {
    return invoke<void>('set_serial_params', { args: {
      port_id: portId,
      baud_rate: params.baudRate,
      data_bits: params.dataBits,
      parity: params.parity,
      stop_bits: params.stopBits,
      handshake: params.handshake,
    }});
  },

  /** 运行时切换 DTR/RTS（顶层 camelCase 参数由 Tauri 映射到 Rust 形参）。 */
  setFlowControl: (portId: string, dtr: boolean, rts: boolean) => {
    return invoke<void>('set_flow_control', { portId, dtr, rts });
  },

  attemptReconnect: (portId: string): Promise<void> => {
    return invoke<void>('attempt_reconnect', { portId });
  },

  enableSimulation: (): Promise<void> => {
    return invoke<void>('enable_simulation');
  },

  disableSimulation: (): Promise<void> => {
    return invoke<void>('disable_simulation');
  },

  /** 取消正在进行的文件发送（置位后端 per-port 取消标志；读循环在下一块前退出）。 */
  cancelFileSend: (portId: string): Promise<void> => {
    return invoke<void>('cancel_file_send', { portId });
  },
};

// ==================== 模拟终端（git bash，仅 debug，issue #11）====================

export const gitBashSimService = {
  /** 启用 GIT:BASH 模拟终端（spawn 本地 git bash pty）。 */
  enableGitBashSim: (): Promise<string> => invoke<string>('enable_gitbash_sim'),
  /** 停用并关闭 GIT:BASH 模拟终端。 */
  disableGitBashSim: (): Promise<void> => invoke<void>('disable_gitbash_sim'),
  /** 调整 GIT:BASH pty 尺寸（cols×rows），供全屏应用（vim/top）正确重绘。 */
  resizeGitBashSim: (portId: string, cols: number, rows: number): Promise<void> =>
    invoke<void>('resize_gitbash_sim', { portId, cols, rows }),
};
