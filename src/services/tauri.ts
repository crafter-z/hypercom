/**
 * Tauri 后端命令调用层
 * 封装所有 invoke 调用，提供类型安全的 API
 * 
 * 后端实现可以暂时为空壳（stub），前端先打通接口调用链路
 */

import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import type {
  AppConfig,
  TerminalState,
  SendCommandSet,
  HighlightRuleSet,
  ProtocolTemplate,
  TriggerRule,
  PortPreset,
  PortToolConfig,
  PortGroup,
  PortMetaEntry,
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

  /** 取消正在进行的文件发送（置位后端 per-port 取消标志；读循环在下一块前退出）。 */
  cancelFileSend: (portId: string): Promise<void> => {
    return invoke<void>('cancel_file_send', { portId });
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

  getSessionSnapshot: (): Promise<string> => {
    return invoke<string>('get_session_snapshot');
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

  /** 将旧日志目录中的 .log 文件迁移到新目录，返回迁移文件数 */
  migrateLogDirectory: (oldDir: string, newDir: string): Promise<number> => {
    return invoke<number>('migrate_log_directory', { oldDir, newDir });
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

// ==================== 存储命令 ====================

export const storageService = {
  saveCommandSet: (args: SendCommandSet): Promise<string> => {
    return invoke<string>('save_command_set', { args });
  },

  loadCommandSets: (): Promise<SendCommandSet[]> => {
    return invoke<SendCommandSet[]>('load_command_sets');
  },

  deleteCommandSet: (setId: string): Promise<void> => {
    return invoke<void>('delete_command_set', { setId });
  },

  saveHighlightSet: (args: HighlightRuleSet): Promise<string> => {
    return invoke<string>('save_highlight_set', { args });
  },

  loadHighlightSets: (): Promise<HighlightRuleSet[]> => {
    return invoke<HighlightRuleSet[]>('load_highlight_sets');
  },

  deleteHighlightSet: (setId: string): Promise<void> => {
    return invoke<void>('delete_highlight_set', { setId });
  },

  saveProtocolTemplate: (args: ProtocolTemplate): Promise<string> => {
    return invoke<string>('save_protocol_template', { args });
  },

  loadProtocolTemplates: (): Promise<ProtocolTemplate[]> => {
    return invoke<ProtocolTemplate[]>('load_protocol_templates');
  },

  deleteProtocolTemplate: (setId: string): Promise<void> => {
    return invoke<void>('delete_protocol_template', { setId });
  },

  saveTriggerRule: (args: TriggerRule): Promise<string> => {
    return invoke<string>('save_trigger_rule', { args });
  },

  loadTriggerRules: (): Promise<TriggerRule[]> => {
    return invoke<TriggerRule[]>('load_trigger_rules');
  },

  deleteTriggerRule: (ruleId: string): Promise<void> => {
    return invoke<void>('delete_trigger_rule', { ruleId });
  },

  savePortPreset: (args: PortPreset): Promise<string> => {
    return invoke<string>('save_port_preset', { args });
  },

  loadPortPresets: (): Promise<PortPreset[]> => {
    return invoke<PortPreset[]>('load_port_presets');
  },

  deletePortPreset: (presetId: string): Promise<void> => {
    return invoke<void>('delete_port_preset', { presetId });
  },

  savePortToolConfig: (args: PortToolConfig): Promise<string> => {
    return invoke<string>('save_port_tool_config', { args });
  },

  loadPortToolConfigs: (): Promise<PortToolConfig[]> => {
    return invoke<PortToolConfig[]>('load_port_tool_configs');
  },

  deletePortToolConfig: (configId: string): Promise<void> => {
    return invoke<void>('delete_port_tool_config', { configId });
  },

  /** 整体替换保存串口分组布局（issue #2-3，前端分组变更后防抖调用）。
   *  读取随 get_config 返回的 AppConfig.portGroups，无单独 load 命令。 */
  savePortGroups: (groups: PortGroup[]): Promise<void> => {
    return invoke<void>('save_port_groups', { args: groups });
  },

  /** 整体替换保存串口备注名 / 隐藏状态（issue #4-9，前端端口元数据变更后防抖调用）。
   *  读取随 get_config 返回的 AppConfig.portMeta，无单独 load 命令。 */
  savePortMeta: (meta: PortMetaEntry[]): Promise<void> => {
    return invoke<void>('save_port_meta', { args: meta });
  },
};

// ==================== 诊断日志命令 ====================

/** 前端转发到后端诊断日志文件的条目（与后端日志同文件）。 */
export interface DiagLogEntry {
  timestamp: string;
  level: string;
  message: string;
}

export const diagLogService = {
  /** 返回诊断日志活跃文件路径。 */
  getDiagLogPath: (): Promise<string> => invoke<string>('get_diag_log_path'),

  /** 读取最近 `limit` 行诊断日志（缺省 2000）。 */
  readDiagLog: (limit?: number): Promise<string> =>
    invoke<string>('read_diag_log', { limit }),

  /** 清空全部诊断日志（活跃文件 + 轮转备份）。 */
  clearDiagLog: (): Promise<void> => invoke<void>('clear_diag_log'),

  /** 追加一批前端 `console.*` 日志到诊断日志文件。 */
  appendDiagLog: (entries: DiagLogEntry[]): Promise<void> =>
    invoke<void>('append_diag_log', { entries }),
};

// ==================== 外部工具命令 ====================

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

// ==================== 柔性工作区 · 弹出窗命令 ====================

export const popoutService = {
  /** 打开（或聚焦已存在的）弹出窗。kind: "quick-send" | "terminal"。 */
  openPopout: (kind: string, targetId?: string | null): Promise<void> => {
    return invoke<void>('open_popout', { kind, targetId: targetId ?? null });
  },

  /** 关闭弹出窗（label 由 popoutLabel() 计算）。 */
  closePopout: (label: string): Promise<void> => {
    return invoke<void>('close_popout', { label });
  },

  /** 切换弹出窗置顶。 */
  setAlwaysOnTop: (label: string, on: boolean): Promise<void> => {
    return invoke<void>('set_popout_always_on_top', { label, on });
  },
};

// ==================== 柔性工作区 · 弹出窗意图事件 ====================
// 弹出窗是独立 webview、自带 store 实例——窗口间不共享可变前端态，只交换
// "意图/事件"。发送必须经 `popout:send-command` 回到主窗走 sendToPort 管线
// （TX 回显 / 流量统计 / 发送历史全在主窗产生，弹窗直连后端会丢失它们）。
// 命令集变更携带完整 `SendCommandSet[]` 载荷：主窗 `useRuleStore` 是唯一真相
// （config.json 异步落盘，未保存的编辑不在盘上），弹窗直接消费载荷而非回库重读，
// 否则配置弹窗里未点"保存"的编辑不会同步到快捷发送窗口。

/** 弹窗请求主窗发送一条命令。不含 portId——主窗发送到自己的活动标签。 */
export interface PopoutSendCommandPayload {
  content: string;
  isHex: boolean;
  lineEnding: string;
}

/** 弹窗请求主窗打开 ConfigModal 指定页（如 'commands'）。 */
export interface PopoutOpenConfigPayload {
  page: string;
}

/** 主窗活动标签变化 → 弹窗更新"发送到 ● COMx"指示。 */
export interface ActiveTabChangedPayload {
  portId: string | null;
}

/** 终端弹窗 → 主窗：挂载完成，请求一次性历史快照（request→reply 避免竞态）。 */
export interface PopoutTerminalRequestSnapshotPayload {
  portId: string;
}

/** 主窗 → 终端弹窗：当前终端缓冲 + 显示态快照（一次性）。 */
export interface PopoutTerminalSnapshotPayload {
  portId: string;
  terminal: TerminalState;
}

/** 主窗(Rust) → 主窗(前端)：某终端弹出窗已关闭 → 回贴标签。 */
export interface PopoutTerminalClosedPayload {
  portId: string;
}

export const popoutEventService = {
  /** 弹窗 → 主窗：请求发送。 */
  onSendCommand: (callback: (payload: PopoutSendCommandPayload) => void) => {
    return listen<PopoutSendCommandPayload>('popout:send-command', (event) => {
      callback(event.payload);
    });
  },

  /** 弹窗 → 主窗：请求打开配置弹窗指定页。 */
  onOpenConfig: (callback: (payload: PopoutOpenConfigPayload) => void) => {
    return listen<PopoutOpenConfigPayload>('popout:open-config', (event) => {
      callback(event.payload);
    });
  },

  /** 主窗 → 弹窗：命令集已变更（携带完整命令集载荷，弹窗直接消费）。 */
  onCommandSetsChanged: (callback: (sets: SendCommandSet[]) => void) => {
    return listen<SendCommandSet[]>('command-sets:changed', (event) => {
      callback(event.payload);
    });
  },

  /** 主窗 → 弹窗：活动标签已变更。 */
  onActiveTabChanged: (callback: (payload: ActiveTabChangedPayload) => void) => {
    return listen<ActiveTabChangedPayload>('active-tab:changed', (event) => {
      callback(event.payload);
    });
  },

  /** 弹窗 → 主窗：挂载完成，请求一次状态对表（主窗回放 active-tab:changed）。 */
  onRequestSync: (callback: () => void) => {
    return listen<null>('popout:request-sync', () => {
      callback();
    });
  },

  /** 终端弹窗 → 主窗：请求历史快照。 */
  onTerminalRequestSnapshot: (callback: (payload: PopoutTerminalRequestSnapshotPayload) => void) => {
    return listen<PopoutTerminalRequestSnapshotPayload>('popout:terminal:request-snapshot', (event) => {
      callback(event.payload);
    });
  },

  /** 主窗 → 终端弹窗：回推历史快照。 */
  onTerminalSnapshot: (callback: (payload: PopoutTerminalSnapshotPayload) => void) => {
    return listen<PopoutTerminalSnapshotPayload>('popout:terminal:snapshot', (event) => {
      callback(event.payload);
    });
  },

  /** 主窗(Rust) → 主窗(前端)：终端弹出窗关闭 → 回贴标签。 */
  onTerminalClosed: (callback: (payload: PopoutTerminalClosedPayload) => void) => {
    return listen<PopoutTerminalClosedPayload>('popout:terminal:closed', (event) => {
      callback(event.payload);
    });
  },

  emitSendCommand: (payload: PopoutSendCommandPayload): Promise<void> => {
    return emit('popout:send-command', payload);
  },

  emitOpenConfig: (payload: PopoutOpenConfigPayload): Promise<void> => {
    return emit('popout:open-config', payload);
  },

  emitCommandSetsChanged: (sets: SendCommandSet[]): Promise<void> => {
    return emit('command-sets:changed', sets);
  },

  emitActiveTabChanged: (payload: ActiveTabChangedPayload): Promise<void> => {
    return emit('active-tab:changed', payload);
  },

  emitRequestSync: (): Promise<void> => {
    return emit('popout:request-sync');
  },

  /** 终端弹窗 → 主窗：请求历史快照。 */
  emitTerminalRequestSnapshot: (payload: PopoutTerminalRequestSnapshotPayload): Promise<void> => {
    return emit('popout:terminal:request-snapshot', payload);
  },

  /** 主窗 → 终端弹窗：回推历史快照。 */
  emitTerminalSnapshot: (payload: PopoutTerminalSnapshotPayload): Promise<void> => {
    return emit('popout:terminal:snapshot', payload);
  },
};