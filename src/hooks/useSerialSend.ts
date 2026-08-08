import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { useTerminalStore } from '../stores/useTerminalStore';
import { serialService } from '../services/tauri';
import type { SendHistoryEntry, LineEnding } from '../types';
import { notifyError, useToastStore } from '../stores/useToastStore';
import { getRxPipeline } from '../utils/rxPipeline';
import { isSendablePort } from '../utils/sendGuard';

// ==================== Module-level in-memory send history ====================
// Per-port send history lives ONLY in memory (user decision: history may
// vanish on app close — no SQLite persistence). Keyed by portId, capped at
// SEND_HISTORY_CAP entries (oldest dropped). The hook mirrors the active
// port's slice into local state for Up/Down recall.
const sendHistoryMap = new Map<string, SendHistoryEntry[]>();
const SEND_HISTORY_CAP = 50;

/** Append an entry to a port's in-memory history (dedup + cap). Returns the new list. */
function recordSendHistory(portId: string, data: string, isHex: boolean, lineEnding: string): SendHistoryEntry[] {
  const entry: SendHistoryEntry = {
    content: data,
    format: isHex ? 'hex' : 'string',
    lineEnding: lineEnding as LineEnding,
  };
  const prev = sendHistoryMap.get(portId) ?? [];
  // Dedup on content AND format — the same text sent as HEX vs
  // string (e.g. "AA") is a distinct history entry.
  const filtered = prev.filter((h) => !(h.content === entry.content && h.format === entry.format));
  const next = [...filtered, entry];
  // Cap at SEND_HISTORY_CAP, dropping the oldest entries.
  const capped = next.length > SEND_HISTORY_CAP ? next.slice(next.length - SEND_HISTORY_CAP) : next;
  sendHistoryMap.set(portId, capped);
  return capped;
}

/**
 * 发送核心（模块级，无 hook 依赖）——TX 回显 / 流量统计 / 发送历史的唯一实现。
 *
 * 后端 `send_serial_data` 不发 TX 事件：终端 TX 行、TX 流量、发送历史全部由这里
 * 在前端产生。弹出窗经意图事件（`popout:send-command`）回到主窗调用本函数，
 * 从而复用同一条发送管线——弹窗自己直连后端会丢掉 TX 回显与统计。
 *
 * `silent`（循环发送用）出错时原样抛出由调用方聚合；否则 toast 提示并返回 0。
 */
