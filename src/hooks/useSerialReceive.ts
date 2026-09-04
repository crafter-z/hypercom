import { useEffect, useRef } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { useRuleStore } from '../stores/useRuleStore';
import { eventService } from '../services/tauri';
import type { SerialDataEvent, SerialStatusEvent } from '../services/tauri';
import { ProtocolFrameReassembler } from '../utils/protocolParser';
import { getRxPipeline } from '../utils/rxPipeline';
import { ttyService } from '../utils/ttyService';
import { trafficStats } from '../utils/trafficStats';
import { evaluateTriggers } from '../utils/triggerEngine';
import { sendToPort } from './useSerialSend';
import { notifyPortDisconnected } from '../utils/pluginObserver';
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
 * 行级触发器评估（P1-1）：在 RxPipeline 组装出的**完整行**上匹配触发规则，
 * 而非旧的「按 serial:data 读事件块」匹配。读事件边界是任意的（OS 缓冲/时序），
 * 一个完整行可能横跨多次事件 → 旧实现 contains/exact 跨块失效、exact 因块内
 * 带 \r\n 几乎永不命中。改为行边界匹配后，contains/exact/regex 均按完整行文本。
 * 由 RxPipeline 的 onLineAssembled 钩子逐行调用。
 */
function evaluateLineTriggers(portId: string, text: string, rawData: Uint8Array): void {
  try {
    const triggerRules = useRuleStore.getState().triggerRules;
    if (triggerRules.length === 0) return;
    // contains/exact/regex match against the decoded line text; hex matches
    // against the raw bytes (handled inside evaluateTriggers).
    const matched = evaluateTriggers(text, Array.from(rawData), triggerRules, portId);
    for (const action of matched) {
      const rule = action.rule;
      if (rule.actionType === 'alert') {
        // Throttle: don't re-toast the same rule within 1s.
        const now = Date.now();
        if (now - (triggerAlertThrottle.get(rule.id) ?? 0) < TRIGGER_ALERT_THROTTLE_MS) continue;
        triggerAlertThrottle.set(rule.id, now);
        // The alert must surface the rule's ACTION CONTENT, not a generic
        // line (issue #5-3). Fall back to the generic message only when the
        // rule has no content configured.
        const generic = i18n.t('trigger.alertMessage', { port: portId, rule: rule.name });
        const content = (rule.actionContent ?? '').trim();
        useToastStore.getState().push({
          severity: 'warning',
          title: generic,
          message: content || generic,
          // issue #7-1：通知中心展示消息来源串口。
          portId,
          // Sticky: persists until dismissed/cleared (durationMs 0 = no timer).
          durationMs: 0,
        });
      } else if (rule.actionType === 'respond') {
        // silent=true: sendToPort re-throws on failure — swallow to keep the
        // RX loop alive.
        sendToPort(portId, rule.actionContent, rule.actionIsHex, 'None', true).catch((e) => {
          console.debug('[useSerialReceive] trigger respond failed:', rule.id, e);
        });
      }
    }
  } catch (e) {
    // 触发引擎异常多在规则配置错误，随每次 RX 触发：限流到每 2s 至多一条。
    const now = Date.now();
    if (now - lastTriggerEvalErrorLog > 2000) {
      lastTriggerEvalErrorLog = now;
      console.error('[useSerialReceive] Trigger evaluation failed:', e);
    }
  }
}

/**
 * 连接成功（后端 `serial:status` connected）→ 自动为该端口打开标签页（v0.6.1）。
 *
 * 后端对 open（真实串口 / SIM:Loopback / GIT:BASH）与自动重连统一发 connected
 * 事件——这是「真正连接成功」的唯一权威信号（失败只发 error 或 nothing），
 * 放置于此天然覆盖全部连接路径，无需在 openPort / runReconnectLoop 分别接线。
 *
 * 直接复用 `openTab`（手动「新建标签页」同一动作，语义完全一致）：
 * - tab id 恒等于 portId → 幂等：已有标签页则激活、没有则创建；
 * - 新标签页落在 `focusedPaneId` 所在叶子（多 Pane 递归树行为与手动一致）并激活；
 * - 关闭串口不受影响——closePort 只改端口状态，本函数不处理 disconnected。
 */
