import { useEffect } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { useOperationStore } from '../stores/useOperationStore';
import { useTerminalStore } from '../stores/useTerminalStore';
import { serialService, eventService } from '../services/tauri';
import type { SerialReconnectHintEvent } from '../services/tauri';
import { notifyError, notifySuccess, extractErrorMessage, useToastStore } from '../stores/useToastStore';
import { userClosingPortIds, lostPortIds } from './disconnectTracking';
import { ttyService } from '../utils/ttyService';

/** 连接状态机与重连提示监听的模块级共享状态。 */
type PortIntent = 'open' | 'close' | 'reconnect' | 'terminal';
interface PortOperation {
  generation: number;
  intent: PortIntent;
  queue: Promise<void>;
  active: boolean;
}
const state = {
  portOps: new Map<string, PortOperation>(),
  reconnecting: new Set<string>(),
  hintSubscribers: 0,
  hintUnlisten: null as (() => void) | null,
  hintRegistering: null as Promise<() => void> | null,
  hintRetryTimer: null as number | null,
};

/** 重连退避：翻倍增长，上限 5s。 */
function nextReconnectDelay(previousMs: number): number {
  return Math.min(previousMs * 2, 5000);
}

/**
 * 连接参数解析的唯一实现：端口上已存的值优先（会话恢复 / 每端口预设），
 * 缺省回落到操作面板的全局默认。dtr/rts 是全局态（不按端口存）。
 */
function resolveConnectionParams(portId: string) {
  const opStore = useOperationStore.getState();
  const port = useAppStore.getState().ports.find((p) => p.id === portId);
  return {
    baudRate: port?.baudRate ?? opStore.baudRate,
    dataBits: port?.dataBits ?? opStore.dataBits,
    parity: port?.parity ?? opStore.parity,
    stopBits: port?.stopBits ?? opStore.stopBits,
    handshake: port?.handshake ?? opStore.handshake,
  };
}

/** 连接成功后的统一副作用；日志由后端连接生命周期管理。 */
function applyConnectedSideEffects(portId: string): void {
  const params = resolveConnectionParams(portId);
  useAppStore.getState().updatePort(portId, {
    status: 'connected',
    // Wait for the connected status event to carry the new generation; a
    // stale value here would reject an immediate send after reconnect.
    connectionGeneration: undefined,
    ...params,
  });
  useTerminalStore.getState().setTerminalConnectedAt(portId, Date.now());
}

/** 将所有端口意图排入同一串行 lane；新意图会使排队的旧完成结果失效。 */
function enqueuePortOp(portId: string, intent: Exclude<PortIntent, 'terminal'>, op: (generation: number) => Promise<void>): Promise<void> {
  const previous = state.portOps.get(portId);
  if (previous?.active && previous.intent === intent) return previous.queue;
  const generation = (previous?.generation ?? 0) + 1;
  const prior = previous?.queue ?? Promise.resolve();
  const queued = prior.catch(() => undefined).then(async () => {
    const current = state.portOps.get(portId);
    if (!current || current.generation !== generation) return;
    await op(generation);
  });
  state.portOps.set(portId, { generation, intent, queue: queued, active: true });
  void queued.then(
    () => { const current = state.portOps.get(portId); if (current?.generation === generation && current.queue === queued) current.active = false; },
    () => { const current = state.portOps.get(portId); if (current?.generation === generation && current.queue === queued) current.active = false; },
  );
  return queued;
}

function isCurrentOperation(portId: string, generation: number): boolean {
  return state.portOps.get(portId)?.generation === generation;
}

/** 状态事件是终态权威；它使在飞 open/reconnect 完成不能覆盖断线。 */
export function acceptSerialStatus(portId: string, status: string): boolean {
  const current = state.portOps.get(portId);
  const port = useAppStore.getState().ports.find((item) => item.id === portId);
  if (status === 'connected' && (current?.intent === 'close' || (current?.intent === 'terminal' && !port?.toolRunning))) return false;
  if (status === 'connected' && current?.intent === 'terminal' && port?.toolRunning) {
    state.portOps.set(portId, { ...current, intent: 'open' });
  }
  if (status === 'disconnected' || status === 'error') {
    const generation = (current?.generation ?? 0) + 1;
    state.portOps.set(portId, {
      generation,
      intent: 'terminal',
      queue: current?.queue ?? Promise.resolve(),
      active: false,
    });
  }
  return true;
}

