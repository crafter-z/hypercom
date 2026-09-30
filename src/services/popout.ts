/**
 * 柔性工作区 · 弹出窗命令与窗口间意图事件。
 *
 * 弹出窗是独立 webview、自带 store 实例——窗口间不共享可变前端态，只交换
 * "意图/事件"。发送必须经 `popout:send-command` 回到主窗走 sendToPort 管线
 * （TX 回显 / 流量统计 / 发送历史全在主窗产生，弹窗直连后端会丢失它们）。
 * 命令集变更携带完整 `SendCommandSet` 载荷：主窗 `useRuleStore` 是唯一真相
 * （config.json 异步落盘，未保存的编辑不在盘上），弹窗直接消费载荷而非回库重读，
 * 否则配置弹窗里未点"保存"的编辑不会同步到快捷发送窗口。
 *
 * 参数约定见 `./tauri.ts` 文件头。
 */
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import type { SendCommandSet, TerminalLine, TerminalState } from '../types';

export const popoutService = {
  /** 打开（或聚焦已存在的）弹出窗。kind: "quick-send" | "terminal"。 */
  openPopout: (kind: string, targetId?: string | null): Promise<void> => {
    return invoke<void>('open_popout', { kind, targetId: targetId ?? null });
  },

  /**
   * 关闭弹出窗。窗口 label 由 Rust 的 `compute_label` 从 kind + targetId 算出
   * （唯一权威，前端不复刻 sanitize——复制一份迟早与后端漂移，命令就会找不到窗口）。
   */
  closePopout: (kind: string, targetId?: string | null): Promise<void> => {
    return invoke<void>('close_popout', { kind, targetId: targetId ?? null });
  },

  /** 切换弹出窗置顶（label 同上由后端计算）。 */
  setAlwaysOnTop: (kind: string, targetId: string | null, on: boolean): Promise<void> => {
    return invoke<void>('set_popout_always_on_top', { kind, targetId, on });
  },
};

// ==================== 窗口间意图事件 ====================

/** 弹窗请求主窗发送一条命令。portId 缺省时主窗发送到自己的活动标签（issue #5-4-6）。 */
export interface PopoutSendCommandPayload {
  content: string;
  isHex: boolean;
  lineEnding: string;
  portId?: string;
}

/** 弹窗请求主窗打开 ConfigModal 指定页（如 'commands'）。 */
export interface PopoutOpenConfigPayload {
  page: string;
}

/** 主窗活动标签变化 → 弹窗更新"发送到 ● COMx"指示。 */
export interface ActiveTabChangedPayload {
  portId: string | null;
}

/**
 * 弹窗 → 主窗：命令集整集回传（K6）。
 *
 * 弹窗那份 store 是空的（独立 webview），写进去恒为 no-op——命令集的唯一真相
 * 在主窗 `useRuleStore`，所以编辑必须回传而非本地落库：主窗若不知道这次编辑，
 * 之后任何一次 save_config 都会用主窗自己的活实体把改动覆盖回去。
 */
export interface PopoutCommandSetUpdatedPayload {
  set: SendCommandSet;
}

/** 终端弹窗 → 主窗：挂载完成，请求一次性历史快照（request→reply 避免竞态）。 */
export interface PopoutTerminalRequestSnapshotPayload {
  portId: string;
}

/** 主窗 → 终端弹窗：当前终端缓冲 + 显示态快照（一次性）。 */
export interface PopoutTerminalSnapshotPayload {
  portId: string;
  /** 显示态（TerminalState 纯显示字段）+ 历史行（方案B：行来自环形缓冲区快照）。 */
  terminal: TerminalState & { lines: TerminalLine[] };
}

/** 主窗(Rust) → 主窗(前端)：某终端弹出窗已关闭 → 回贴标签。 */
export interface PopoutTerminalClosedPayload {
  portId: string;
}

/** 主窗 → 弹窗：全部串口连接状态快照（issue #7-5 初始态对表）。 */
export interface PortStatusSyncItem {
  portId: string;
  status: string;
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

  /** 弹窗 → 主窗：命令集编辑保存（整集回传，主窗写回 useRuleStore 活实体）。 */
  onCommandSetUpdated: (callback: (payload: PopoutCommandSetUpdatedPayload) => void) => {
    return listen<PopoutCommandSetUpdatedPayload>('popout:command-set-updated', (event) => {
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

  /** 主窗 → 弹窗：全部串口连接状态快照（request-sync 时回放，issue #7-5）。 */
  onPortStatusesSync: (callback: (payload: PortStatusSyncItem[]) => void) => {
    return listen<PortStatusSyncItem[]>('port-statuses:sync', (event) => {
      callback(event.payload);
    });
  },

  emitSendCommand: (payload: PopoutSendCommandPayload): Promise<void> => {
    return emit('popout:send-command', payload);
  },

  emitOpenConfig: (payload: PopoutOpenConfigPayload): Promise<void> => {
    return emit('popout:open-config', payload);
  },

  /** 弹窗 → 主窗：命令集编辑保存（整集，主窗按 set.id 覆盖活实体）。 */
  emitCommandSetUpdated: (set: SendCommandSet): Promise<void> => {
    return emit('popout:command-set-updated', { set });
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

  /** 主窗 → 弹窗：回放全部串口连接状态（issue #7-5）。 */
  emitPortStatusesSync: (payload: PortStatusSyncItem[]): Promise<void> => {
    return emit('port-statuses:sync', payload);
  },
};