export function openTabForConnectedPort(portId: string): void {
  useAppStore.getState().openTab(portId);
}

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
 * P1-1：条件触发器改在 RxPipeline 的 onLineAssembled 钩子（完整行边界）评估，
 * 而非旧的「按 serial:data 读事件块」匹配——读事件边界任意，跨块模式会失效。
 *
 * SRP：只负责事件订阅与数据入管线，不涉及任何用户主动发送动作。
 * 必须在应用根组件挂载一次（事件监听全局唯一）。
 */
export function useSerialReceive() {
  const reassemblersRef = useRef<Map<string, ProtocolFrameReassembler>>(new Map());

  useEffect(() => {
    let cancelled = false;
    const cleanups: Array<() => void> = [];
    const pipeline = getRxPipeline();

    // P1-1：行级触发器——每条完整行组装完成时评估触发规则（行边界而非读事件块）。
    pipeline.setOnLineAssembled((portId, line) => {
      evaluateLineTriggers(portId, line.text, line.rawData);
    });

    const setup = async () => {
      const unlistenData = await eventService.onSerialData((event: SerialDataEvent) => {
        if (cancelled) return;
        const portId = event.port_id;
        // Traffic stats ONCE per event for ALL paths (protocol + common)
        // P1-1：每事件 setTrafficStats 降频——字节先经 1s 聚合器累计，每秒统一写
        // 一次 store（StatusBar 本就 1s 窗口差分算速率，总量语义不变；消除每事件
        // Zustand 更新 + StatusBar 重渲染，TTY 卡顿根因 #3）。
        trafficStats.addRx(portId, event.data.length);

        // TTY 模式（issue #11）：字节直喂 ttyService（xterm 渲染）。
        // 跳过触发引擎 / 协议解析 / RxPipeline 行组装——终端字节流没有「行」语义，
        // 由 xterm.js 完整终端模拟（ANSI 颜色、光标寻址、备用屏幕、CR 覆写）接管。
        if (useAppStore.getState().ports.find(p => p.id === portId)?.mode === 'tty') {
          ttyService.feed(portId, event.data);
          return;
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
                const frameBytes = new Uint8Array(seg.frame.bytes);
                const frameText = pipeline.decodeText(portId, frameBytes);
                pipeline.enqueueLines(portId, [{
                  timestamp: event.timestamp,
                  direction: event.direction as 'RX' | 'TX',
                  content: frameText,
                  // issue #6-2：rawData 存 Uint8Array（省内存 + 免解码临时拷贝）
                  rawData: frameBytes,
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
          // v0.6.1：连接成功 → 自动打开/激活该端口的标签页（幂等，见上方函数注释）。
          openTabForConnectedPort(event.port_id);
          // issue #11：连接后把 xterm 尺寸再同步一次到后端 pty（覆盖「spawn 后
          // 容器才完成布局」的边角时序；非 GIT: 端口 / 无尺寸时为 no-op）。
          ttyService.resync(event.port_id);
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
              // issue #7-1：通知中心展示消息来源串口。
              portId: event.port_id,
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
          // TTY（issue #11）：flush 队列、保留 xterm 实例——视图跨重连保持挂载。
          ttyService.disconnect(event.port_id);
          // 插件 RX 观察器断流通知（issue #17 复审补强：真实断线与 mode-tty
          // 同为 rx.detached；关标签页不清端口状态、不走这里）。
          notifyPortDisconnected(event.port_id);
        }
      });

      if (cancelled) {
        unlistenData();
        unlistenStatus();
        return;
      }

      cleanups.push(unlistenData, unlistenStatus);
    };

    setup().catch((e) => {
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
