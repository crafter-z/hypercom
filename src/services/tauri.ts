/**
 * Tauri 后端命令调用层
 * 封装所有 invoke 调用，提供类型安全的 API
 * 
 * 后端实现可以暂时为空壳（stub），前端先打通接口调用链路
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
  AppConfig,
} from '../types';

// ==================== 类型定义 ====================

/** 后端返回的串口信息 */
export interface AvailablePortInfo {
  id: string;
  name: string;
  port_type: string; // "real" | "virtual" | "sim"
  manufacturer?: string;
  product?: string;
}

/** 打开串口参数 */
export interface OpenPortParams {
  port_id: string;
  baud_rate: number;
  data_bits: number;
  parity: string;
  stop_bits: string;
  handshake: string;
  dtr: boolean;
  rts: boolean;
}

/** 发送数据参数 */
export interface SendDataParams {
  port_id: string;
  data: string;
  is_hex: boolean;
  append_line_ending: string;
}

/** 系统状态 */
export interface SystemStatusResult {
  status: string;
  memory_used_mb: number;
  memory_limit_mb: number;
  cpu_usage: number;
}

/** 流量统计 */
export interface TrafficStatsResult {
  port_id: string;
  tx_total: number;
  rx_total: number;
}

/** 日志文件信息 */
export interface LogFileInfoResult {
  path: string;
  port_id: string;
  created_at: number;
  size: number;
}

// ==================== 串口命令 ====================

export const serialService = {
  listAvailablePorts: (): Promise<AvailablePortInfo[]> => {
    return invoke<AvailablePortInfo[]>('list_available_ports');
  },

  openSerialPort: (params: OpenPortParams): Promise<void> => {
    return invoke<void>('open_serial_port', { args: params });
  },

  closeSerialPort: (portId: string): Promise<void> => {
    return invoke<void>('close_serial_port', { portId });
  },

  sendSerialData: (params: SendDataParams): Promise<number> => {
    return invoke<number>('send_serial_data', { args: params });
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

  setFlowControl: (portId: string, dtr: boolean, rts: boolean) => {
    return invoke<void>('set_flow_control', { portId, dtr, rts });
  },

  enableSimulation: (): Promise<void> => {
    return invoke<void>('enable_simulation');
  },

  disableSimulation: (): Promise<void> => {
    return invoke<void>('disable_simulation');
  },
};

// ==================== 配置命令 ====================

export const configService = {
  getConfig: (): Promise<AppConfig> => {
    return invoke<AppConfig>('get_config');
  },

  setConfig: (config: AppConfig): Promise<void> => {
    return invoke<void>('set_config', { newConfig: config });
  },

  resetConfig: (): Promise<AppConfig> => {
    return invoke<AppConfig>('reset_config');
  },
};

// ==================== 日志命令 ====================

export const logService = {
  setLogDirectory: (path: string): Promise<void> => {
    return invoke<void>('set_log_directory', { path });
  },

  saveLogAs: (portId: string, path: string): Promise<void> => {
    return invoke<void>('save_log_as', { portId, path });
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

  /** 同步 auto_save 状态到后端，避免前后端漂移 */
  setAutoSave: (enabled: boolean): Promise<void> => {
    return invoke<void>('set_log_auto_save', { enabled });
  },
  /** 设置日志默认编码 (UTF-8 / GBK / ISO-8859-1 / ASCII) */
  setEncoding: (encoding: string): Promise<void> => {
    return invoke<void>('set_log_encoding', { encoding });
  },
};

// ==================== 系统命令 ====================

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

// ==================== 事件监听 ====================

/** 串口数据事件 payload */
export interface SerialDataEvent {
  port_id: string;
  timestamp: number;
  direction: string;
  data: number[];
  is_hex: boolean;
}

/** 串口状态变化事件 payload */
export interface SerialStatusEvent {
  port_id: string;
  status: string;
}

export const eventService = {
  onSerialData: (callback: (event: SerialDataEvent) => void) => {
    return listen<SerialDataEvent>('serial:data', (event) => {
      callback(event.payload);
    });
  },

  onSerialStatus: (callback: (event: SerialStatusEvent) => void) => {
    return listen<SerialStatusEvent>('serial:status', (event) => {
      callback(event.payload);
    });
  },

  onSystemStatus: (callback: (event: SystemStatusResult) => void) => {
    return listen<SystemStatusResult>('system:status', (event) => {
      callback(event.payload);
    });
  },

  onStorageReady: (callback: () => void) => {
    return listen<void>('storage:ready', () => {
      callback();
    });
  },
};

// ==================== 存储命令 ====================

export interface CommandSetInfo {
  id: string;
  name: string;
  is_loop: boolean;
  loop_delay_ms: number;
  commands: CommandInfo[];
}

export interface CommandInfo {
  id: string;
  set_id: string;
  name: string;
  order_idx: number;
  delay_ms: number;
  cmd_type: string;
  content: string;
  append_line_ending: string;
}

export interface HighlightSetInfo {
  id: string;
  name: string;
  is_enabled: boolean;
  rules: HighlightRuleInfo[];
}

export interface HighlightRuleInfo {
  id: string;
  set_id: string;
  name: string;
  pattern: string;
  is_regex: boolean;
  color: string;
  bold: boolean;
  italic: boolean;
}

export const storageService = {
  saveCommandSet: (args: {
    id?: string;
    name: string;
    is_loop: boolean;
    loop_delay_ms: number;
    commands: Array<{
      id: string;
      name: string;
      order_idx: number;
      delay_ms: number;
      cmd_type: string;
      content: string;
      append_line_ending: string;
    }>;
  }): Promise<string> => {
    return invoke<string>('save_command_set', { args });
  },

  loadCommandSets: (): Promise<CommandSetInfo[]> => {
    return invoke<CommandSetInfo[]>('load_command_sets');
  },

  deleteCommandSet: (setId: string): Promise<void> => {
    return invoke<void>('delete_command_set', { setId });
  },

  saveHighlightSet: (args: {
    id?: string;
    name: string;
    is_enabled: boolean;
    rules: Array<{
      id: string;
      name: string;
      pattern: string;
      is_regex: boolean;
      color: string;
      bold: boolean;
      italic: boolean;
    }>;
  }): Promise<string> => {
    return invoke<string>('save_highlight_set', { args });
  },

  loadHighlightSets: (): Promise<HighlightSetInfo[]> => {
    return invoke<HighlightSetInfo[]>('load_highlight_sets');
  },

  deleteHighlightSet: (setId: string): Promise<void> => {
    return invoke<void>('delete_highlight_set', { setId });
  },
};