/**
 * 自动重连循环：退避重试直到成功 / 重试次数用尽 / 用户主动关闭。
 *
 * 用户意图优先：**每一轮开头**都要检查 `userClosingPortIds`——后端在
 * `serial:reconnect_hint` 之前已经发过 `serial:status(disconnected)`，此时
 * `port.status` 早就不是 connected，用状态判断会让循环在 attempt=0 就永不启动，
 * 也会在用户手动断开后把刚关掉的端口重新打开。
 */
async function runReconnectLoop(portId: string): Promise<void> {
  if (state.reconnecting.has(portId)) return;
  const { autoReconnect, maxRetries } = useAppStore.getState().config;
  if (!autoReconnect) return;
  state.reconnecting.add(portId);
  let delayMs = 500;
  try {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (userClosingPortIds.has(portId)) break;
      if (attempt > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        if (userClosingPortIds.has(portId)) break;
      }
      let succeeded = false;
      let opGeneration = -1;
      try {
        await enqueuePortOp(portId, 'reconnect', async (generation) => {
          opGeneration = generation;
          await serialService.attemptReconnect(portId);
          if (!isCurrentOperation(portId, generation) || userClosingPortIds.has(portId)) return;
          applyConnectedSideEffects(portId);
          lostPortIds.delete(portId);
          succeeded = true;
        });
      } catch (err) {
        // Compare against the generation this attempt actually ran with. The
        // previous check compared the current generation with itself and was
        // always true, so a manual open/close could not stop the retry loop.
        if (
          userClosingPortIds.has(portId) ||
          opGeneration < 0 ||
          !isCurrentOperation(portId, opGeneration) ||
          state.portOps.get(portId)?.intent !== 'reconnect'
        ) break;
        useToastStore.getState().push({
          severity: 'error',
          messageKey: 'toast.reconnect.failed',
          message: extractErrorMessage(err),
          portId,
        });
        if (attempt >= maxRetries - 1) break;
        delayMs = nextReconnectDelay(delayMs);
        continue;
      }
      if (succeeded) {
        notifySuccess('toast.reconnect.succeeded');
        break;
      }
      // A newer manual open/close or terminal status owns the port now.
      break;
    }
  } finally {
    state.reconnecting.delete(portId);
  }
}

/**
 * 重连提示监听的引用计数安装：Sidebar / Pane / OperationPanel / useHotkeys
 * 都会调用 `useSerialConnection()`，但事件监听只能有一份（重复注册会让一次
 * 重连提示触发多套循环）。
 */
function ensureReconnectHintListener(): void {
  if (state.hintSubscribers === 0 || state.hintUnlisten || state.hintRegistering) return;
  const registration = eventService.onSerialReconnectHint((event: SerialReconnectHintEvent) => {
    if (state.hintRegistering !== registration || state.hintSubscribers === 0) return;
    void runReconnectLoop(event.port_name);
  });
  state.hintRegistering = registration;
  registration.then((unlisten) => {
    if (state.hintRegistering !== registration || state.hintSubscribers === 0) {
      unlisten();
      return;
    }
    state.hintUnlisten = unlisten;
  }).catch((e) => {
    if (state.hintRegistering !== registration) return;
    state.hintRegistering = null;
    console.debug('[useSerialConnection] Failed to register reconnect hint listener:', e);
      state.hintRetryTimer = window.setTimeout(() => {
        state.hintRetryTimer = null;
        ensureReconnectHintListener();
      }, 250);
  });
}

