/**
 * 柔性工作区 · 弹出窗命令与窗口间意图事件。
 *
 * 弹出窗是独立 webview、自带 store 实例——窗口间不共享可变前端态，只交换
 * "意图/事件"。发送必须经 `popout:send-command` 回到主窗走 sendToPort 管线
 * （TX 回显 / 流量统计 / 发送历史全在主窗产生，弹窗直连后端会丢失它们）。
 * Committed command snapshots remain separate from the main-owned versioned
 * editor draft. Editing requests are acknowledged only after main has applied
 * the operation (and, for save, finished persistence).
 *
 * 参数约定见 `./tauri.ts` 文件头。
 */
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import type { SendCommandSet, TerminalLine, TerminalState } from '../types';
import type { EntityEditorSnapshot } from '../utils/entityEditor';


interface PopoutLane {
  desiredOpen: boolean;
  revision: number;
  closing: boolean;
  ignoreNativeClose: boolean;
  pending: Promise<void> | null;
}
const lanes = new Map<string, PopoutLane>();

/** Desired state changes immediately; one lane owns native open/close order. */
function transitionPopout(kind: string, targetId: string | null, open: boolean, isDesired?: () => boolean): Promise<void> {
  const key = JSON.stringify([kind, kind === 'quick-send' ? null : targetId]);
  let lane = lanes.get(key);
  if (!lane) {
    lane = { desiredOpen: open, revision: 0, closing: false, ignoreNativeClose: !open, pending: null };
    lanes.set(key, lane);
  }
  lane.desiredOpen = open;
  if (!open) lane.ignoreNativeClose = true;
  lane.revision++;
  if (lane.pending) return lane.pending;

  const owner = lane;
  const run = async (): Promise<void> => {
    for (;;) {
      const revision = owner.revision;
      const desiredOpen = owner.desiredOpen;
      if (desiredOpen) {
        if (isDesired && !isDesired()) {
          owner.desiredOpen = false;
          continue;
        }
        try {
          await invoke<void>('open_popout', { kind, targetId });
        } catch (error) {
          if (revision !== owner.revision) continue;
          owner.desiredOpen = false;
          throw error;
        }
      } else {
        owner.closing = true;
        try {
          await invoke<void>('close_popout', { kind, targetId });
        } catch (error) {
          if (revision !== owner.revision) continue;
          throw error;
        } finally {
          owner.closing = false;
        }
      }

      if (revision === owner.revision && owner.desiredOpen === desiredOpen &&
        (!desiredOpen || !isDesired || isDesired())) {
        if (desiredOpen) owner.ignoreNativeClose = false;
        owner.pending = null;
        if (!owner.desiredOpen) lanes.delete(key);
        return;
      }
      // A newer desired state arrived while native work was pending. Loop
      // without exposing the intermediate close/open completion to callers.
    }
  };
  const pending = run();
  owner.pending = pending;
  void pending.then(() => {}, () => {}).finally(() => {
    if (owner.pending === pending) {
      owner.pending = null;
      if (!owner.desiredOpen) lanes.delete(key);
    }
  });
  return pending;
}
export const popoutService = {
  /** 打开（或聚焦已存在的）弹出窗。kind: "quick-send" | "terminal"。 */
  openPopout: (kind: string, targetId?: string | null, isDesired?: () => boolean): Promise<void> => {
    return transitionPopout(kind, targetId ?? null, true, isDesired);
  },

  /**
   * 关闭弹出窗。窗口 label 由 Rust 的 `compute_label` 从 kind + targetId 算出
   * （唯一权威，前端不复刻 sanitize——复制一份迟早与后端漂移，命令就会找不到窗口）。
   */
  closePopout: (kind: string, targetId?: string | null): Promise<void> => {
    return transitionPopout(kind, targetId ?? null, false);
  },

  /** Native close signals from our own teardown must not retire a newer open. */
  terminalClosed(portId: string): boolean {
    const key = JSON.stringify(['terminal', portId]);
    const lane = lanes.get(key);
    if (!lane) return true;
    if (lane.closing || lane.ignoreNativeClose) return false;
    lane.desiredOpen = false;
    lane.revision++;
    if (!lane.pending) lanes.delete(key);
    return true;
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

export type CommandEditorSnapshot = EntityEditorSnapshot<SendCommandSet> & {
  sessionId: string;
  clientProtocol?: 2;
  clientId?: string;
  challengeId?: string;
  syncRequestId?: string;
};

export type CommandEditorAction = {
  sessionId: string;
  version: number;
  clientId?: string;
  overwrite?: boolean;
  id?: string;
  /**
   * Command-set ids the panel actually changed. The host replays only these on
   * discard; without them a panel discard would reset the whole collection and
   * silently drop unsaved edits made in the main window.
   */
  ids?: string[];
} & ({ action: 'replace'; items: SendCommandSet[] } | { action: 'save' | 'discard' });
export type CommandEditorRequest = CommandEditorAction & { requestId: string };

export interface CommandEditorResult {
  requestId: string;
  success: boolean;
  error: string | null;
  snapshot: CommandEditorSnapshot;
}

export interface CommandEditorClientIdentity { clientId: string; sessionId: string; sequence: number }
export interface CommandEditorClientState extends CommandEditorClientIdentity { unresolved: boolean }
export interface CommandEditorSyncRequest extends CommandEditorClientIdentity { challengeId?: string; syncRequestId?: string; resetUndo?: boolean }
// Optional identity is only for compatibility with legacy panels/test clients.
export interface CommandEditorClientRequest extends Partial<CommandEditorClientIdentity> { requestId: string; action: 'save' | 'discard' }
export interface CommandEditorClientResult extends Partial<CommandEditorClientState> { requestId: string; success: boolean; error: string | null }

export const COMMAND_EDITOR_TIMEOUT_MS = 15_000;

/** Register before emitting; late listener registration is retired on timeout. */
function requestEditorEvent<Result extends { requestId: string }>(requestEvent: string, resultEvent: string, request: object, accepts: (result: Result) => boolean = () => true): Promise<Result> {
  const requestId = crypto.randomUUID();
  // ES2020/WebView baseline does not guarantee Promise.withResolvers.
  let resolve!: (result: Result) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Result>((done, fail) => { resolve = done; reject = fail; });
  let settled = false;
  let unlisten: (() => void) | undefined;
  const finish = (result?: Result, error?: unknown) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    unlisten?.();
    if (result) resolve(result);
    else reject(error);
  };
  const timer = setTimeout(() => finish(undefined, new Error('editor.saveFailed')), COMMAND_EDITOR_TIMEOUT_MS);
  void listen<Result>(resultEvent, event => {
    if (event.payload.requestId === requestId && accepts(event.payload)) finish(event.payload);
  }).then(stop => {
    if (settled) { stop(); return; }
    unlisten = stop;
    return emit(requestEvent, { ...request, requestId });
  }).catch(error => finish(undefined, error));
  return promise;
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

/** 主窗保存软件界面缩放后，通知已打开的独立 WebView。 */
export interface UiScaleChangedPayload {
  percent: number;
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

  onCommandEditorRequest: (callback: (payload: CommandEditorRequest) => void) => {
    return listen<CommandEditorRequest>('popout:command-editor-request', event => callback(event.payload));
  },

  onCommandEditorSnapshot: (callback: (snapshot: CommandEditorSnapshot) => void) => {
    return listen<CommandEditorSnapshot>('command-editor:snapshot', event => callback(event.payload));
  },

  requestCommandEditor: (request: CommandEditorAction) => requestEditorEvent<CommandEditorResult>('popout:command-editor-request', 'command-editor:result', request),
  requestCommandEditorClientLeave: (action: 'save' | 'discard', identity?: CommandEditorClientIdentity) => requestEditorEvent<CommandEditorClientResult>(
    'command-editor:client-leave', 'command-editor:client-result', { action, ...identity },
    result => !identity || result.clientId === identity.clientId && result.sessionId === identity.sessionId &&
      Number.isSafeInteger(result.sequence) && result.sequence! >= identity.sequence,
  ),
  onCommandEditorClientLeave: (callback: (request: CommandEditorClientRequest) => void) => listen<CommandEditorClientRequest>('command-editor:client-leave', event => callback(event.payload)),
  emitCommandEditorClientResult: (result: CommandEditorClientResult): Promise<void> => emit('command-editor:client-result', result),
  onCommandEditorClientState: (callback: (state: CommandEditorClientState | boolean) => void) => listen<CommandEditorClientState | boolean>('command-editor:client-state', event => callback(event.payload)),
  emitCommandEditorClientState: (state: CommandEditorClientState | boolean): Promise<void> => emit('command-editor:client-state', state),

  emitCommandEditorSnapshot: (snapshot: CommandEditorSnapshot): Promise<void> => emit('command-editor:snapshot', snapshot),
  emitCommandEditorResult: (result: CommandEditorResult): Promise<void> => emit('command-editor:result', result),

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
  onRequestSync: (callback: (request?: CommandEditorSyncRequest) => void) => {
    return listen<CommandEditorSyncRequest | null>('popout:request-sync', event => {
      callback(event.payload ?? undefined);
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

  onUiScaleChanged: (callback: (payload: UiScaleChangedPayload) => void) => {
    return listen<UiScaleChangedPayload>('ui-scale:changed', (event) => {
      callback(event.payload);
    });
  },

  emitSendCommand: (payload: PopoutSendCommandPayload): Promise<void> => {
    return emit('popout:send-command', payload);
  },

  emitOpenConfig: (payload: PopoutOpenConfigPayload): Promise<void> => {
    return emit('popout:open-config', payload);
  },

  /** Committed sets only; editor consumers use command-editor:snapshot. */

  emitCommandSetsChanged: (sets: SendCommandSet[]): Promise<void> => {
    return emit('command-sets:changed', sets);
  },

  emitActiveTabChanged: (payload: ActiveTabChangedPayload): Promise<void> => {
    return emit('active-tab:changed', payload);
  },

  emitRequestSync: (identity?: CommandEditorSyncRequest): Promise<void> => {
    return identity ? emit('popout:request-sync', identity) : emit('popout:request-sync');
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

  emitUiScaleChanged: (percent: number): Promise<void> => {
    return emit('ui-scale:changed', { percent });
  },
};
