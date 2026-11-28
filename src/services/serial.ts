/**
 * 串口命令与模拟终端（GIT:BASH）命令。
 *
 * 参数约定见 `./tauri.ts` 文件头：公开参数一律 camelCase，wire 载荷在 invoke
 * 处显式构造（Rust 结构体字段名即 wire 名）；后端返回/推送的 payload 逐字段
 * 镜像 wire 名。
 */
import { invoke } from '@tauri-apps/api/core';
import type { PortLoanInfo } from '../types';

/** 后端返回的串口信息（后端未加 rename_all → wire 字段名保持 snake_case）。 */
export interface AvailablePortInfo {
  id: string;
  name: string;
  port_type: string; // "real" | "virtual" | "sim" | "remote"
  manufacturer?: string;
  product?: string;
  host_id?: string;
  host_label?: string;
  remote_port_id?: string;
  remote_role?: string;
  remote_allow_loan?: boolean;
  remote_status?: string;
  remote_generation?: number;
  remote_baud_rate?: number;
  loan?: PortLoanInfo;
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

/** Plugin commands return camelCase payloads, mirroring their explicit Rust wire contract. */
export interface PluginSerialPort {
  id: string;
  name: string;
  status: string;
  type: string;
  mode: string;
  baudRate?: number;
  connectionGeneration: number;
  isRemote?: boolean;
  remoteRole?: string;
  remoteAllowLoan?: boolean;
}
export interface PluginSerialOpenRequest {
  portId: string;
  params?: Partial<Omit<OpenPortParams, 'portId'>>;
}
export interface PluginSerialCloseRequest {
  portId: string;
  expectedConnectionGeneration: number;
}
export interface PluginSerialOpenResult {
  port: PluginSerialPort;
  result: 'opened' | 'already-open';
  connectionGeneration: number;
}
export interface PluginSerialCloseResult {
  port: PluginSerialPort;
  result: 'closed' | 'already-closed';
}

/** 发送数据参数（camelCase 公开 API；service 内部映射为 wire 的 snake_case）。 */
export interface SendDataParams {
  portId: string;
  data: string;
  isHex: boolean;
  /** 追加的行尾字面量（'None' / '\r\n' / '\n' / '\r'）。 */
  appendLineEnding: string;
  /** Backend connection identity; rejects a send queued across reconnect. */
  expectedGeneration?: number;
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

  pluginSerialOpen: (pluginId: string, expectedGeneration: string, request: PluginSerialOpenRequest): Promise<PluginSerialOpenResult> => {
    return invoke<PluginSerialOpenResult>('plugin_serial_open', {
      pluginId, expectedGeneration, portId: request.portId, params: request.params,
    });
  },

  pluginSerialClose: (pluginId: string, expectedGeneration: string, request: PluginSerialCloseRequest): Promise<PluginSerialCloseResult> => {
    return invoke<PluginSerialCloseResult>('plugin_serial_close', {
      pluginId, expectedGeneration, portId: request.portId,
      expectedConnectionGeneration: request.expectedConnectionGeneration,
    });
  },

  pluginSerialStatus: (pluginId: string, expectedGeneration: string, portId: string): Promise<PluginSerialPort | null> => {
    return invoke<PluginSerialPort | null>('plugin_serial_status', { pluginId, expectedGeneration, portId });
  },

  pluginSerialList: (pluginId: string, expectedGeneration: string): Promise<PluginSerialPort[]> => {
    return invoke<PluginSerialPort[]>('plugin_serial_list', { pluginId, expectedGeneration });
  },

  sendSerialData: (params: SendDataParams): Promise<number> => {
    return invoke<number>('send_serial_data', { args: {
      port_id: params.portId,
      data: params.data,
      is_hex: params.isHex,
      append_line_ending: params.appendLineEnding,
      expected_generation: params.expectedGeneration,
    }});
  },

  /** 分块发送文件内容，进度经 serial:file_progress 事件推送。 */
  sendFile: (params: { portId: string; transferId: string; path: string; chunkSize: number; delayMs: number; expectedGeneration?: number }): Promise<number> => {
    return invoke<number>('send_file', { args: {
      port_id: params.portId,
      transfer_id: params.transferId,
      path: params.path,
      chunk_size: params.chunkSize,
      delay_ms: params.delayMs,
      expected_generation: params.expectedGeneration,
    }});
  },

  /** 取消指定文件传输；transferId 防止取消同端口的新传输。 */
  cancelFileSend: (portId: string, transferId: string): Promise<void> => {
    return invoke<void>('cancel_file_send', { portId, transferId });
  },

  setSerialParams: (portId: string, params: { baudRate: number; dataBits: number; parity: string; stopBits: string; handshake: string; expectedGeneration?: number }) => {
    return invoke<void>('set_serial_params', { args: {
      port_id: portId,
      baud_rate: params.baudRate,
      data_bits: params.dataBits,
      parity: params.parity,
      stop_bits: params.stopBits,
      handshake: params.handshake,
      expected_generation: params.expectedGeneration,
    }});
  },

  /** 运行时切换 DTR/RTS；可携带连接代次拒绝迟到的旧会话更新。 */
  setFlowControl: (portId: string, dtr: boolean, rts: boolean, expectedGeneration?: number) => {
    return invoke<void>('set_flow_control', { portId, dtr, rts, expectedGeneration });
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