function acquireReconnectHintListener(): () => void {
  state.hintSubscribers += 1;
  ensureReconnectHintListener();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.hintSubscribers = Math.max(0, state.hintSubscribers - 1);
    if (state.hintSubscribers > 0) return;
    if (state.hintRetryTimer) {
      clearTimeout(state.hintRetryTimer);
      state.hintRetryTimer = null;
    }
    if (state.hintUnlisten) {
      state.hintUnlisten();
      state.hintUnlisten = null;
    }
    state.hintRegistering = null;
  };
}

/** 打开端口：置 connecting → 后端 open → 连接后副作用。 */
async function openPort(portId: string): Promise<void> {
  userClosingPortIds.delete(portId);
  lostPortIds.delete(portId);
  await enqueuePortOp(portId, 'open', async (generation) => {
    const live = useAppStore.getState().ports.find((p) => p.id === portId);
    // A reconnect attempt may have opened the port after this open was queued;
    // issuing open_serial_port again would produce "Port ... is already open".
    if (!live || live.status === 'connected' || live.status === 'connecting') return;
    // The backend owns the port while an external tool runs (close→spawn→reopen).
    if (live.toolRunning) return;
    const params = resolveConnectionParams(portId);
    useAppStore.getState().updatePort(portId, { status: 'connecting' });
    const ttyState = ttyService.get(portId);
    const ttySize = ttyState?.lastCols != null && ttyState.lastRows != null
      ? { cols: ttyState.lastCols, rows: ttyState.lastRows }
      : {};
    try {
      await serialService.openSerialPort({
        portId,
        ...params,
        dtr: useOperationStore.getState().dtr,
        rts: useOperationStore.getState().rts,
        ...ttySize,
      });
      if (isCurrentOperation(portId, generation)) applyConnectedSideEffects(portId);
    } catch (err) {
      if (!isCurrentOperation(portId, generation)) return;
      console.error('[useSerialConnection] Failed to open port:', err);
      // A reconnect (or the backend itself) may have won the race to open the
      // port. Reflect the live session instead of a sticky error state.
      if (String(err).includes('is already open')) {
        applyConnectedSideEffects(portId);
        return;
      }
      notifyError(err);
      useAppStore.getState().updatePort(portId, { status: 'error' });
    }
  });
}

/** 关闭端口：用户意图优先于在飞重连，日志由后端连接生命周期管理。 */
async function closePort(portId: string): Promise<void> {
  userClosingPortIds.add(portId);
  lostPortIds.delete(portId);
  await enqueuePortOp(portId, 'close', async (generation) => {
    try {
      await serialService.closeSerialPort(portId);
      if (isCurrentOperation(portId, generation)) {
        useAppStore.getState().updatePort(portId, { status: 'disconnected' });
      }
    } catch (err) {
      if (!isCurrentOperation(portId, generation)) return;
      console.error('[useSerialConnection] Failed to close port:', err);
      notifyError(err);
      useAppStore.getState().updatePort(portId, { status: 'error' });
    }
  });
}

async function toggleConnection(portId: string): Promise<void> {
  const port = useAppStore.getState().ports.find((p) => p.id === portId);
  if (!port || port.status === 'connecting') return;
  if (port.status === 'connected') {
    await closePort(portId);
  } else {
    await openPort(portId);
  }
}

export interface SerialConnectionActions {
  openPort: (portId: string) => Promise<void>;
  closePort: (portId: string) => Promise<void>;
  toggleConnection: (portId: string) => Promise<void>;
}

/**
 * Hook: 串口连接/断开操作
 *
 * 状态机本体在模块级（每端口一个 runtime + 全局唯一的重连监听），hook 只负责
 * 订阅重连提示监听的生命周期。返回签名与调用点（Sidebar / Pane /
 * OperationPanel / useHotkeys）保持不变。
 */
export function useSerialConnection(): SerialConnectionActions {
  // 订阅一次重连提示事件（引用计数，避免多实例重复监听）
  useEffect(() => acquireReconnectHintListener(), []);

  return { openPort, closePort, toggleConnection };
}
