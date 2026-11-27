import { useEffect } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { useRuleStore } from '../stores/useRuleStore';
import { eventService } from '../services/tauri';
import type { SerialDataEvent, SerialStatusEvent } from '../services/tauri';
import { acceptSerialStatus, shouldFocusSerialConnection } from '../utils/serialConnectionRuntime';
import { ProtocolFrameReassembler } from '../utils/protocolParser';
import type { ProtocolTemplate, TriggerRule } from '../types';
import { getRxPipeline } from '../utils/rxPipeline';
import { ttyService } from '../utils/ttyService';
import { trafficStats } from '../utils/trafficStats';
import { evaluateTriggers } from '../utils/triggerEngine';
import { parseHexBytes } from '../utils/hexUtils';
import { sendToPort } from './useSerialSend';
import { notifyPortDisconnected } from '../utils/pluginObserver';
import { feedPluginBytes, hasPluginBytesObservers, notifyBytesPortDisconnected } from '../utils/pluginBytesObserver';
import { useToastStore } from '../stores/useToastStore';
import i18n from '../i18n';
import type { PortStatus } from '../types';
import { userClosingPortIds, lostPortIds } from './disconnectTracking';
import { hasPortDisplayConsumers, hasPortLineConsumers, notifyPluginViewPortStatus, subscribePortInputConsumersChanged } from '../utils/pluginViewInput';
import { appendTerminalLines } from '../utils/terminal/viewportManager';
import { isRemotePortId } from '../utils/portCapabilities';

// Alert toast throttle: same rule re-matched within this window (ms) must
// not spam toasts — module-level so it survives the empty-deps effect.
const TRIGGER_ALERT_THROTTLE_MS = 1000;
/** Throttle independently per rule and source port: an unscoped rule must not
 * hide COM2's alert merely because COM1 matched moments earlier. */
const triggerAlertThrottle = new Map<string, Map<string, number>>();

/**
 * Rule ids are user-editable and can be replaced indefinitely during a long
 * session. Keep alert throttle metadata scoped to the currently committed
 * trigger rules so deleting a rule also releases its old id.
 */
function pruneTriggerAlertThrottle(): void {
  const activeRuleIds = new Set(useRuleStore.getState().triggerRules.map((rule) => rule.id));
  for (const [ruleId, ports] of triggerAlertThrottle) {
    if (!activeRuleIds.has(ruleId)) triggerAlertThrottle.delete(ruleId);
    else if (ports.size === 0) triggerAlertThrottle.delete(ruleId);
  }
}

/** Auto responses are serialized per port so multiple rules matched by one RX
 * line have deterministic TX order. A short echo guard prevents the common
 * `PING -> PING` device/SIM echo from recursively scheduling forever. */
const TRIGGER_RESPONSE_ECHO_GUARD_MS = 1000;
const MAX_PENDING_TRIGGER_RESPONSES = 64;
interface TriggerResponseEchoGuard {
  content: string;
  isHex: boolean;
  expiresAt: number;
}
const triggerRespondQueues = new Map<string, Promise<void>>();
const triggerRespondPending = new Map<string, number>();
const triggerResponseEchoGuards = new Map<string, Map<string, TriggerResponseEchoGuard>>();

