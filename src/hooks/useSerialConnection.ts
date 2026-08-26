import { useEffect, useCallback } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { useOperationStore } from '../stores/useOperationStore';
import { useTerminalStore } from '../stores/useTerminalStore';
import { serialService, eventService, logService } from '../services/tauri';
import type { SerialReconnectHintEvent } from '../services/tauri';
import { notifyError, notifySuccess, extractErrorMessage, useToastStore } from '../stores/useToastStore';
import { userClosingPortIds, lostPortIds } from './disconnectTracking';
import { ttyService } from '../utils/ttyService';

// ==================== Module-level auto-reconnect tracking ====================
// Prevents duplicate reconnect listeners when `useSerialConnection()` is called
// in multiple components (Sidebar + TabBar). Also tracks ports currently in a
// reconnect backoff loop so overlapping `serial:reconnect_hint` events for the
// same port do not start parallel loops.
const reconnectingPorts = new Set<string>();

function nextReconnectDelay(previousMs: number): number {
  return Math.min(previousMs * 2, 5000);
}

async function runReconnectLoop(portId: string) {
  if (reconnectingPorts.has(portId)) return;
  reconnectingPorts.add(portId);

  const { autoReconnect, maxRetries } = useAppStore.getState().config;
  if (!autoReconnect) {
    reconnectingPorts.delete(portId);
    return;
  }

  let delayMs = 500;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // User intent wins: a deliberate close (closePort) during backoff must
    // abort the loop — otherwise the next attempt would re-open a port the
    // user just closed. NOTE: do NOT check port.status here — the backend
    // emits serial:status(disconnected) BEFORE serial:reconnect_hint, so at
    // attempt=0 the store already reads 'disconnected' and this loop would
    // never fire. userClosingPortIds is the only reliable user-intent signal.
    if (userClosingPortIds.has(portId)) {
      break;
    }
    // First attempt runs immediately; backoff only applies between retries.
    if (attempt > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
    try {
      await serialService.attemptReconnect(portId);
      // Mirror openPort's post-connect side effects — attemptReconnect alone
      // leaves the store status stale and (with autoSaveLog on) silently
      // stops logging after a drop/reconnect cycle.
      const port = useAppStore.getState().ports.find((p) => p.id === portId);
      const opStore = useOperationStore.getState();
      useAppStore.getState().updatePort(portId, {
        status: 'connected',
        baudRate: port?.baudRate ?? opStore.baudRate,
        dataBits: port?.dataBits ?? opStore.dataBits,
        parity: port?.parity ?? opStore.parity,
        stopBits: port?.stopBits ?? opStore.stopBits,
        handshake: port?.handshake ?? opStore.handshake,
      });
      useTerminalStore.getState().setTerminalConnectedAt(portId, Date.now());
      if (useAppStore.getState().config.autoSaveLog) {
        logService.startLogging(portId).catch((e) => {
          console.debug('[useTauri] startLogging failed:', e);
          notifyError(e);
        });
      }
      // Reconnected — the port is no longer lost; hide the banner.
      lostPortIds.delete(portId);
      notifySuccess('toast.reconnect.succeeded');
      break;
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
    }
  }

  reconnectingPorts.delete(portId);
}

/**
 * Hook: 串口连接/断开操作
 */
let reconnectHintListenerCount = 0;
let unlistenReconnectHint: (() => void) | null = null;
let pendingReconnectHintUnlisten: Promise<() => void> | null = null;

// Per-port in-flight guard: a rapid double-click on the connect button (or a
// sidebar click + hotkey in the same tick) would otherwise issue two concurrent
// openSerialPort calls for the same handle — the store's 'connecting' state is
// written synchronously but toggleConnection reads a stale `ports` snapshot, so
// the short-circuit never fires in the same event loop turn.
const portOpInFlight = new Set<string>();

