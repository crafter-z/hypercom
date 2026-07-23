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

/** 系统状态（后端 #[serde(rename_all = "camelCase")] 序列化） */
export interface SystemStatusResult {
  status: string;
  memoryUsedMb: number;
  memoryLimitMb: number;
  cpuUsage: number;
}

/** 流量统计 */
export interface TrafficStatsResult {
  port_id: string;
  tx_total: number;
  rx_total: number;
}

/** 日志文件信息（后端 #[serde(rename_all = "camelCase")] 序列化） */
export interface LogFileInfoResult {
  path: string;
  portId: string;
  createdAt: number;
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

  updateSessionSnapshot: (snapshot: string): Promise<void> => {
    return invoke<void>('update_session_snapshot', { snapshot });
  },

  getConfigPath: (): Promise<string> => {
    return invoke<string>('get_config_path');
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

  /** 同步 auto_save 状态到后端，避免前后端漂移 */
  setAutoSave: (enabled: boolean): Promise<void> => {
    return invoke<void>('set_log_auto_save', { enabled });
  },
  /** 设置日志默认编码 (UTF-8 / GBK / ISO-8859-1 / ASCII) */
  setEncoding: (encoding: string): Promise<void> => {
    return invoke<void>('set_log_encoding', { encoding });
  },
  /** 设置日志文件名模板（[com]/[datetime]/[date]/[time] 变量） */
  setLogFilenameFormat: (format: string): Promise<void> => {
    return invoke<void>('set_log_filename_format', { format });
  },
  /** 设置日志分片大小阈值 (MB) */
  setLogSplitSize: (mb: number): Promise<void> => {
    return invoke<void>('set_log_split_size', { mb });
  },
  /** 开关日志按大小自动分片 */
  setLogSplitEnabled: (enabled: boolean): Promise<void> => {
    return invoke<void>('set_log_split_enabled', { enabled });
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

/** 串口自动重连提示事件 payload */
export interface SerialReconnectHintEvent {
  port_name: string;
}

/** 串口引脚状态事件 payload */
export interface SerialPinStatesEvent {
  port_id: string;
  dtr: boolean;
  rts: boolean;
  cts: boolean;
  dsr: boolean;
  rlsd: boolean;
  ri: boolean;
}

/** 文件发送进度事件 payload */
export interface FileProgressPayload {
  port_id: string;
  sent_bytes: number;
  total_bytes: number;
  done: boolean;
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

  onStorageReady: (callback: () => void) => {
    return listen<void>('storage:ready', () => {
      callback();
    });
  },

  onSerialReconnectHint: (callback: (event: SerialReconnectHintEvent) => void) => {
    return listen<SerialReconnectHintEvent>('serial:reconnect_hint', (event) => {
      callback(event.payload);
    });
  },

  onSerialPinStates: (callback: (event: SerialPinStatesEvent) => void) => {
    return listen<SerialPinStatesEvent>('serial:pin_states', (event) => {
      callback(event.payload);
    });
  },

  onFileProgress: (callback: (event: FileProgressPayload) => void) => {
    return listen<FileProgressPayload>('serial:file_progress', (event) => {
      callback(event.payload);
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

export interface ProtocolTemplateInfo {
  id: string;
  name: string;
  is_enabled: boolean;
  header_bytes: string;
  length_field_offset: number;
  length_field_size: number;
  length_endian: string;
  length_adjust: number;
  checksum_algorithm: string;
  checksum_offset: number;
  footer_bytes: string;
  color_header: string;
  color_length: string;
  color_payload: string;
  color_checksum: string;
  color_footer: string;
}

// ==================== 发送历史命令 ====================

export interface SendHistoryItem {
  id: string;
  port_id: string;
  content: string;
  format: string;
  line_ending: string;
  created_at: string;
}

export const sendHistoryService = {
  listSendHistory: (portId: string, limit: number): Promise<SendHistoryItem[]> => {
    return invoke<SendHistoryItem[]>('list_send_history', { portId, limit });
  },

  addSendHistory: (portId: string, content: string, format: string, lineEnding: string): Promise<SendHistoryItem> => {
    return invoke<SendHistoryItem>('add_send_history', { portId, content, format, lineEnding });
  },

  clearSendHistory: (portId: string): Promise<void> => {
    return invoke<void>('clear_send_history', { portId });
  },
};

// ==================== 存储命令 ====================

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

  saveProtocolTemplate: (args: {
    id?: string; name: string; is_enabled: boolean;
    header_bytes: string; length_field_offset: number; length_field_size: number;
    length_endian: string; length_adjust: number; checksum_algorithm: string;
    checksum_offset: number; footer_bytes: string; color_header: string;
    color_length: string; color_payload: string; color_checksum: string; color_footer: string;
  }): Promise<string> => {
    return invoke<string>('save_protocol_template', { args });
  },

  loadProtocolTemplates: (): Promise<ProtocolTemplateInfo[]> => {
    return invoke<ProtocolTemplateInfo[]>('load_protocol_templates');
  },

  deleteProtocolTemplate: (setId: string): Promise<void> => {
    return invoke<void>('delete_protocol_template', { setId });
  },
};

// ==================== 通用文件命令 ====================

export const fileService = {
  /** 将文本内容写入指定路径（配置导出）。路径来自 save() 对话框。 */
  writeTextFile: (path: string, content: string): Promise<void> => {
    return invoke<void>('write_text_file', { path, content });
  },

  /** 读取文本文件内容（配置导入）。路径来自 open() 对话框。 */
  readTextFile: (path: string): Promise<string> => {
    return invoke<string>('read_text_file', { path });
  },
};

// ==================== 端口参数预设命令 ====================

export interface PortPresetInfo {
  id: string;
  name: string;
  baud_rate: number;
  data_bits: number;
  parity: string;
  stop_bits: string;
  handshake: string;
  dtr: number;
  rts: number;
  created_at: string;
}

export const portPresetService = {
  savePortPreset: (args: {
    id?: string;
    name: string;
    baud_rate: number;
    data_bits: number;
    parity: string;
    stop_bits: string;
    handshake: string;
    dtr: boolean;
    rts: boolean;
  }): Promise<string> => {
    return invoke<string>('save_port_preset', { args });
  },

  loadPortPresets: (): Promise<PortPresetInfo[]> => {
    return invoke<PortPresetInfo[]>('load_port_presets');
  },

  deletePortPreset: (presetId: string): Promise<void> => {
    return invoke<void>('delete_port_preset', { presetId });
  },
};