function bytesContain(haystack: Uint8Array, needle: number[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  outer: for (let start = 0; start <= haystack.length - needle.length; start++) {
    for (let index = 0; index < needle.length; index++) {
      if (haystack[start + index] !== needle[index]) continue outer;
    }
    return true;
  }
  return false;
}

function isRecentTriggerResponseEcho(portId: string, ruleId: string, text: string, rawData: Uint8Array, now: number): boolean {
  const guard = triggerResponseEchoGuards.get(ruleId)?.get(portId);
  if (!guard) return false;
  if (guard.expiresAt <= now) {
    triggerResponseEchoGuards.get(ruleId)?.delete(portId);
    return false;
  }
  if (guard.isHex) return bytesContain(rawData, parseHexBytes(guard.content));
  return guard.content.length > 0 && text.includes(guard.content);
}

function clearTriggerResponseEcho(portId: string, ruleId: string, guard: TriggerResponseEchoGuard): void {
  const byPort = triggerResponseEchoGuards.get(ruleId);
  if (byPort?.get(portId) === guard) {
    byPort.delete(portId);
    if (byPort.size === 0) triggerResponseEchoGuards.delete(ruleId);
  }
}

function queueTriggerResponse(portId: string, rule: TriggerRule): void {
  const pending = triggerRespondPending.get(portId) ?? 0;
  if (pending >= MAX_PENDING_TRIGGER_RESPONSES) {
    console.warn('[useSerialReceive] Dropping trigger response backlog:', portId);
    return;
  }
  const now = Date.now();
  const guard: TriggerResponseEchoGuard = {
    content: rule.actionContent,
    isHex: rule.actionIsHex,
    expiresAt: now + TRIGGER_RESPONSE_ECHO_GUARD_MS,
  };
  const byPort = triggerResponseEchoGuards.get(rule.id) ?? new Map<string, TriggerResponseEchoGuard>();
  byPort.set(portId, guard);
  triggerResponseEchoGuards.set(rule.id, byPort);

  const previous = triggerRespondQueues.get(portId) ?? Promise.resolve();
  triggerRespondPending.set(portId, pending + 1);
  const task = previous.catch(() => undefined).then(async () => {
    // Start the echo window when this queued response actually owns the send
    // lane, not when it was enqueued behind a slow earlier response.
    guard.expiresAt = Date.now() + TRIGGER_RESPONSE_ECHO_GUARD_MS;
    try {
      const bytesWritten = await sendToPort(portId, rule.actionContent, rule.actionIsHex, 'None', true);
      // A rejected/blocked or zero-byte action cannot produce the guarded echo.
      if (bytesWritten === 0) clearTriggerResponseEcho(portId, rule.id, guard);
    } catch (error) {
      clearTriggerResponseEcho(portId, rule.id, guard);
      console.debug('[useSerialReceive] trigger respond failed:', rule.id, error);
    }
  });
  const settled = task.finally(() => {
    const current = triggerRespondPending.get(portId) ?? 1;
    if (current <= 1) triggerRespondPending.delete(portId);
    else triggerRespondPending.set(portId, current - 1);
    if (triggerRespondQueues.get(portId) === settled) triggerRespondQueues.delete(portId);
  });
  triggerRespondQueues.set(portId, settled);
  // The task handles send failures; consume finally's rejection defensively.
  void settled.catch(() => undefined);
}

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
        // Throttle independently per source port so a shared rule can alert on
        // COM1 and COM2 in the same window without cross-port suppression.
        const now = Date.now();
        const byPort = triggerAlertThrottle.get(rule.id) ?? new Map<string, number>();
        if (now - (byPort.get(portId) ?? 0) < TRIGGER_ALERT_THROTTLE_MS) continue;
        byPort.set(portId, now);
        triggerAlertThrottle.set(rule.id, byPort);
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
        if (isRemotePortId(portId)) continue;
        const now = Date.now();
        if (isRecentTriggerResponseEcho(portId, rule.id, text, rawData, now)) {
          // The device echoed a response payload that would match this rule;
          // suppress only this short-lived self-echo, not normal repeated RX.
          continue;
        }
        queueTriggerResponse(portId, rule);
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
 * - serial tabs are found by kind + portId; workspace ids remain independent;
 * - 新标签页落在 `focusedPaneId` 所在叶子（多 Pane 递归树行为与手动一致）并激活；
 * - 关闭串口不受影响——closePort 只改端口状态，本函数不处理 disconnected。
 */
export function openTabForConnectedPort(portId: string): void {
  // A plugin opens a background connection, not a workspace navigation request.
  // The policy is retained by the runtime for subsequent reconnects as well.
  if (!shouldFocusSerialConnection(portId)) return;
  const state = useAppStore.getState();
  // Reconnecting an independently bound view must not resurrect its closed raw tab.
  if (hasPortDisplayConsumers(portId) && !state.tabs.some(tab => tab.kind === 'serial' && tab.portId === portId)) return;
  state.openTab(portId);
}

/**
 * Hook: 串口数据接收（事件监听生命周期）
 * 监听 Tauri 的 onSerialData / onSerialStatus 事件，将接收到的数据写入终端，
 * 并在后端上报端口状态变化时同步到 app store。
 *
 * RX 路径走 RxPipeline（字节级行聚合 + rAF 批写）：
 * - 普通流：pipeline.feedBytes → 组装器切行 → 解码 → 入队 → rAF 批写
 * - 协议帧：ProtocolFrameReassembler 返回有序段，帧段经 enqueueFrame 入队并通知 RX 观察者，
 *   裸段经 feedBytes 入队——两者共享队列，天然保流顺序
 *
 * P1-1：条件触发器改在 RxPipeline 的 onLineAssembled 钩子（完整行边界）评估，
 * 而非旧的「按 serial:data 读事件块」匹配——读事件边界任意，跨块模式会失效。
 *
 * SRP：只负责事件订阅与数据入管线，不涉及任何用户主动发送动作。
 * 必须在应用根组件挂载一次（事件监听全局唯一）。
 */
export function useSerialReceive() {

  useEffect(() => {
    let cancelled = false;
    const cleanups: Array<() => void> = [];
    // Also prune on remount: rule edits can happen while this root listener is
    // temporarily absent (tests, hot reload, or a remounted shell).
    pruneTriggerAlertThrottle();
    const pipeline = getRxPipeline();
    pipeline.setLineConsumerQuery(hasPortLineConsumers);
    const modes = new Map<string, string>();
    // Older data events may omit a connection generation. Keep an explicit
    // per-port session gate so a reader event racing a disconnect/error cannot
    // recreate RX state and bridge bytes into the next connection.
    const activeSessions = new Map<string, number | null>();
    for (const port of useAppStore.getState().ports) {
      modes.set(port.id, port.mode ?? 'trx');
      if (port.status === 'connected') activeSessions.set(port.id, port.connectionGeneration ?? null);
    }
    // Only the current binding per port is retained. Changing a template (even
    // A → B → A), editing it or disabling it must never revive historical bytes.
    const reassemblers = new Map<string, {
      template: ProtocolTemplate;
      parser: ProtocolFrameReassembler;
      lastEventTs: number;
    }>();
    const retire = (portId: string, keepOutput: boolean): void => {
      const previous = reassemblers.get(portId);
      if (!previous) return;
      reassemblers.delete(portId);
      const pending = previous.parser.drain();
      if (keepOutput && pending.length > 0) pipeline.feedBytes(portId, pending, previous.lastEventTs);
      if (keepOutput) pipeline.flushAndReset(portId);
    };
    const bindingFor = (portId: string): ProtocolTemplate | undefined => {
      const port = useAppStore.getState().ports.find(p => p.id === portId);
      if (!port || port.mode === 'tty' || !port.protocolTemplateId) return undefined;
      return useRuleStore.getState().protocolTemplates.find(
        t => t.id === port.protocolTemplateId && t.isEnabled,
      );
    };
    const syncBindings = (): void => {
      for (const [portId, previous] of reassemblers) {
        const port = useAppStore.getState().ports.find(item => item.id === portId);
        const modeChanged = modes.get(portId) !== (port?.mode ?? 'trx');
        const retained = hasPortLineConsumers(portId);
        if (modeChanged || !retained || previous.template !== bindingFor(portId)) retire(portId, retained && !modeChanged);
      }
      for (const port of useAppStore.getState().ports) {
        const mode = port.mode ?? 'trx';
        if (modes.get(port.id) !== undefined && modes.get(port.id) !== mode) {
          // Preserve completed output, but never carry a partial row into the new mode.
          pipeline.flushBeforeSend(port.id);
          pipeline.releasePort(port.id);
        }
        modes.set(port.id, mode);
        if (!hasPortLineConsumers(port.id)) pipeline.releasePort(port.id);
      }
    };
    const unsubscribeApp = useAppStore.subscribe(syncBindings);
    const unsubscribeRules = useRuleStore.subscribe((state, previous) => {
      if (state.triggerRules !== previous.triggerRules) pruneTriggerAlertThrottle();
      syncBindings();
    });
    const unsubscribeConsumers = subscribePortInputConsumersChanged(syncBindings);

    // P1-1：行级触发器——每条完整行组装完成时评估触发规则（行边界而非读事件块）。
    pipeline.setOnLineAssembled((portId, line) => {
      evaluateLineTriggers(portId, line.text, line.rawData);
    });

    const setup = async () => {
      const unlistenData = await eventService.onSerialData((event: SerialDataEvent) => {
        if (cancelled) return;
        const portId = event.port_id;
        const port = useAppStore.getState().ports.find(p => p.id === portId);
        // Older serial:data payloads may omit generation, so only accept bytes
        // while the receive hook knows this port has an active connected
        // session. Newer payloads are additionally checked below. This drops
        // late reader data during connecting/error/disconnected windows before
        // it can recreate pipeline, TTY, plugin, or traffic state.
        if (!port || port.status !== 'connected' || !activeSessions.has(portId) || userClosingPortIds.has(portId)) return;
        // Newer backends stamp each RX event. Reject bytes from a retired
        // connection even if a stale status event was ignored because a newer
        // session is already active; older backends omit the field and remain
        // protected by the connected-session gate above.
        if (event.generation != null && port.connectionGeneration != null &&
            event.generation !== port.connectionGeneration) return;
        // Traffic stats ONCE per event for ALL paths (protocol + common)
        // P1-1：每事件 setTrafficStats 降频——字节先经 1s 聚合器累计，每秒统一写
        // 一次 store（StatusBar 本就 1s 窗口差分算速率，总量语义不变；消除每事件
        // Zustand 更新 + StatusBar 重渲染，TTY 卡顿根因 #3）。
        if (hasPortDisplayConsumers(portId)) trafficStats.addRx(portId, event.data.length);
        // 插件 RX 原始字节旁路（issue #17 能力补强）：在 TTY 分流/协议解析/行组装
        // **之前**把原始字节喂给插件字节观察者——字节流保真、不分 mode，供
        // 插件把原始串口数据共享给第三方（HTTP 推送）。零订阅者时 O(1) 早退。
        if (hasPluginBytesObservers(portId)) {
          feedPluginBytes(portId, event.data, event.timestamp);
        }

        // TTY 模式（issue #11）：字节直喂 ttyService（xterm 渲染）。
        // 跳过触发引擎 / 协议解析 / RxPipeline 行组装——终端字节流没有「行」语义，
        // 由 xterm.js 完整终端模拟（ANSI 颜色、光标寻址、备用屏幕、CR 覆写）接管。
        if (port.mode === 'tty') {
          ttyService.feed(portId, event.data);
          return;
        }

        // Check every event as well as store transitions, including edits and
        // enabling/disabling a template with the same id.
        syncBindings();
        const template = bindingFor(portId);
        // Protocol parser lifetime follows line consumers, not the raw tab.
        if (!hasPortLineConsumers(portId)) {
          pipeline.releasePort(portId);
          return;
        }
        if (template) {
          let binding = reassemblers.get(portId);
          if (!binding) {
            binding = { template, parser: new ProtocolFrameReassembler(template), lastEventTs: event.timestamp };
            reassemblers.set(portId, binding);
          }
          binding.lastEventTs = event.timestamp;
          const segments = binding.parser.feed(event.data);
          for (const seg of segments) {
            if (seg.kind === 'frame') {
              // Raw bytes without a delimiter precede this complete frame.
              pipeline.flushTail(portId);
              const frameBytes = new Uint8Array(seg.frame.bytes);
              pipeline.enqueueFrame(portId, {
                timestamp: event.timestamp,
                direction: event.direction as 'RX' | 'TX',
                content: pipeline.decodeText(portId, frameBytes),
                rawData: frameBytes,
                isHex: event.is_hex,
                parsedFields: seg.frame.fields,
              });
            } else {
              pipeline.feedBytes(portId, seg.bytes, event.timestamp);
            }
          }
          return;
        }
        // Common non-protocol path: byte-level line aggregation + batched writes
        pipeline.feedBytes(portId, event.data, event.timestamp);
      });
      if (cancelled) {
        unlistenData();
        return;
      }
      cleanups.push(unlistenData);

      const unlistenStatus = await eventService.onSerialStatus((event: SerialStatusEvent) => {
        if (cancelled) return;
        // Ignore a terminal status from an older session that raced a reopen.
        const knownGeneration = useAppStore
          .getState()
          .ports.find((port) => port.id === event.port_id)?.connectionGeneration;
        if (
          knownGeneration !== undefined &&
          event.generation != null &&
          event.generation < knownGeneration
        ) {
          return;
        }
        if (!acceptSerialStatus(event.port_id, event.status)) return;
        const statusMap: Record<string, PortStatus> = {
          connected: 'connected',
          disconnected: 'disconnected',
          error: 'error',
        };
        // A fresh connection clears any prior "lost" mark so the banner
        // hides as soon as the port is back up.
        if (event.status === 'connected') {
          activeSessions.set(event.port_id, event.generation ?? null);
          lostPortIds.delete(event.port_id);
          useAppStore.getState().updatePort(event.port_id, {
            connectionGeneration: event.generation ?? undefined,
          });
          // v0.6.1：连接成功 → 自动打开/激活该端口的标签页（幂等，见上方函数注释）。
          openTabForConnectedPort(event.port_id);
          // issue #11：连接后把 xterm 尺寸再同步一次到后端 pty（覆盖「spawn 后
          // 容器才完成布局」的边角时序；非 GIT: 端口 / 无尺寸时为 no-op）。
          ttyService.resync(event.port_id);
        }
        // Detect an unexpected connected → terminal transition BEFORE updating
        // the store (we need the previous status). Reader errors are normally
        // followed by disconnected, so treating only that later event as the
        // transition would miss the lost banner after status becomes error.
        // User-initiated closes are tracked and suppressed.
        if ((event.status === 'disconnected' || event.status === 'error') && !userClosingPortIds.has(event.port_id)) {
          const prevPort = useAppStore.getState().ports.find(p => p.id === event.port_id);
          if (prevPort && prevPort.status === 'connected' && !prevPort.toolRunning && !prevPort.pluginToolRunning && !prevPort.loan) {
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
        // Error and disconnected are both terminal boundaries for the current
        // reader session. Retire while the port is still bound to its old
        // template/mode, before publishing the new status.
        const terminalStatus = event.status === 'disconnected' || event.status === 'error';
        const hadActiveSession = terminalStatus && activeSessions.has(event.port_id);
        if (terminalStatus) {
          activeSessions.delete(event.port_id);
          retire(event.port_id, true);
          pipeline.disconnect(event.port_id);
        }
        useAppStore.getState().updatePort(event.port_id, {
          status: statusMap[event.status] || 'disconnected',
          ...(event.status === 'connected'
            ? { connectionGeneration: event.generation ?? undefined }
            : { connectionGeneration: undefined }),
        });
        if (terminalStatus) {
          // TTY（issue #11）：flush 队列、保留 xterm 实例——视图跨重连保持挂载。
          ttyService.disconnect(event.port_id);
          // 插件 RX 观察器断流通知（issue #17 复审补强：真实断线与
          // reader error 同样结束当前输入会话；关标签页不清端口状态、不走这里）。
          // A reader normally emits error followed by disconnected; only the
          // first terminal event should retire observer queues and emit detach.
          if (hadActiveSession) {
            notifyPortDisconnected(event.port_id);
            // 插件 RX 字节旁路断流：清该端口遗留字节队列（插件感知「字节流断了」）。
            notifyBytesPortDisconnected(event.port_id);
          }
          notifyPluginViewPortStatus(event.port_id, event.status);
        } else {
          notifyPluginViewPortStatus(event.port_id, event.status);
        }
      });

      if (cancelled) {
        unlistenStatus();
        return;
      }

      cleanups.push(unlistenStatus);

      if (typeof eventService.onSerialToolLoan === 'function') {
        const unlistenLoan = await eventService.onSerialToolLoan((event) => {
          if (cancelled) return;
          const prevPort = useAppStore.getState().ports.find((p) => p.id === event.portId);
          if (event.active) {
            const loan = event.leaseId || event.holder
              ? {
                  leaseId: event.leaseId ?? '',
                  holder: event.holder ?? 'external',
                  reason: event.reason,
                  acquiredAtMs: prevPort?.loan && event.leaseId && prevPort.loan.leaseId === event.leaseId
                    ? prevPort.loan.acquiredAtMs
                    : Date.now(),
                  expiresAtMs: event.expiresAtMs,
                  autoReopen: prevPort?.loan?.autoReopen ?? true,
                  connectionBound: prevPort?.loan?.connectionBound ?? false,
                }
              : undefined;
            useAppStore.getState().updatePort(event.portId, {
              pluginToolRunning: true,
              loan,
            });
          } else {
            useAppStore.getState().updatePort(event.portId, {
              pluginToolRunning: false,
              loan: undefined,
            });
          }
        });
        if (cancelled) {
          unlistenLoan();
          return;
        }
        cleanups.push(unlistenLoan);
      }

      if (typeof eventService.onSerialNote === 'function') {
        const unlistenNote = await eventService.onSerialNote((event) => {
          if (cancelled) return;
          if (!hasPortLineConsumers(event.portId)) return;
          pipeline.flushBeforeSend(event.portId);
          const content = event.source && !event.text.startsWith(`[${event.source}]`)
            ? `[${event.source}] ${event.text}`
            : event.text;
          appendTerminalLines(event.portId, [{
            timestamp: event.timestamp || Date.now(),
            direction: 'NOTE',
            content,
            isHex: false,
          }]);
        });
        if (cancelled) {
          unlistenNote();
          return;
        }
        cleanups.push(unlistenNote);
      }

      if (typeof eventService.onSerialExternalTx === 'function') {
        const unlistenExternalTx = await eventService.onSerialExternalTx((event) => {
          if (cancelled) return;
          const port = useAppStore.getState().ports.find((p) => p.id === event.portId);
          if (port?.connectionGeneration != null && event.generation < port.connectionGeneration) return;
          if (hasPortDisplayConsumers(event.portId) && event.data.length > 0) {
            trafficStats.addTx(event.portId, event.data.length);
          }
          if (!hasPortLineConsumers(event.portId)) return;
          const rawData = Uint8Array.from(event.data);
          pipeline.flushBeforeSend(event.portId);
          const decoded = pipeline.decodeText(event.portId, rawData);
          const content = event.source ? `[${event.source}] ${decoded}` : decoded;
          appendTerminalLines(event.portId, [{
            timestamp: event.timestamp || Date.now(),
            direction: 'TX',
            content,
            rawData,
            isHex: false,
          }]);
        });
        if (cancelled) {
          unlistenExternalTx();
          return;
        }
        cleanups.push(unlistenExternalTx);
      }
    };

    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const startSetup = (attempt: number): void => {
      void setup().catch((e) => {
        cleanups.splice(0).forEach((fn) => fn());
        console.error('[useSerialReceive] Failed to subscribe to serial events:', e);
        // Serial events are the app's core input path: a transient listen()
        // failure must not silence RX for the rest of the session.
        if (cancelled || attempt >= 4) return;
        retryTimer = setTimeout(() => {
          retryTimer = null;
          startSetup(attempt + 1);
        }, Math.min(250 * 2 ** attempt, 4000));
      });
    };
    startSetup(0);

    return () => {
      cancelled = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      cleanups.forEach((fn) => fn());
      unsubscribeApp();
      unsubscribeRules();
      unsubscribeConsumers();
      reassemblers.clear();
    };
    // Event listeners and store subscriptions are owned by this one app-root effect.
  }, []);
}
