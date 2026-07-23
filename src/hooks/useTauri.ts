import { useEffect, useCallback, useRef, useState } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { useOperationStore } from '../stores/useOperationStore';
import { useTerminalStore } from '../stores/useTerminalStore';
import { useRuleStore } from '../stores/useRuleStore';
import { serialService, configService, systemService, eventService, logService, storageService, sendHistoryService } from '../services/tauri';
import type { AvailablePortInfo, SerialDataEvent, SerialStatusEvent, SerialReconnectHintEvent, SerialPinStatesEvent, CommandSetInfo, HighlightSetInfo, CommandInfo, HighlightRuleInfo, ProtocolTemplateInfo, SendHistoryItem } from '../services/tauri';
import { usePinStatesStore } from '../stores/usePinStatesStore';
import type { SerialPort, AppConfig, SendCommandSet, HighlightRuleSet, SendCommand, ProtocolTemplate, PaneNode } from '../types';
import { ProtocolFrameReassembler } from '../utils/protocolParser';
import { notifyError, notifySuccess, extractErrorMessage } from '../stores/useToastStore';
import { useToastStore } from '../stores/useToastStore';
import i18n from '../i18n';

// ==================== Module-level disconnect tracking ====================
// Tracks portIds that the user is explicitly closing via closePort(). The
// `useSerialReceive` status handler reads this to suppress the "port lost"
// toast for user-initiated disconnects, and `DisconnectBanner` reads it
// (via `isUserClosingPort`) to suppress the banner for the same reason.
//
// Entries are removed 3s after closePort resolves to tolerate late
// `serial:status` events that arrive after the backend close response.
const userClosingPortIds = new Set<string>();

/** Returns true if the given portId is currently being closed by the user. */
export function isUserClosingPort(portId: string): boolean {
  return userClosingPortIds.has(portId);
}

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
      notifySuccess('toast.reconnect.succeeded');
      break;
    } catch (err) {
      useToastStore.getState().push({
        severity: 'error',
        messageKey: 'toast.reconnect.failed',
        message: extractErrorMessage(err),
      });
      if (attempt >= maxRetries - 1) break;
      delayMs = nextReconnectDelay(delayMs);
    }
  }

  reconnectingPorts.delete(portId);
}

/**
 * 将后端 PortInfo 映射为前端 SerialPort
 * 后端的 port_type 是 "real"|"virtual"，前端 PortStatus 需要从后端获取或默认 disconnected
 */
function mapPortInfo(info: AvailablePortInfo): SerialPort {
  const type = info.port_type === 'sim' ? 'sim' : info.port_type === 'real' ? 'real' : 'virtual';
  return {
    id: info.id,
    name: info.name,
    alias: undefined,
    status: 'disconnected' as PortStatus,
    type: type as SerialPort['type'],
    isHidden: false,
    groupId: undefined,
  };
}

function mergePorts(incoming: SerialPort[], existing: SerialPort[]): SerialPort[] {
  const existingMap = new Map(existing.map(p => [p.id, p]));
  const merged = incoming.map(p => {
    const prev = existingMap.get(p.id);
    if (prev) {
      // Preserve runtime state: status, alias, hidden, group, connection
      // params, and the protocol-template binding (TerminalView sets
      // protocolTemplateId via updatePort; the 3s poll must not wipe it).
      return {
        ...p,
        status: prev.status,
        alias: prev.alias,
        isHidden: prev.isHidden,
        groupId: prev.groupId,
        baudRate: prev.baudRate,
        dataBits: prev.dataBits,
        parity: prev.parity,
        stopBits: prev.stopBits,
        handshake: prev.handshake,
        protocolTemplateId: prev.protocolTemplateId,
      };
    }
    return p;
  });
  // Union back any live port that transiently vanished from the enumeration
  // (USB glitch / sleep-resume). Dropping a connected/connecting port while
  // its tab/terminal still reference it causes store/backend drift; it would
  // reappear later as 'disconnected'.
  const incomingIds = new Set(incoming.map(p => p.id));
  for (const prev of existing) {
    if (!incomingIds.has(prev.id) && (prev.status === 'connected' || prev.status === 'connecting')) {
      merged.push(prev);
    }
  }
  return merged;
}

