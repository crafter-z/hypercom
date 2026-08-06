import { useEffect, useRef } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { useRuleStore } from '../stores/useRuleStore';
import { eventService } from '../services/tauri';
import type { SerialDataEvent, SerialStatusEvent } from '../services/tauri';
import { ProtocolFrameReassembler } from '../utils/protocolParser';
import { getRxPipeline } from '../utils/rxPipeline';
import { evaluateTriggers } from '../utils/triggerEngine';
import { sendToPort } from './useSerialSend';
import { useToastStore } from '../stores/useToastStore';
import i18n from '../i18n';
import type { PortStatus } from '../types';
import { userClosingPortIds, lostPortIds } from './disconnectTracking';

// Alert toast throttle: same rule re-matched within this window (ms) must
// not spam toasts — module-level so it survives the empty-deps effect.
const TRIGGER_ALERT_THROTTLE_MS = 1000;
const triggerAlertThrottle = new Map<string, number>();
// 触发引擎异常限流：规则配置错误时随每次 RX 触发，最多每 2s 打一条日志。
let lastTriggerEvalErrorLog = 0;

/**
 * Hook: 串口数据接收（事件监听生命周期）
 * 监听 Tauri 的 onSerialData / onSerialStatus 事件，将接收到的数据写入终端，
 * 并在后端上报端口状态变化时同步到 app store。
 *
 * RX 路径走 RxPipeline（字节级行聚合 + rAF 批写）：
 * - 普通流：pipeline.feedBytes → 组装器切行 → 解码 → 入队 → rAF 批写
 * - 协议帧：ProtocolFrameReassembler 返回有序段，帧段经 enqueueLines 入队，
 *   裸段经 feedBytes 入队——两者共享队列，天然保流顺序
 *
 * SRP：只负责事件订阅与数据入管线，不涉及任何用户主动发送动作。
 * 必须在应用根组件挂载一次（事件监听全局唯一）。
 */
export function useSerialReceive() {
  const setupPromiseRef = useRef<Promise<void> | null>(null);
  const reassemblersRef = useRef<Map<string, ProtocolFrameReassembler>>(new Map());

  useEffect(() => {
    let cancelled = false;
    const cleanups: Array<() => void> = [];
    const pipeline = getRxPipeline();

    const setup = async () => {
      const unlistenData = await eventService.onSerialData((event: SerialDataEvent) => {
        if (cancelled) return;
        const portId = event.port_id;
        // Traffic stats ONCE per event for ALL paths (protocol + common)
        const app = useAppStore.getState();
        app.setTrafficStats(portId, {
          rxTotal: (app.trafficStats[portId]?.rxTotal || 0) + event.data.length,
        });

        // Conditional triggers: match RX against trigger rules. Rules are read
        // live via getState() (never subscribe inside a callback) so store
        // edits take effect on the next event. Exceptions here must not crash
        // the RX loop — the pipeline below still needs this event.
        try {
          const triggerRules = useRuleStore.getState().triggerRules;
          if (triggerRules.length > 0) {
            // contains/exact/regex match against the decoded text; hex matches
            // against the raw bytes (handled inside evaluateTriggers).
            const decoded = pipeline.decodeText(portId, event.data);
            const matched = evaluateTriggers(decoded, event.data, triggerRules, portId);
            for (const action of matched) {
              const rule = action.rule;
              if (rule.actionType === 'alert') {
                // Throttle: don't re-toast the same rule within 1s.
                const now = Date.now();
                if (now - (triggerAlertThrottle.get(rule.id) ?? 0) < TRIGGER_ALERT_THROTTLE_MS) continue;
                triggerAlertThrottle.set(rule.id, now);
                // The alert must surface the rule's ACTION CONTENT, not a
                // generic line (issue #5-3). Fall back to the generic message
                // only when the rule has no content configured.
                const generic = i18n.t('trigger.alertMessage', { port: portId, rule: rule.name });
                const content = (rule.actionContent ?? '').trim();
                useToastStore.getState().push({
                  severity: 'warning',
                  // Title keeps the port/rule context in the notification
                  // center; the live toast renders the message only.
                  title: generic,
                  message: content || generic,
                  // Sticky: persists in the notification center until the
                  // user dismisses or clears it (durationMs 0 = no timer).
                  durationMs: 0,
                });
              } else if (rule.actionType === 'respond') {
                // silent=true: sendToPort re-throws on failure so the caller
                // can aggregate — swallow here to keep the RX loop alive.
                sendToPort(portId, rule.actionContent, rule.actionIsHex, 'None', true).catch(() => {
                  // Respond failure is silent by design.
                });
              }
            }
          }
        } catch (e) {
          // 触发引擎异常多在规则配置错误，随每次 RX 触发：限流到每 2s 至多一条，避免刷屏。
          const now = Date.now();
          if (now - lastTriggerEvalErrorLog > 2000) {
            lastTriggerEvalErrorLog = now;
            console.error('[useSerialReceive] Trigger evaluation failed:', e);
          }
        }

        // Protocol-template path: port has a protocol template bound
        const port = useAppStore.getState().ports.find(p => p.id === portId);
        const templateId = port?.protocolTemplateId;
        if (templateId) {
          const template = useRuleStore.getState().protocolTemplates.find(t => t.id === templateId && t.isEnabled);
          if (template) {
            // Key by port + template so switching the port's protocol
            // template naturally creates a fresh reassembler (the stale one,
            // with its old header/checksum framing, is left to GC).
            const reassemblerKey = `${portId}:${templateId}`;
            let reassembler = reassemblersRef.current.get(reassemblerKey);
            if (!reassembler) {
              reassembler = new ProtocolFrameReassembler(template);
              reassemblersRef.current.set(reassemblerKey, reassembler);
            }
            // Ordered segments: raw bytes before frames maintain stream order
            const segments = reassembler.feed(event.data);
            for (const seg of segments) {
              if (seg.kind === 'frame') {
                // Frames are self-contained — a fresh per-frame decode is
                // correct here (no char can straddle two frames).
                const frameText = pipeline.decodeText(portId, seg.frame.bytes);
                pipeline.enqueueLines(portId, [{
                  id: `line-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                  timestamp: event.timestamp,
                  direction: event.direction as 'RX' | 'TX',
                  content: frameText,
                  rawData: seg.frame.bytes,
                  isHex: event.is_hex,
                  parsedFields: seg.frame.fields,
                }]);
              } else {
                // Raw (non-frame) bytes — feed through the pipeline for
                // line aggregation + batched store writes
                pipeline.feedBytes(portId, seg.bytes, event.timestamp);
              }
            }
            return;
          }
        }
        // Common non-protocol path: byte-level line aggregation + batched writes
        pipeline.feedBytes(portId, event.data, event.timestamp);
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
          // Reassemblers are keyed `${portId}:${templateId}` — drop every
          // entry for this port regardless of suffix so a reconnect starts
          // with clean state.
          const prefix = `${event.port_id}:`;
          for (const key of reassemblersRef.current.keys()) {
            if (key.startsWith(prefix)) {
              reassemblersRef.current.delete(key);
            }
          }
          // Pipeline: flush tail + discard ALL per-port state (assembler,
          // decoders, timers, queue) — reconnect starts from scratch.
          pipeline.disconnect(event.port_id);
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
    // No store selector subscriptions — pipeline is a module singleton;
    // effect deps are empty so listeners register exactly once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
