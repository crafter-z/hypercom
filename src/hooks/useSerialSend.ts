import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { useTerminalStore } from '../stores/useTerminalStore';
import { serialService } from '../services/tauri';
import type { SendHistoryEntry, LineEnding } from '../types';
import { notifyError } from '../stores/useToastStore';

// ==================== Module-level in-memory send history ====================
// Per-port send history lives ONLY in memory (user decision: history may
// vanish on app close — no SQLite persistence). Keyed by portId, capped at
// SEND_HISTORY_CAP entries (oldest dropped). The hook mirrors the active
// port's slice into local state for Up/Down recall.
const sendHistoryMap = new Map<string, SendHistoryEntry[]>();
const SEND_HISTORY_CAP = 50;

/**
 * Hook: 串口数据发送（用户动作）
 * 返回 sendData 回调，调用后端 serialService 发送数据，并把发送内容回显到终端、累加 TX 流量统计。
 * 同时维护当前端口的发送历史（内存态，按端口隔离，上限 50 条），供发送框 Up/Down 键 recall。
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

  const addToHistory = useCallback(
    (portId: string, data: string, isHex: boolean, lineEnding: string) => {
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
      setSendHistory(capped);
    },
    []
  );

  const sendData = useCallback(
    async (portId: string, data: string, isHex: boolean, lineEnding: string, silent = false) => {
      try {
        const bytesWritten = await serialService.sendSerialData({
          port_id: portId,
          data,
          is_hex: isHex,
          append_line_ending: lineEnding,
        });

        // Also show sent data in terminal
        const state = useAppStore.getState();
        const { sendPrefix } = state.config;
        const prefix = sendPrefix ? `${sendPrefix} ` : '';
        const displayText = `${prefix}${data}`;
        // rawData must reflect the ACTUAL transmitted bytes (drives the
        // HEX/string display toggle + CSV export):
        //  - HEX: the parsed byte values of `data` (e.g. "AA BB" -> [170,187])
        //  - string: UTF-8 bytes of `data` WITHOUT the cosmetic sendPrefix
        const txRawData: number[] = isHex
          ? data
              .trim()
              .split(/\s+/)
              .filter((tok) => tok.length > 0)
              .map((tok) => parseInt(tok, 16))
              .filter((n) => !Number.isNaN(n) && n >= 0 && n <= 255)
          : Array.from(new TextEncoder().encode(data));
        useTerminalStore.getState().appendTerminalLine(portId, {
          id: `line-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          timestamp: Date.now(),
          direction: 'TX',
          content: displayText,
          rawData: txRawData,
          isHex: isHex,
        });

        // Track TX bytes
        const currentTx = state.trafficStats[portId]?.txTotal || 0;
        state.setTrafficStats(portId, { txTotal: currentTx + bytesWritten });

        // Record send history in memory (per-port, capped)
        addToHistory(portId, data, isHex, lineEnding);

        return bytesWritten;
      } catch (err) {
        // Silent mode (cyclic send) re-throws so the caller aggregates the
        // error + retries — otherwise every failed send raises its own toast.
        if (silent) throw err;
        console.error('[useSerialSend] Failed to send data:', err);
        notifyError(err);
        return 0;
      }
    },
    [addToHistory]
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