import type { PortStatus } from '../types';

/** Map backend CommandSetInfo to frontend SendCommandSet */
function mapCommandSetInfo(s: CommandSetInfo): SendCommandSet {
  return {
    id: s.id,
    name: s.name,
    isLoop: s.is_loop,
    loopDelay: s.loop_delay_ms,
    commands: s.commands.map((c: CommandInfo) => ({
      id: c.id,
      name: c.name,
      order: c.order_idx,
      delay: c.delay_ms,
      type: c.cmd_type as SendCommand['type'],
      content: c.content,
      appendLineEnding: c.append_line_ending as SendCommand['appendLineEnding'],
    })),
  };
}

/** Map backend HighlightSetInfo to frontend HighlightRuleSet */
function mapHighlightSetInfo(s: HighlightSetInfo): HighlightRuleSet {
  return {
    id: s.id,
    name: s.name,
    isEnabled: s.is_enabled,
    rules: s.rules.map((r: HighlightRuleInfo) => ({
      id: r.id,
      name: r.name,
      pattern: r.pattern,
      isRegex: r.is_regex,
      color: r.color,
      bold: r.bold,
      italic: r.italic,
    })),
  };
}

/** Map backend ProtocolTemplateInfo to frontend ProtocolTemplate */
function mapProtocolTemplateInfo(s: ProtocolTemplateInfo): ProtocolTemplate {
  return {
    id: s.id,
    name: s.name,
    // SQLite stores is_enabled as i32 — coerce to a real boolean so the
    // frontend never sees a truthy number masquerading as a boolean.
    isEnabled: Boolean(s.is_enabled),
    headerBytes: s.header_bytes,
    lengthFieldOffset: s.length_field_offset,
    lengthFieldSize: s.length_field_size as 1 | 2,
    lengthEndian: s.length_endian as 'little' | 'big',
    lengthAdjust: s.length_adjust,
    checksumAlgorithm: s.checksum_algorithm as ProtocolTemplate['checksumAlgorithm'],
    checksumOffset: s.checksum_offset,
    footerBytes: s.footer_bytes,
    colorHeader: s.color_header,
    colorLength: s.color_length,
    colorPayload: s.color_payload,
    colorChecksum: s.color_checksum,
    colorFooter: s.color_footer,
  };
}

/**
 * Push every log-related config field to the backend logger so the two sides
 * never drift. `logDirectory` is only synced when non-empty — an empty string
 * would wipe the backend's default log root. Individual failures are logged
 * and swallowed; a single unsupported setter must not abort the whole sync.
 */
function syncLogSettingsToBackend(config: AppConfig): Promise<void> {
  return Promise.all([
    logService.setAutoSave(config.autoSaveLog).catch((e) => console.debug('[useTauri] setAutoSave failed:', e)),
    logService.setEncoding(config.logEncoding).catch((e) => console.debug('[useTauri] setEncoding failed:', e)),
    logService.setLogFilenameFormat(config.logFilenameFormat).catch((e) => console.debug('[useTauri] setLogFilenameFormat failed:', e)),
    logService.setLogSplitSize(config.logSplitSizeMb).catch((e) => console.debug('[useTauri] setLogSplitSize failed:', e)),
    logService.setLogSplitEnabled(config.logSplitEnabled).catch((e) => console.debug('[useTauri] setLogSplitEnabled failed:', e)),
    ...(config.logDirectory
      ? [logService.setLogDirectory(config.logDirectory).catch((e) => console.debug('[useTauri] setLogDirectory failed:', e))]
      : []),
  ]).then(() => undefined);
}

/**
 * Hook: 自动刷新串口列表
 */
