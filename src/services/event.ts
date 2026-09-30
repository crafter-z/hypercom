/**
 * 后端推送事件订阅（串口数据/状态、重连提示、文件进度、外部工具输出）。
 *
 * payload 类型逐字段镜像 Rust 的 wire 名（后端未加 rename_all → snake_case），
 * 见 `./tauri.ts` 文件头的参数约定第 3 条。
 */
import { listen } from '@tauri-apps/api/event';

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

/** 文件发送进度事件 payload */
export interface FileProgressPayload {
  port_id: string;
  sent_bytes: number;
  total_bytes: number;
  done: boolean;
}

/** 外部工具输出事件 payload */
export interface ToolOutputPayload {
  port_id: string;
  line: string;
  stream: string; // "stdout" | "stderr"
}

/** 外部工具退出事件 payload */
export interface ToolExitPayload {
  port_id: string;
  code: number;
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

  onSerialReconnectHint: (callback: (event: SerialReconnectHintEvent) => void) => {
    return listen<SerialReconnectHintEvent>('serial:reconnect_hint', (event) => {
      callback(event.payload);
    });
  },

  onFileProgress: (callback: (event: FileProgressPayload) => void) => {
    return listen<FileProgressPayload>('serial:file_progress', (event) => {
      callback(event.payload);
    });
  },

  onToolOutput: (callback: (event: ToolOutputPayload) => void) => {
    return listen<ToolOutputPayload>('tool:output', (event) => {
      callback(event.payload);
    });
  },

  onToolExit: (callback: (event: ToolExitPayload) => void) => {
    return listen<ToolExitPayload>('tool:exit', (event) => {
      callback(event.payload);
    });
  },
};
