import { useEffect } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { useOperationStore } from '../stores/useOperationStore';
import { useTerminalStore } from '../stores/useTerminalStore';
import { serialService, eventService, logService } from '../services/tauri';
import type { SerialReconnectHintEvent } from '../services/tauri';
import { notifyError, notifySuccess, extractErrorMessage, useToastStore } from '../stores/useToastStore';
import { userClosingPortIds, lostPortIds } from './disconnectTracking';
import { ttyService } from '../utils/ttyService';

/**
 * 每端口连接状态机 + 全应用唯一的「重连提示」监听登记。
 *
 * 这四类状态原先散落在 4 个各自独立的模块级变量里（`reconnectingPorts` /
 * `reconnectHintListenerCount` / `pendingReconnectHintUnlisten` / `portOpInFlight`），
 * 谁都能读写，于是先后长出「同一端口并发 open」「监听器泄漏」「重连循环双开」
 * 这类只能靠 review 发现的缺陷。现在它们收在一个 state 对象里，只由本文件的
 * 函数触碰；「连接成功后的副作用」也只有一份实现（手动 open 与自动重连共用）。
 */
const state = {
  /** 每端口在飞的连接操作：同一事件循环内连点两次不得并发 open 同一句柄。 */
  opsInFlight: new Set<string>(),
  /** 正在退避重连的端口（同一端口不叠加第二套循环）。 */
  reconnecting: new Set<string>(),
  /** 重连提示监听的订阅者数（Sidebar / Pane / OperationPanel 各调一次 hook）。 */
  hintSubscribers: 0,
  hintUnlisten: null as (() => void) | null,
  /** 注册仍在飞（异步 listen）时的句柄，卸载竞态下用它补注销。 */
  hintRegistering: null as Promise<() => void> | null,
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

/**
 * 连接成功后的统一副作用（手动 open 与自动重连共用一份）。
 *
 * 后端「已连接」是既成事实，store 的 status 与日志生命周期必须跟上：漏掉这里
 * 会让 status 停在与后端不一致的状态（TabBar/按钮显示成未连接），且
 * `autoSaveLog` 开启时掉线重连后日志静默不再落盘。
 */
function applyConnectedSideEffects(portId: string): void {
  const params = resolveConnectionParams(portId);
  useAppStore.getState().updatePort(portId, { status: 'connected', ...params });
  useTerminalStore.getState().setTerminalConnectedAt(portId, Date.now());
  if (useAppStore.getState().config.autoSaveLog) {
    logService.startLogging(portId).catch((e) => {
      console.debug('[useSerialConnection] startLogging failed:', e);
      notifyError(e);
    });
  }
}

/** 连接操作（open/close）的并发保护：同一端口在飞期间后续调用直接 no-op。 */
async function runPortOp(portId: string, op: () => Promise<void>): Promise<void> {
  if (state.opsInFlight.has(portId)) return;
  state.opsInFlight.add(portId);
  try {
    await op();
  } finally {
    state.opsInFlight.delete(portId);
  }
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
  if (state.reconnecting.has(portId)) return; // 同一端口不并行两套循环
  const { autoReconnect, maxRetries } = useAppStore.getState().config;
  if (!autoReconnect) return;
  state.reconnecting.add(portId);

  let delayMs = 500;
  try {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (userClosingPortIds.has(portId)) break;
      // First attempt runs immediately; backoff only applies between retries.
      if (attempt > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
      try {
        await serialService.attemptReconnect(portId);
      } catch (err) {
        useToastStore.getState().push({
          severity: 'error',
          messageKey: 'toast.reconnect.failed',
          message: extractErrorMessage(err),
          // issue #7-1：通知中心展示消息来源串口。
          portId,
        });
        if (attempt >= maxRetries - 1) break;
        delayMs = nextReconnectDelay(delayMs);
        continue;
      }
      // P0-2：attemptReconnect 在飞期间用户可能点了「断开」——closePort 已执行
      // 但本 await 才返回。若不复查，端口会被强行标回 connected、日志重启、弹
      // 「重连成功」，与用户意图及后端实际状态背离。
      if (userClosingPortIds.has(portId)) break;
      applyConnectedSideEffects(portId);
      // Reconnected — the port is no longer lost; hide the banner.
      lostPortIds.delete(portId);
      notifySuccess('toast.reconnect.succeeded');
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
function acquireReconnectHintListener(): () => void {
  state.hintSubscribers += 1;
  if (state.hintSubscribers === 1) {
    state.hintRegistering = eventService.onSerialReconnectHint((event: SerialReconnectHintEvent) => {
      runReconnectLoop(event.port_name);
    });
    state.hintRegistering
      .then((unlisten) => {
        state.hintUnlisten = unlisten;
      })
      .catch((e) => {
        console.debug('[useSerialConnection] Failed to register reconnect hint listener:', e);
      });
  }
  return () => {
    state.hintSubscribers -= 1;
    if (state.hintSubscribers > 0) return;
    if (state.hintUnlisten) {
      state.hintUnlisten();
      state.hintUnlisten = null;
    } else if (state.hintRegistering) {
      // 所有订阅者在注册 resolve 之前就卸载了——注册一到手就注销，否则泄漏。
      state.hintRegistering.then((unlisten) => unlisten()).catch(() => {});
    }
    state.hintRegistering = null;
  };
}

/** 打开端口：置 connecting → 后端 open（TTY 端口带上当前 xterm 尺寸）→ 连接后副作用。 */
async function openPort(portId: string): Promise<void> {
  await runPortOp(portId, async () => {
    // Reconnecting overrides any prior user-initiated close mark so the
    // DisconnectBanner / status toast resume normal unexpected-disconnect
    // detection for this port, and a deliberate (re)connect clears the lost
    // mark so the banner hides the moment the user retries a dropped port.
    userClosingPortIds.delete(portId);
    lostPortIds.delete(portId);

    const params = resolveConnectionParams(portId);
    useAppStore.getState().updatePort(portId, { status: 'connecting' });
    // issue #11：TTY 模拟终端（GIT:BASH）打开时带上当前 xterm 尺寸——pty 以
    // 正确尺寸 spawn，vim/top 全屏应用才按真实显示尺寸渲染（否则 pty 固定
    // 80×24，画面错乱）。无 TTY 状态/未 fit 时省略参数，后端回退 80×24。
    const ttyState = ttyService.get(portId);
    const ttySize =
      ttyState?.lastCols != null && ttyState.lastRows != null
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
      applyConnectedSideEffects(portId);
    } catch (err) {
      console.error('[useSerialConnection] Failed to open port:', err);
      notifyError(err);
      useAppStore.getState().updatePort(portId, { status: 'error' });
    }
  });
}

/** 关闭端口：标记用户主动关闭（抑制掉线告警）→ 后端 close → 停日志。 */
async function closePort(portId: string): Promise<void> {
  await runPortOp(portId, async () => {
    // Mark this port as user-initiated close so the serial:status event
    // handler and DisconnectBanner suppress the "unexpected disconnect"
    // toast/banner. The mark is PERSISTENT and cleared on the next reconnect
    // (openPort) — a timer-based removal made the banner false-alarm on a
    // deliberately disconnected port whose tab was still open.
    userClosingPortIds.add(portId);
    // User-initiated close is never "lost" — clear any stale mark.
    lostPortIds.delete(portId);
    try {
      await serialService.closeSerialPort(portId);
      useAppStore.getState().updatePort(portId, { status: 'disconnected' });
      logService.stopLogging(portId).catch((e) =>
        console.debug('[useSerialConnection] stopLogging failed:', e)
      );
    } catch (err) {
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

/**
 * Hook: 串口连接/断开操作
 *
 * 状态机本体在模块级（每端口一个 runtime + 全局唯一的重连监听），hook 只负责
 * 订阅重连提示监听的生命周期。返回签名与调用点（Sidebar / Pane /
 * OperationPanel / useHotkeys）保持不变。
 */
export function useSerialConnection() {
  // 订阅一次重连提示事件（引用计数，避免多实例重复监听）
  useEffect(() => acquireReconnectHintListener(), []);

  return { openPort, closePort, toggleConnection };
}