export function useSerialPorts(pollIntervalMs: number = 3000) {
  const setPorts = useAppStore((s) => s.setPorts);

  const refreshPorts = useCallback(async () => {
    try {
      const list = await serialService.listAvailablePorts();
      const merged = mergePorts(list.map(mapPortInfo), useAppStore.getState().ports);
      setPorts(merged);
    } catch (err) {
      console.warn('[useSerialPorts] Failed to list ports:', err);
    }
  }, [setPorts]);

  useEffect(() => {
    refreshPorts();
    if (pollIntervalMs > 0) {
      const timer = setInterval(refreshPorts, pollIntervalMs);
      return () => clearInterval(timer);
    }
  }, [refreshPorts, pollIntervalMs]);

  return { refreshPorts };
}

/**
 * Hook: 串口连接/断开操作
 */
let reconnectHintListenerCount = 0;
let unlistenReconnectHint: (() => void) | null = null;
let pendingReconnectHintUnlisten: Promise<() => void> | null = null;

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
    // Reconnecting overrides any prior user-initiated close mark so the
    // DisconnectBanner / status toast resume normal unexpected-disconnect
    // detection for this port.
    userClosingPortIds.delete(portId);
    try {
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
      await serialService.openSerialPort({
        port_id: portId,
        baud_rate: baudRate,
        data_bits: dataBits,
        parity: parity,
        stop_bits: stopBits,
        handshake: handshake,
        dtr: opStore.dtr,
        rts: opStore.rts,
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
    }
  }, [updatePort]);

  const closePort = useCallback(async (portId: string) => {
    // Mark this port as user-initiated close so the serial:status event
    // handler and DisconnectBanner suppress the "unexpected disconnect"
    // toast/banner. The mark is PERSISTENT and cleared on the next reconnect
    // (openPort) — a timer-based removal made the banner false-alarm on a
    // deliberately disconnected port whose tab was still open.
    userClosingPortIds.add(portId);
    try {
      await serialService.closeSerialPort(portId);
      updatePort(portId, { status: 'disconnected' });
      // Auto-stop logging
      logService.stopLogging(portId).catch((e) => console.debug('[useTauri] stopLogging failed:', e));
    } catch (err) {
      console.error('[useSerialConnection] Failed to close port:', err);
      notifyError(err);
      updatePort(portId, { status: 'error' });
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

/**
 * Hook: 串口引脚状态订阅（事件监听生命周期）
 * 监听 `serial:pin_states` 事件并写入 PinStatesStore。
 * 在 App.tsx 中调用一次，全局唯一。
 */
export function usePinStatesSubscriber() {
  const setPinStates = usePinStatesStore((s) => s.setPinStates);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    const setup = async () => {
      unlisten = await eventService.onSerialPinStates((event: SerialPinStatesEvent) => {
        if (cancelled) return;
        setPinStates(event.port_id, {
          dtr: event.dtr,
          rts: event.rts,
          cts: event.cts,
          dsr: event.dsr,
          rlsd: event.rlsd,
          ri: event.ri,
        });
      });
    };
    setup().catch((e) => console.debug('[usePinStatesSubscriber] Failed to subscribe to pin states:', e));

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [setPinStates]);
}

/**
 * Hook: 串口数据接收（事件监听生命周期）
 * 监听 Tauri 的 onSerialData / onSerialStatus 事件，将接收到的数据写入终端，
 * 并在后端上报端口状态变化时同步到 app store。
 *
 * SRP：只负责事件订阅与数据解码入终端，不涉及任何用户主动发送动作。
 * 必须在应用根组件挂载一次（事件监听全局唯一）。
 */
export function useSerialReceive() {
  const appendTerminalLine = useTerminalStore((s) => s.appendTerminalLine);
  const setupPromiseRef = useRef<Promise<void> | null>(null);
  const reassemblersRef = useRef<Map<string, ProtocolFrameReassembler>>(new Map());
  // Persistent streaming decoders keyed `${portId}:${decoderLabel}`. A fresh
  // TextDecoder per event decodes multi-byte chars (GBK 2-byte, UTF-8 3-byte)
  // that straddle two serial:data events to U+FFFD on BOTH halves — guaranteed
  // mojibake on GBK traffic. Streaming decode ({stream:true}) retains a partial
  // trailing char in the decoder and emits it once the next event completes it.
  const decodersRef = useRef<Map<string, TextDecoder>>(new Map());

  useEffect(() => {
    let cancelled = false;
    const cleanups: Array<() => void> = [];

    // Look up (or lazily create) the streaming decoder for a port+label.
    // Recreating under a new label drops any stale entry for that port so a
    // buffered partial from the previous encoding can't resurface after an
    // encoding switch.
    const getStreamingDecoder = (portId: string, label: string): TextDecoder => {
      const key = `${portId}:${label}`;
      let decoder = decodersRef.current.get(key);
      if (!decoder) {
        const prefix = `${portId}:`;
        for (const k of decodersRef.current.keys()) {
          if (k.startsWith(prefix)) decodersRef.current.delete(k);
        }
        try {
          decoder = new TextDecoder(label, { fatal: false });
        } catch {
          console.warn('[useSerialReceive] TextDecoder failed for encoding:', label, 'falling back to utf-8');
          decoder = new TextDecoder('utf-8', { fatal: false });
        }
        decodersRef.current.set(key, decoder);
      }
      return decoder;
    };

    const setup = async () => {
      const unlistenData = await eventService.onSerialData((event: SerialDataEvent) => {
        if (cancelled) return;
        const term = useTerminalStore.getState().terminals[event.port_id];
        const encoding = term?.encoding || 'UTF-8';
        const decoderLabel = encoding.toLowerCase() === 'ascii' ? 'utf-8' : encoding.toLowerCase();
        // Protocol frame parsing: if port has a protocol template bound, feed bytes into reassembler
        const port = useAppStore.getState().ports.find(p => p.id === event.port_id);
        const templateId = port?.protocolTemplateId;
        if (templateId) {
          const template = useRuleStore.getState().protocolTemplates.find(t => t.id === templateId && t.isEnabled);
          if (template) {
            // Key by port + template so switching the port's protocol
            // template naturally creates a fresh reassembler (the stale one,
            // with its old header/checksum framing, is left to GC).
            const reassemblerKey = `${event.port_id}:${templateId}`;
            let reassembler = reassemblersRef.current.get(reassemblerKey);
            if (!reassembler) {
              reassembler = new ProtocolFrameReassembler(template);
              reassemblersRef.current.set(reassemblerKey, reassembler);
            }
            const { frames, flushedBytes } = reassembler.feed(event.data);
            for (const frame of frames) {
              // Frames are self-contained — a fresh per-frame decoder is
              // correct here (no char can straddle two frames).
              const frameText = new TextDecoder(decoderLabel, { fatal: false }).decode(new Uint8Array(frame.bytes));
              appendTerminalLine(event.port_id, {
                id: `line-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                timestamp: event.timestamp,
                direction: event.direction as 'RX' | 'TX',
                content: frameText,
                rawData: frame.bytes,
                isHex: event.is_hex,
                parsedFields: frame.fields,
              });
            }
            if (flushedBytes.length > 0) {
              // Flushed (non-frame) bytes are a raw stream that CAN split a
              // multi-byte char across events — use the streaming decoder.
              const flushedText = getStreamingDecoder(event.port_id, decoderLabel).decode(new Uint8Array(flushedBytes), { stream: true });
              // A partial trailing char decodes to '' (bytes retained in the
              // decoder) — skip the empty append; it surfaces on the next event.
              if (flushedText) {
                appendTerminalLine(event.port_id, {
                  id: `line-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                  timestamp: event.timestamp,
                  direction: event.direction as 'RX' | 'TX',
                  content: flushedText,
                  rawData: flushedBytes,
                  isHex: event.is_hex,
                });
              }
            }
            useAppStore.getState().setTrafficStats(event.port_id, {
              rxTotal: (useAppStore.getState().trafficStats[event.port_id]?.rxTotal || 0) + event.data.length,
            });
            return;
          }
        }
        // Common non-protocol path: streaming decode so multi-byte chars that
        // straddle events reassemble instead of corrupting to U+FFFD.
        const text = getStreamingDecoder(event.port_id, decoderLabel).decode(new Uint8Array(event.data), { stream: true });
        // An empty string here is a buffered partial multi-byte char — the
        // bytes are retained in the decoder, so skipping is safe.
        if (useOperationStore.getState().ignoreEmptyChars && !text.trim()) return;
        appendTerminalLine(event.port_id, {
          id: `line-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          timestamp: event.timestamp,
          direction: event.direction as 'RX' | 'TX',
          content: text,
          rawData: event.data,
          isHex: event.is_hex,
        });
        useAppStore.getState().setTrafficStats(event.port_id, {
          rxTotal: (useAppStore.getState().trafficStats[event.port_id]?.rxTotal || 0) + event.data.length,
        });
      });

      const unlistenStatus = await eventService.onSerialStatus((event: SerialStatusEvent) => {
        if (cancelled) return;
        const statusMap: Record<string, PortStatus> = {
          connected: 'connected',
          disconnected: 'disconnected',
          error: 'error',
        };
        // Detect unexpected connected → disconnected transition BEFORE
        // updating the store (we need the previous status). User-initiated
        // closes are tracked in `userClosingPortIds` and suppressed.
        if (event.status === 'disconnected' && !userClosingPortIds.has(event.port_id)) {
          const prevPort = useAppStore.getState().ports.find(p => p.id === event.port_id);
          if (prevPort && prevPort.status === 'connected') {
            const portName = prevPort.alias || prevPort.name;
            useToastStore.getState().push({
              severity: 'warning',
              message: i18n.t('toast.disconnect.portLost', { port: portName }),
              durationMs: 8000,
            });
          }
        }
        useAppStore.getState().updatePort(event.port_id, {
          status: statusMap[event.status] || 'disconnected',
        });
        if (event.status === 'disconnected') {
          // Reassemblers are keyed `${portId}:${templateId}` and streaming
          // decoders `${portId}:${label}` — drop every entry for this port
          // regardless of suffix so a reconnect starts with clean state.
          const prefix = `${event.port_id}:`;
          for (const key of reassemblersRef.current.keys()) {
            if (key.startsWith(prefix)) {
              reassemblersRef.current.delete(key);
            }
          }
          for (const key of decodersRef.current.keys()) {
            if (key.startsWith(prefix)) {
              decodersRef.current.delete(key);
            }
          }
        }
      });

      if (cancelled) {
        unlistenData();
        unlistenStatus();
        return;
      }

      cleanups.push(unlistenData, unlistenStatus);
    };

    setupPromiseRef.current = setup();

    return () => {
      cancelled = true;
      cleanups.forEach((fn) => fn());
    };
  }, [appendTerminalLine]);
}

/**
 * Hook: 串口数据发送（用户动作）
 * 返回 sendData 回调，调用后端 serialService 发送数据，并把发送内容回显到终端、累加 TX 流量统计。
 * 同时维护当前端口的发送历史（SQLite 持久化），供发送框 Up/Down 键 recall。
 *
 * SRP：只负责"发送"这一个用户动作 + 发送历史，不订阅任何事件。
 */
export function useSerialSend() {
  const activeTabId = useAppStore((s) => s.activeTabId);
  const [sendHistory, setSendHistory] = useState<SendHistoryItem[]>([]);
  const historyIndexRef = useRef(-1);

  // Load persisted send history when the active tab changes.
  useEffect(() => {
    if (!activeTabId) {
      setSendHistory([]);
      historyIndexRef.current = -1;
      return;
    }
    sendHistoryService
      .listSendHistory(activeTabId, 50)
      .then((rows) => {
        // Backend returns newest-first; present chronological oldest -> newest for recall.
        setSendHistory(rows.reverse());
        historyIndexRef.current = -1;
      })
      .catch((err) => console.debug('[useSerialSend] Failed to load history:', err));
  }, [activeTabId]);

  const addToHistory = useCallback(
    async (portId: string, data: string, isHex: boolean, lineEnding: string) => {
      try {
        const row = await sendHistoryService.addSendHistory(
          portId,
          data,
          isHex ? 'hex' : 'string',
          lineEnding
        );
        setSendHistory((prev) => {
          // Dedup on content AND format — the same text sent as HEX vs
          // string (e.g. "AA") is a distinct history entry.
          const filtered = prev.filter((h) => !(h.content === row.content && h.format === row.format));
          return [...filtered, row];
        });
      } catch (err) {
        console.debug('[useSerialSend] Failed to persist history:', err);
      }
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

        // Persist send history asynchronously (non-blocking)
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

  const historyUp = useCallback((): SendHistoryItem | null => {
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

  const historyDown = useCallback((): SendHistoryItem | null => {
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

  const clearHistory = useCallback(async (portId: string) => {
    try {
      await sendHistoryService.clearSendHistory(portId);
      setSendHistory([]);
      historyIndexRef.current = -1;
    } catch (err) {
      console.debug('[useSerialSend] Failed to clear history:', err);
    }
  }, []);

  return { sendData, sendHistory, historyUp, historyDown, clearHistory };
}

/**
 * Hook: 配置持久化
 * 从后端加载配置、保存配置到后端
 */
export function useConfigPersistence() {
  const setConfig = useAppStore((s) => s.setConfig);
  const resetConfig = useAppStore((s) => s.resetConfig);

  const loadConfig = useCallback(async () => {
    try {
      const config = await configService.getConfig();
      setConfig(config);
    } catch (err) {
      console.warn('[useConfigPersistence] Failed to load config, using defaults:', err);
    }
  }, [setConfig]);

  const saveConfig = useCallback(async (config: AppConfig) => {
    try {
      await configService.setConfig(config);
      await syncLogSettingsToBackend(config);
    } catch (err) {
      console.error('[useConfigPersistence] Failed to save config:', err);
      notifyError(err);
    }
  }, []);

  const resetAndReload = useCallback(async () => {
    try {
      const defaultConfig = await configService.resetConfig();
      resetConfig();
      setConfig(defaultConfig);
      await syncLogSettingsToBackend(defaultConfig);
    } catch (err) {
      console.error('[useConfigPersistence] Failed to reset config:', err);
      notifyError(err);
    }
  }, [resetConfig, setConfig]);

  return { loadConfig, saveConfig, resetAndReload };
}

/**
 * Hook: 系统状态轮询
 */
export function useSystemStatus(pollIntervalMs: number = 5000) {
  const setSystemStatus = useAppStore((s) => s.setSystemStatus);

  useEffect(() => {
    const poll = async () => {
      try {
        const status = await systemService.getSystemStatus();
        setSystemStatus({
          status: status.status,
          memoryUsedMb: status.memoryUsedMb,
          memoryLimitMb: status.memoryLimitMb,
          cpuUsage: status.cpuUsage,
        });
      } catch (err) {
        // Backend may not be fully ready yet, silently ignore
      }
    };

    poll();
    const timer = setInterval(poll, pollIntervalMs);
    return () => clearInterval(timer);
  }, [setSystemStatus, pollIntervalMs]);
}

/**
 * Hook: 应用初始化
 * 在 App 挂载时调用，加载配置、刷新串口列表等
 */

/** Validate a deserialized PaneNode tree structure (F.3 session restore). */
function isValidPaneNode(node: unknown): node is PaneNode {
  if (typeof node !== 'object' || node === null) return false;
  const obj = node as Record<string, unknown>;
  if (typeof obj.id !== 'string' || typeof obj.size !== 'number') return false;
  if (obj.type === 'leaf') return Array.isArray(obj.tabIds);
  if (obj.type === 'branch') {
    return (
      (obj.direction === 'horizontal' || obj.direction === 'vertical') &&
      Array.isArray(obj.children) &&
      (obj.children as unknown[]).every(isValidPaneNode)
    );
  }
  return false;
}

export function useAppInit() {
  const { loadConfig } = useConfigPersistence();
  const { refreshPorts } = useSerialPorts(0);

  useEffect(() => {
    const init = async () => {
      await loadConfig();
      // 配置加载完成后才允许首次启动引导弹窗渲染，避免 hasSeenTour
      // 尚未从后端同步到 store 时引导一闪而过（loadConfig 内部已吞掉异常，
      // 此处无论成功与否都需要置位）
      useAppStore.getState().setUIState({ configLoaded: true });
      const loaded = useAppStore.getState().config;
      await syncLogSettingsToBackend(loaded);
      // Load persisted rule sets and command sets at startup
      try {
        const [cmdSets, hlSets, protoTemplates] = await Promise.all([
          storageService.loadCommandSets(),
          storageService.loadHighlightSets(),
          storageService.loadProtocolTemplates(),
        ]);
        useRuleStore.getState().setSendCommandSets(cmdSets.map(mapCommandSetInfo));
        useRuleStore.getState().setHighlightRuleSets(hlSets.map(mapHighlightSetInfo));
        useRuleStore.getState().setProtocolTemplates(protoTemplates.map(mapProtocolTemplateInfo));
      } catch (e) {
        console.warn('[useAppInit] Failed to load stored rules/commands:', e);
      }
      await refreshPorts();

      // F.3: Session restore — recreate tabs + paneTree from snapshot (no auto-connect)
      const cfg = useAppStore.getState().config;
      if (cfg.restoreSession && cfg.sessionSnapshot) {
        try {
          const snapshot = JSON.parse(cfg.sessionSnapshot) as {
            paneTree?: unknown;
            tabs?: Array<{ id: string; title: string; splitPaneId: string; isPinned: boolean }>;
            portConfigs?: Record<string, { baudRate: number; dataBits: number; parity: string; stopBits: string; handshake: string }>;
          };
          const availablePortIds = new Set(useAppStore.getState().ports.map((p) => p.id));
          const validTabs = (snapshot.tabs ?? []).filter((t) => availablePortIds.has(t.id));

          if (validTabs.length > 0) {
            // Apply saved port configs (baud rate etc.) without connecting
            for (const tab of validTabs) {
              const pc = snapshot.portConfigs?.[tab.id];
              if (pc) {
                useAppStore.getState().updatePort(tab.id, {
                  baudRate: pc.baudRate,
                  dataBits: pc.dataBits as SerialPort['dataBits'],
                  parity: pc.parity as SerialPort['parity'],
                  stopBits: pc.stopBits as SerialPort['stopBits'],
                  handshake: pc.handshake as SerialPort['handshake'],
                });
              }
            }

            // Validate and restore paneTree; fall back to default if corrupt
            let tree: PaneNode;
            if (isValidPaneNode(snapshot.paneTree)) {
              tree = snapshot.paneTree;
            } else {
              tree = { id: 'main', type: 'leaf', tabIds: validTabs.map((t) => t.id), size: 1 };
            }

            useAppStore.getState().restoreSessionSnapshot({ paneTree: tree, tabs: validTabs });
          }
        } catch (e) {
          console.warn('[useAppInit] Failed to restore session snapshot:', e);
        }
      }
    };
    init();
  }, [loadConfig, refreshPorts]);
}

/**
 * Hook: 模拟串口模式
 * 开启后串口列表会出现 SIM:Loopback 虚拟串口
 * 发送数据后会回显 "Received: xxx"，每5秒发送心跳
 */
export function useSimulation() {
  const simulationMode = useAppStore((s) => s.simulationMode);
  const setSimulationMode = useAppStore((s) => s.setSimulationMode);

  const toggleSimulation = useCallback(async () => {
    try {
      if (simulationMode) {
        await serialService.disableSimulation();
        setSimulationMode(false);
      } else {
        await serialService.enableSimulation();
        setSimulationMode(true);
      }
      // 刷新串口列表以显示/隐藏模拟串口
      const list = await serialService.listAvailablePorts();
      const merged = mergePorts(list.map(mapPortInfo), useAppStore.getState().ports);
      useAppStore.getState().setPorts(merged);
    } catch (err) {
      console.error('[useSimulation] Failed to toggle simulation:', err);
      notifyError(err);
    }
  }, [simulationMode, setSimulationMode]);

  return { simulationMode, toggleSimulation };
}