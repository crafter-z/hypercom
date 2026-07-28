import { useEffect, useRef } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { useOperationStore } from '../stores/useOperationStore';
import { useTerminalStore } from '../stores/useTerminalStore';
import { useRuleStore } from '../stores/useRuleStore';
import { eventService } from '../services/tauri';
import type { SerialDataEvent, SerialStatusEvent } from '../services/tauri';
import { ProtocolFrameReassembler } from '../utils/protocolParser';
import { useToastStore } from '../stores/useToastStore';
import i18n from '../i18n';
import type { PortStatus } from '../types';
import { userClosingPortIds, lostPortIds } from './disconnectTracking';

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
        // A fresh connection clears any prior "lost" mark so the banner
        // hides as soon as the port is back up.
        if (event.status === 'connected') {
          lostPortIds.delete(event.port_id);
        }
        // Detect unexpected connected → disconnected transition BEFORE
        // updating the store (we need the previous status). User-initiated
        // closes are tracked in `userClosingPortIds` and suppressed.
        if (event.status === 'disconnected' && !userClosingPortIds.has(event.port_id)) {
          const prevPort = useAppStore.getState().ports.find(p => p.id === event.port_id);
          if (prevPort && prevPort.status === 'connected') {
            // Mark lost so DisconnectBanner shows; only a real
            // connected→disconnected transition this session lands here.
            lostPortIds.add(event.port_id);
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

    setupPromiseRef.current = setup().catch((e) => {
      console.error('[useSerialReceive] Failed to subscribe to serial events:', e);
    });

    return () => {
      cancelled = true;
      cleanups.forEach((fn) => fn());
    };
  }, [appendTerminalLine]);
}
