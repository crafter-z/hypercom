/**
 * 后端推送事件订阅（串口数据/状态、重连提示、文件进度、外部工具输出）。
 *
 * payload 类型逐字段镜像 Rust 的 wire 名（后端未加 rename_all → snake_case），
 * 见 `./tauri.ts` 文件头的参数约定第 3 条。
 */
import { listen } from '@tauri-apps/api/event';
import type { ResolvedArtifactDto } from './control';

/** 串口数据事件 payload */
export interface SerialDataEvent {
  port_id: string;
  timestamp: number;
  /** Connection identity; optional for compatibility with older backends. */
  generation?: number | null;
  direction: string;
  data: number[];
  is_hex: boolean;
}

/** 串口状态变化事件 payload */
export interface SerialStatusEvent {
  port_id: string;
  status: string;
  /** Connection identity (absent from older backends). */
  generation?: number | null;
}

/** 串口自动重连提示事件 payload */
export interface SerialReconnectHintEvent {
  port_name: string;
}

/** 文件发送进度事件 payload（Rust 侧 `#[serde(rename_all = "camelCase")]` → camelCase wire 名）。 */
export interface FileProgressPayload {
  portId: string;
  transferId: string;
  sentBytes: number;
  totalBytes: number;
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

/** 端口借用事件 payload（camelCase wire） */
export interface SerialToolLoanEvent {
  portId: string;
  active: boolean;
  leaseId?: string;
  holder?: string;
  reason?: string;
  expiresAtMs?: number;
}

/** 协作备注事件 payload（camelCase wire） */
export interface SerialNoteEvent {
  portId: string;
  text: string;
  source?: string;
  timestamp: number;
  generation: number;
}

/** 外部发送镜像事件 payload（camelCase wire） */
export interface SerialExternalTxEvent {
  portId: string;
  timestamp: number;
  generation: number;
  data: number[];
  source?: string;
}

/** Control Bridge → 主窗：插件工具调用事件 payload */
export interface ControlPluginInvokeEvent {
  requestId: string;
  pluginId: string;
  installGeneration: string;
  tool: string;
  args: unknown;
  artifacts: ResolvedArtifactDto[];
  mode: 'sync' | 'job';
  jobId: string | null;
}

/** Control Bridge → 主窗：取消插件异步任务事件 payload */
export interface ControlPluginJobCancelEvent {
  jobId: string;
}

/** Control Bridge → 主窗：远端工作台请求打开投影视图代理 */
export interface ControlRemoteViewOpenEvent {
  remoteInstanceId: string;
  documentId: string;
  pluginId: string;
  installGeneration: string;
  viewId: string;
  boundPortId: string | null;
  params: unknown;
}

/** Control Bridge → 主窗：远端工作台发送投影视图输入 */
export interface ControlRemoteViewInputEvent {
  remoteInstanceId: string;
  kind: string;
  payload: unknown;
}

/** Control Bridge → 主窗：远端工作台关闭投影视图代理 */
export interface ControlRemoteViewCloseEvent {
  remoteInstanceId: string;
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

  onSerialToolLoan: (callback: (loan: SerialToolLoanEvent) => void) =>
    listen<SerialToolLoanEvent>('serial:tool-loan', event => callback(event.payload)),

  onSerialNote: (callback: (event: SerialNoteEvent) => void) =>
    listen<SerialNoteEvent>('serial:note', event => callback(event.payload)),

  onSerialExternalTx: (callback: (event: SerialExternalTxEvent) => void) =>
    listen<SerialExternalTxEvent>('serial:external-tx', event => callback(event.payload)),

  onRemoteHostsChanged: (callback: () => void) =>
    listen<unknown>('remote:hosts-changed', () => callback()),

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

  onControlPluginInvoke: (callback: (event: ControlPluginInvokeEvent) => void) =>
    listen<ControlPluginInvokeEvent>('control:plugin-invoke', (event) => callback(event.payload)),

  onControlPluginJobCancel: (callback: (event: ControlPluginJobCancelEvent) => void) =>
    listen<ControlPluginJobCancelEvent>('control:plugin-job-cancel', (event) => callback(event.payload)),

  onControlRemoteViewOpen: (callback: (event: ControlRemoteViewOpenEvent) => void) =>
    listen<ControlRemoteViewOpenEvent>('control:remote-view-open', (event) => callback(event.payload)),

  onControlRemoteViewInput: (callback: (event: ControlRemoteViewInputEvent) => void) =>
    listen<ControlRemoteViewInputEvent>('control:remote-view-input', (event) => callback(event.payload)),

  onControlRemoteViewClose: (callback: (event: ControlRemoteViewCloseEvent) => void) =>
    listen<ControlRemoteViewCloseEvent>('control:remote-view-close', (event) => callback(event.payload)),
};