export function useSerialConnection() {
  const updatePort = useAppStore((s) => s.updatePort);
  const ports = useAppStore((s) => s.ports);

  // 订阅一次重连提示事件（通过引用计数，避免 Sidebar/TabBar 多实例导致重复监听）
  useEffect(() => {
    reconnectHintListenerCount += 1;
    if (reconnectHintListenerCount === 1) {
      pendingReconnectHintUnlisten = eventService.onSerialReconnectHint((event: SerialReconnectHintEvent) => {
        runReconnectLoop(event.port_name);
      });
      pendingReconnectHintUnlisten
        .then((unlisten) => {
          unlistenReconnectHint = unlisten;
        })
        .catch((e) => {
          console.debug('[useSerialConnection] Failed to register reconnect hint listener:', e);
        });
    }
    return () => {
      reconnectHintListenerCount -= 1;
      if (reconnectHintListenerCount === 0) {
        if (unlistenReconnectHint) {
          unlistenReconnectHint();
          unlistenReconnectHint = null;
        } else if (pendingReconnectHintUnlisten) {
          // All consumers unmounted before registration resolved — the
          // listener would otherwise leak. Unlisten as soon as it arrives.
          pendingReconnectHintUnlisten
            .then((unlisten) => unlisten())
            .catch(() => {});
        }
        pendingReconnectHintUnlisten = null;
      }
    };
  }, []);

  const openPort = useCallback(async (portId: string, _baudRate: number = 115200) => {
    // In-flight guard: 同一事件循环内连点两次（Sidebar 按钮 / Ctrl+K / 批量开）
    // 会并发 open 同一串口句柄——'connecting' 状态已同步写入但调用方的闭包
    // 还是旧快照，短路不生效。in-flight 期间直接 no-op。
    if (portOpInFlight.has(portId)) return;
    portOpInFlight.add(portId);
    try {
      // Reconnecting overrides any prior user-initiated close mark so the
      // DisconnectBanner / status toast resume normal unexpected-disconnect
      // detection for this port.
      userClosingPortIds.delete(portId);
      // A deliberate (re)connect clears the lost mark — the banner must hide
      // the moment the user retries a dropped port.
      lostPortIds.delete(portId);
      // Resolve connection params from the target port first (session restore
      // and per-port presets write per-port values that must win over the
      // global OperationPanel defaults), falling back to the operation store
      // for any field the port lacks. dtr/rts are global-only (not stored
      // per-port).
      const opStore = useOperationStore.getState();
      const port = useAppStore.getState().ports.find((p) => p.id === portId);
      const baudRate = port?.baudRate ?? opStore.baudRate;
      const dataBits = port?.dataBits ?? opStore.dataBits;
      const parity = port?.parity ?? opStore.parity;
      const stopBits = port?.stopBits ?? opStore.stopBits;
      const handshake = port?.handshake ?? opStore.handshake;
      updatePort(portId, { status: 'connecting' });
      // issue #11：TTY 模拟终端（GIT:BASH）打开时带上当前 xterm 尺寸——pty 以
      // 正确尺寸 spawn，vim/top 全屏应用才按真实显示尺寸渲染（否则 pty 固定
      // 80×24，画面错乱）。无 TTY 状态/未 fit 时省略参数，后端回退 80×24。
      const ttyState = ttyService.get(portId);
      const hasTtySize =
        ttyState != null && ttyState.lastCols != null && ttyState.lastRows != null;
      await serialService.openSerialPort({
        port_id: portId,
        baud_rate: baudRate,
        data_bits: dataBits,
        parity: parity,
        stop_bits: stopBits,
        handshake: handshake,
        dtr: opStore.dtr,
        rts: opStore.rts,
        ...(hasTtySize ? { cols: ttyState!.lastCols!, rows: ttyState!.lastRows! } : {}),
      });
      updatePort(portId, {
        status: 'connected',
        baudRate: baudRate,
        dataBits: dataBits,
        parity: parity,
        stopBits: stopBits,
        handshake: handshake,
      });
      useTerminalStore.getState().setTerminalConnectedAt(portId, Date.now());
      // Auto-start logging if enabled
      if (useAppStore.getState().config.autoSaveLog) {
        logService.startLogging(portId).catch((e) => {
          console.debug('[useTauri] startLogging failed:', e);
          notifyError(e);
        });
      }
    } catch (err) {
      console.error('[useSerialConnection] Failed to open port:', err);
      notifyError(err);
      updatePort(portId, { status: 'error' });
    } finally {
      portOpInFlight.delete(portId);
    }
  }, [updatePort]);

  const closePort = useCallback(async (portId: string) => {
    if (portOpInFlight.has(portId)) return;
    portOpInFlight.add(portId);
    try {
      // Mark this port as user-initiated close so the serial:status event
      // handler and DisconnectBanner suppress the "unexpected disconnect"
      // toast/banner. The mark is PERSISTENT and cleared on the next reconnect
      // (openPort) — a timer-based removal made the banner false-alarm on a
      // deliberately disconnected port whose tab was still open.
      userClosingPortIds.add(portId);
      // User-initiated close is never "lost" — clear any stale mark.
      lostPortIds.delete(portId);
      await serialService.closeSerialPort(portId);
      updatePort(portId, { status: 'disconnected' });
      // Auto-stop logging
      logService.stopLogging(portId).catch((e) => console.debug('[useTauri] stopLogging failed:', e));
    } catch (err) {
      console.error('[useSerialConnection] Failed to close port:', err);
      notifyError(err);
      updatePort(portId, { status: 'error' });
    } finally {
      portOpInFlight.delete(portId);
    }
  }, [updatePort]);

  const toggleConnection = useCallback(async (portId: string) => {
    const port = ports.find((p) => p.id === portId);
    if (!port || port.status === 'connecting') return;
    if (port.status === 'connected') {
      await closePort(portId);
    } else {
      await openPort(portId, port.baudRate || 115200);
    }
  }, [ports, openPort, closePort]);

  return { openPort, closePort, toggleConnection };
}