export async function sendToPort(
  portId: string,
  data: string,
  isHex: boolean,
  lineEnding: string,
  silent = false
): Promise<number> {
  const state = useAppStore.getState();
  // Closed-port guard (issue #5-4-7): a tab can exist while its port is
  // disconnected, so the send button stays enabled — the guard belongs HERE,
  // at the single sendToPort chokepoint (manual send / pop-out bridge /
  // cyclic send / trigger auto-respond all route through it). Non-silent
  // callers get one warning toast; silent callers (loops) just no-op and
  // return 0 without touching the backend, the TX echo, history or stats.
  const port = state.ports.find((p) => p.id === portId);
  if (!isSendablePort(port)) {
    if (!silent) {
      useToastStore.getState().push({
        severity: 'warning',
        messageKey: 'sendSection.portClosedWarning',
        // issue #7-1：通知中心展示消息来源串口。
        portId,
      });
    }
    return 0;
  }
  const { sendPrefix } = state.config;

  // TTY 模式（issue #11）：无本地回显——对端 shell 会把命令 echo 回来，本地再
  // 插一条 TX 行既重复又破坏终端流。因此 TTY 下跳过 TX 回显与 RX 队列排空，
  // 仍走「后端发送 + 流量统计 + 发送历史」（快捷发送/命令面板在 TTY 下可复用）。
  const isTty = port?.mode === 'tty';

  if (!isTty) {
    const prefix = sendPrefix ? `${sendPrefix} ` : '';
    const displayText = `${prefix}${data}`;
    // rawData must reflect the ACTUAL transmitted bytes (drives the
    // HEX/string display toggle + CSV export):
    //  - HEX: the parsed byte values of `data` (e.g. "AA BB" -> [170,187])
    //  - string: UTF-8 bytes of `data` WITHOUT the cosmetic sendPrefix
    // issue #6-2：存 Uint8Array（与 RX 行一致，省内存、类型统一）
    const txRawData: Uint8Array = isHex
      ? Uint8Array.from(
          data
            .trim()
            .split(/\s+/)
            .filter((tok) => tok.length > 0)
            .map((tok) => parseInt(tok, 16))
            .filter((n) => !Number.isNaN(n) && n >= 0 && n <= 255)
        )
      : new TextEncoder().encode(data);

    // Drain any pending RX lines from the pipeline queue BEFORE appending the
    // TX echo. With RX now batched up to one animation frame, a zero-delay
    // cyclic send would otherwise render TX1,TX2,RX1 instead of the natural
    // TX1,RX1,TX2 order. RX that physically arrived before this send but
    // hasn't flushed yet would render AFTER the TX line without this drain.
    // Synchronously flushing here restores the "TX precedes its own response"
    // invariant — the response arrives during the await below, not before.
    getRxPipeline().flushNow(portId);

    // Append the TX echo BEFORE the backend call. The sim port's read thread
    // emits the loopback RX during the await below; appending TX only after the
    // await resolved let RX win the race and render ABOVE the sent line.
    // Writing TX first guarantees the sent line always precedes its response.
    useTerminalStore.getState().appendTerminalLine(portId, {
      id: `line-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      direction: 'TX',
      content: displayText,
      rawData: txRawData,
      isHex: isHex,
    });
  }

  try {
    const bytesWritten = await serialService.sendSerialData({
      port_id: portId,
      data,
      is_hex: isHex,
      append_line_ending: lineEnding,
    });

    // Track TX bytes
    const currentTx = state.trafficStats[portId]?.txTotal || 0;
    state.setTrafficStats(portId, { txTotal: currentTx + bytesWritten });

    // Record send history in memory (per-port, capped)
    recordSendHistory(portId, data, isHex, lineEnding);

    return bytesWritten;
  } catch (err) {
    // Silent mode (cyclic send) re-throws so the caller aggregates the
    // error + retries — otherwise every failed send raises its own toast.
    if (silent) throw err;
    console.error('[sendToPort] Failed to send data:', err);
    notifyError(err);
    return 0;
  }
}

/**
 * Hook: 串口数据发送（用户动作）
 * 返回 sendData 回调（`sendToPort` 的薄包装），并把发送历史镜像到本地 state，
 * 供发送框 Up/Down 键 recall。
 *
 * SRP：只负责"发送"这一个用户动作 + 发送历史，不订阅任何事件。
 */
export function useSerialSend() {
  const activeTabId = useAppStore((s) => s.activeTabId);
  const [sendHistory, setSendHistory] = useState<SendHistoryEntry[]>([]);
  const historyIndexRef = useRef(-1);

  // Mirror the active port's in-memory history into state synchronously.
  useEffect(() => {
    setSendHistory(activeTabId ? (sendHistoryMap.get(activeTabId) ?? []) : []);
    historyIndexRef.current = -1;
  }, [activeTabId]);

  const sendData = useCallback(
    async (portId: string, data: string, isHex: boolean, lineEnding: string, silent = false) => {
      const bytesWritten = await sendToPort(portId, data, isHex, lineEnding, silent);
      // Mirror the just-updated in-memory history for Up/Down recall.
      setSendHistory(sendHistoryMap.get(portId) ?? []);
      return bytesWritten;
    },
    []
  );

  const historyUp = useCallback((): SendHistoryEntry | null => {
    if (sendHistory.length === 0) return null;
    let idx = historyIndexRef.current;
    if (idx === -1 || idx >= sendHistory.length) {
      idx = sendHistory.length - 1;
    } else if (idx > 0) {
      idx -= 1;
    }
    historyIndexRef.current = idx;
    return sendHistory[idx] ?? null;
  }, [sendHistory]);

  const historyDown = useCallback((): SendHistoryEntry | null => {
    if (historyIndexRef.current < 0) return null;
    let idx = historyIndexRef.current;
    if (idx < sendHistory.length - 1) {
      idx += 1;
      historyIndexRef.current = idx;
      return sendHistory[idx] ?? null;
    }
    historyIndexRef.current = -1;
    return null;
  }, [sendHistory]);

  const clearHistory = useCallback((portId: string) => {
    sendHistoryMap.delete(portId);
    setSendHistory([]);
    historyIndexRef.current = -1;
  }, []);

  return { sendData, sendHistory, historyUp, historyDown, clearHistory };
}
