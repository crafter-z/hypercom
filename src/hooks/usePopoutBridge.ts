import { useEffect, useRef } from 'react';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { jsonEqual } from '../utils/jsonEqual';
import { useTranslation } from 'react-i18next';
import { findSerialTabByPortId, getActivePortId, useAppStore } from '../stores/useAppStore';
import { useRuleStore } from '../stores/useRuleStore';
import { useSystemStore } from '../stores/useSystemStore';
import { useTerminalStore } from '../stores/useTerminalStore';
import { popoutEventService, popoutService } from '../services/tauri';
import { sendToPort } from './useSerialSend';
import { getRxPipeline } from '../utils/rxPipeline';
import { snapshotTerminalLines } from '../utils/terminal/viewportManager';
import { discardEntityDraft, getEntityEditorSnapshot, replaceEntityDraft, saveEntityDraft, subscribeEntityEditor } from '../utils/entityEditor';
import type { SendCommandSet } from '../types';
import type { CommandEditorClientIdentity, CommandEditorSnapshot } from '../services/tauri';
import { registerEditorParticipant } from '../utils/editorLeave';

/**
 * 终端快照行数上限（R3）：缓冲接近 memoryLimitMb 时整包快照载荷过大，
 * 仅推最近 N 行——弹出窗是"实时监视器"，远古历史价值低。v1 取 5000。
 */
const SNAPSHOT_LINE_CAP = 5000;
/**
 * The panel reports the command sets its replace touched so a later discard can
 * roll back exactly those records (the panel is a separate WebView and has no
 * collection id). `ids` rides along with the versioned request payload.
 */
type PanelEdit = { before: SendCommandSet | undefined; accepted: SendCommandSet | undefined; index: number };

/** Return true when the user accepts a cross-window whole-collection rollback. */
function confirmCrossWindowDiscard(message: string): boolean {
  // A missing/unsupported dialog is not consent to lose another window's work.
  return typeof window.confirm === 'function' && window.confirm(message) === true;
}

const commandEditorSession = crypto.randomUUID();
function commandEditorSnapshot(clientId?: string): CommandEditorSnapshot {
  return { ...getEntityEditorSnapshot<SendCommandSet>('sendCommandSets'), sessionId: commandEditorSession, clientProtocol: 2, clientId };
}

/**
 * Hook: 弹出窗意图总线（主窗侧，`App.tsx` 中恰好调用一次）。
 *
 * 弹出窗是独立 webview，与主窗不共享可变前端态，只交换意图/事件：
 * - 入站：`popout:send-command` → 经 `sendToPort` 走主窗既有发送管线
 *   （TX 回显 / 流量统计 / 发送历史因此与手动发送完全一致）；
 *   `popout:open-config` → 打开 ConfigModal 指定页；
 *   `popout:command-editor-request` → versioned main-owned draft/save/discard + ACK;
 *   `popout:request-sync` → committed sets, editor snapshot, active port and status;
 *   `popout:terminal:request-snapshot` → terminal history snapshot.
 * - Outbound committed runtime sets and editor drafts are separate streams.
 *
 * 与 useSerialReceive 同属"App 级单例监听器"：重复调用会双重注册。
 */
export function usePopoutBridge() {
  const { t } = useTranslation();
  const unresolvedClient = useRef(false);
  // Undo only accepted panel changes, back to the draft it actually edited (not
  // the persisted baseline, which may predate unrelated main-window work).
  const panelEdits = useRef(new Map<string, PanelEdit>());
  const panelOrder = useRef<{ before: string[]; accepted: string[] } | null>(null);
  const clientStateVersion = useRef(0);
  const activeClient = useRef<CommandEditorClientIdentity | null>(null);
  const retiredClients = useRef(new Set<string>());
  const clientChallenges = useRef(new Map<string, { challengeId: string; sequence: number; parentClientId: string | null }>());
  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let cancelled = false;
    // Native destruction need not run the client's React cleanup. Do not wait
    // 15 seconds for a reply from a WebView that no longer exists.
    const leaveClient = async (action: 'save' | 'discard'): Promise<boolean> => {
      const version = clientStateVersion.current;
      const target = activeClient.current;
      const isCurrent = () => activeClient.current?.clientId === target?.clientId;
      if (!await WebviewWindow.getByLabel('quick-send')) {
        if (isCurrent() && version === clientStateVersion.current) {
          unresolvedClient.current = false;
          if (target) { retiredClients.current.add(target.clientId); activeClient.current = null; }
        }
        return !unresolvedClient.current;
      }
      if (!isCurrent()) return false;
      const result = await popoutEventService.requestCommandEditorClientLeave(action, target ?? undefined);
      if (!isCurrent()) return false;
      if (target) {
        if (result.clientId !== target.clientId || result.sessionId !== commandEditorSession ||
          !Number.isSafeInteger(result.sequence) || result.sequence! < activeClient.current!.sequence) return false;
        activeClient.current = { ...target, sequence: result.sequence! };
        unresolvedClient.current = !result.success || result.unresolved !== false;
      } else if (result.success && version === clientStateVersion.current) unresolvedClient.current = false;
      return result.success && !unresolvedClient.current;
    };
    // The client reports only unacknowledged local buffers; core guards drafts.
    const unregisterClient = registerEditorParticipant('popout:pending-commands', {
      isDirty: () => unresolvedClient.current,
      save: () => leaveClient('save'),
      discard: async () => {
        if (!await leaveClient('discard')) throw new Error('editor.saveFailed');
      },
      label: () => t('popout.quickSendTitle'),
    });
    void popoutEventService.onCommandEditorClientState(state => {
      if (cancelled) return;
      if (typeof state === 'boolean') {
        // A legacy message cannot override a modern panel once it handshook.
        if (activeClient.current || retiredClients.current.size > 0) return;
        unresolvedClient.current = state;
      } else {
        const current = activeClient.current;
        if (!current || state.clientId !== current.clientId || state.sessionId !== commandEditorSession ||
          !Number.isSafeInteger(state.sequence) || state.sequence <= current.sequence) return;
        activeClient.current = { clientId: state.clientId, sessionId: state.sessionId, sequence: state.sequence };
        unresolvedClient.current = state.unresolved;
      }
      clientStateVersion.current++;
    }).then(stop => {
      if (cancelled) stop();
      else unlisteners.push(stop);
    }).catch(error => console.debug('[usePopoutBridge] client state listener failed:', error));

    // 异步注册竞态保护：参考 SendSection onFileProgress 模式。
    popoutEventService
      .onSendCommand((payload) => {
        if (cancelled) return;
        // 显式目标端口优先（issue #5-4-6）：弹窗携带 portId 时发送到该端口，
        // 否则退回活动标签。端口已关闭时 sendToPort 内部守卫负责 toast/静默。
        const portId = payload.portId ?? getActivePortId(useAppStore.getState());
        if (!portId) {
          // 无活动标签是正常控制流分支（弹窗发送无目标），非错误，不记录。
          return;
        }
        void sendToPort(portId, payload.content, payload.isHex, payload.lineEnding);
      })
      .then((u) => {
        if (cancelled) u();
        else unlisteners.push(u);
      })
      .catch((e) => console.debug('[usePopoutBridge] onSendCommand failed:', e));

    popoutEventService
      .onOpenConfig((payload) => {
        if (cancelled) return;
        const ui = useSystemStore.getState();
        ui.setConfigActiveTab(payload.page);
        ui.toggleConfigModal(true);
      })
      .then((u) => {
        if (cancelled) u();
        else unlisteners.push(u);
      })
      .catch((e) => console.debug('[usePopoutBridge] onOpenConfig failed:', e));

    popoutEventService
      .onCommandEditorRequest((request) => {
        if (cancelled) return;
        void (async () => {
          let success = false;
          let error: string | null = null;
          try {
            const ownsClient = () => activeClient.current
              ? request.clientId === activeClient.current.clientId
              : !request.clientId && retiredClients.current.size === 0;
            if (request.sessionId !== commandEditorSession || !ownsClient()) throw new Error('editor.conflict');
            let current = getEntityEditorSnapshot<SendCommandSet>('sendCommandSets');
            if (request.action !== 'replace' && current.saving) {
              await saveEntityDraft('sendCommandSets');
              if (cancelled) return;
              current = getEntityEditorSnapshot<SendCommandSet>('sendCommandSets');
            }
            if (!ownsClient() || request.version !== current.version) throw new Error('editor.conflict');
            const reported = request.ids;
            if (request.action === 'replace') {
              replaceEntityDraft('sendCommandSets', request.items, request.version, !!request.overwrite);
              const before = new Map(current.items.map(item => [item.id, item]));
              const after = new Map(request.items.map(item => [item.id, item]));
              for (const id of new Set([...before.keys(), ...after.keys()])) {
                if (jsonEqual(before.get(id), after.get(id))) continue;
                const previous = panelEdits.current.get(id);
                // If main changed this record since our last ACK, that newly
                // adopted draft is the undo baseline for this next panel edit.
                const continuing = previous && jsonEqual(before.get(id), previous.accepted);
                panelEdits.current.set(id, {
                  before: continuing ? previous.before : before.get(id), accepted: after.get(id),
                  index: continuing ? previous.index : current.items.findIndex(item => item.id === id),
                });
              }
              const beforeOrder = current.items.map(item => item.id);
              const acceptedOrder = request.items.map(item => item.id);
              if (!jsonEqual(beforeOrder, acceptedOrder)) panelOrder.current = {
                before: panelOrder.current && jsonEqual(beforeOrder, panelOrder.current.accepted) ? panelOrder.current.before : beforeOrder,
                accepted: acceptedOrder,
              };
              success = true;
            } else if (request.action === 'save') {
              success = await saveEntityDraft('sendCommandSets', request.id);
              if (!ownsClient()) throw new Error('editor.conflict');
              const after = getEntityEditorSnapshot('sendCommandSets');
              if (success && (request.id ? after.dirtyIds.includes(request.id) : after.dirty)) success = false;
              if (!success) error = after.error ?? 'editor.saveFailed';
              else if (request.id) panelEdits.current.delete(request.id);
              else { panelEdits.current.clear(); panelOrder.current = null; }
            } else {
              const ids = request.id ? [request.id] : reported ?? [...panelEdits.current.keys()];
              const owned = ids.filter(id => panelEdits.current.has(id));
              const orderUndo = request.id ? null : panelOrder.current;
              if (owned.length > 0 || orderUndo) {
                const byId = new Map(current.items.map(item => [item.id, item]));
                // A later main edit is not ours to throw away, even on the same id.
                for (const id of owned) {
                  if (!jsonEqual(byId.get(id), panelEdits.current.get(id)!.accepted)) throw new Error('editor.conflict');
                }
                if (orderUndo && !jsonEqual(current.items.map(item => item.id), orderUndo.accepted)) throw new Error('editor.conflict');
                let restored = [...current.items];
                for (const id of owned) {
                  const edit = panelEdits.current.get(id)!;
                  const index = restored.findIndex(item => item.id === id);
                  if (edit.before) {
                    if (index >= 0) restored[index] = edit.before;
                    else restored.splice(Math.max(0, edit.index), 0, edit.before);
                  } else restored = restored.filter(item => item.id !== id);
                }
                if (orderUndo) {
                  const order = orderUndo.before;
                  restored.sort((a, b) => {
                    const ai = order.indexOf(a.id), bi = order.indexOf(b.id);
                    return (ai < 0 ? order.length : ai) - (bi < 0 ? order.length : bi);
                  });
                }
                replaceEntityDraft('sendCommandSets', restored, current.version);
              } else if (reported === undefined && !request.id) {
                // Compatibility for legacy panels without attribution. Current
                // panels send even an empty ids list for unaccepted local text.
                if (!confirmCrossWindowDiscard(t('editor.crossWindowDiscardWarning'))) throw new Error('editor.crossWindowDiscardWarning');
                discardEntityDraft('sendCommandSets');
              }
              for (const id of owned) panelEdits.current.delete(id);
              if (!request.id) panelOrder.current = null;
              success = true;
            }
          } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause);
          }
          if (!cancelled) await popoutEventService.emitCommandEditorResult({
            requestId: request.requestId, success, error,
            snapshot: commandEditorSnapshot(activeClient.current?.clientId),
          });
        })().catch(error => console.debug('[usePopoutBridge] command editor ACK failed:', error));
      })
      .then((u) => {
        if (cancelled) u();
        else {
          unlisteners.push(u);
          void popoutEventService.emitCommandEditorSnapshot(commandEditorSnapshot(activeClient.current?.clientId))
            .catch(error => console.debug('[usePopoutBridge] initial editor snapshot failed:', error));
        }
      })
      .catch((e) => console.debug('[usePopoutBridge] onCommandEditorRequest failed:', e));

    // Replay only after the popout has registered all snapshot listeners.
    popoutEventService
      .onRequestSync(request => {
        if (cancelled) return;
        const resetUndo = !request || request.resetUndo || activeClient.current?.clientId !== request.clientId;
        if (request) {
          if (!request.clientId || !Number.isSafeInteger(request.sequence) || request.sequence < 0 ||
            request.sessionId && request.sessionId !== commandEditorSession || retiredClients.current.has(request.clientId)) return;
          const current = activeClient.current;
          if (current?.clientId === request.clientId && request.sequence <= current.sequence) return;
          if (current?.clientId !== request.clientId) {
            const pending = clientChallenges.current.get(request.clientId);
            if (!pending || request.challengeId !== pending.challengeId || request.sessionId !== commandEditorSession ||
              request.sequence <= pending.sequence || pending.parentClientId !== (current?.clientId ?? null)) {
              // A delayed first-ever request is not proof that its WebView still
              // exists. Only that client's live listener can echo this fresh,
              // host-session and current-handoff-bound nonce.
              const challenge = { challengeId: crypto.randomUUID(), sequence: request.sequence, parentClientId: current?.clientId ?? null };
              clientChallenges.current.set(request.clientId, challenge);
              if (!current) { unresolvedClient.current = true; clientStateVersion.current++; }
              void popoutEventService.emitCommandEditorSnapshot({
                ...commandEditorSnapshot(request.clientId), challengeId: challenge.challengeId, syncRequestId: request.syncRequestId,
              }).catch(error => console.debug('[usePopoutBridge] client challenge failed:', error));
              return;
            }
            clientChallenges.current.delete(request.clientId);
          }
          if (current && current.clientId !== request.clientId) retiredClients.current.add(current.clientId);
          activeClient.current = { clientId: request.clientId, sessionId: commandEditorSession, sequence: request.sequence };
          // Fail closed until this client's snapshot replay reports its buffer.
          unresolvedClient.current = true;
          clientStateVersion.current++;
        } else if (activeClient.current || retiredClients.current.size > 0) return;
        // A newly mounted panel (or explicit reload-host) adopts these drafts;
        // it must not inherit undo ownership from a retired panel instance.
        if (resetUndo) { panelEdits.current.clear(); panelOrder.current = null; }
        // 弹窗可能已销毁（emit 在弹窗 webview 关闭时 reject）——全部静默降级。
        popoutEventService
          .emitActiveTabChanged({ portId: getActivePortId(useAppStore.getState()) })
          .catch((e) => console.debug('[usePopoutBridge] emitActiveTabChanged failed:', e));
        popoutEventService
          .emitCommandSetsChanged(useRuleStore.getState().sendCommandSets)
          .catch((e) => console.debug('[usePopoutBridge] emitCommandSetsChanged failed:', e));
        void popoutEventService.emitCommandEditorSnapshot({ ...commandEditorSnapshot(activeClient.current?.clientId), syncRequestId: request?.syncRequestId })
          .catch(error => console.debug('[usePopoutBridge] editor snapshot failed:', error));
        // issue #7-5：回放全部串口连接状态，弹窗「发送到」提示灯打开即准确。
        popoutEventService
          .emitPortStatusesSync(
            useAppStore.getState().ports.map((p) => ({ portId: p.id, status: p.status }))
          )
          .catch((e) => console.debug('[usePopoutBridge] emitPortStatusesSync failed:', e));
      })
      .then((u) => {
        if (cancelled) u();
        else unlisteners.push(u);
      })
      .catch((e) => console.debug('[usePopoutBridge] onRequestSync failed:', e));

    // 终端弹窗请求历史快照：终端行是主窗内存态（不在 SQLite），故由主窗一次性
    // 回推当前缓冲 + 显示态。request→reply 保证快照晚于弹窗监听器注册到达。
    // 快照仅含纯可序列化数据（lines + 显示态）；超长按 R3 截最近 N 行。
    popoutEventService
      .onTerminalRequestSnapshot((payload) => {
        if (cancelled) return;
        const terminal = useTerminalStore.getState().terminals[payload.portId];
        if (!terminal) {
          // 弹窗在端口终端尚未建立时快照，属正常竞态分支，非错误，不记录。
          return;
        }
        // 先把主窗管线队列里的整行冲进环形缓冲：快照必须覆盖主窗到此刻为止收到的
        // 全部事件，弹窗才能用「时间戳晚于快照末行」判定哪些实时事件还没进快照。
        // Flush both the batch queue and the unterminated assembler tail: the
        // pop-out replaces its buffer with this snapshot, so bytes received
        // before the request but not yet newline-terminated must be included.
        getRxPipeline().flushTail(payload.portId);
        getRxPipeline().flushBeforeSend(payload.portId);
        const lines = snapshotTerminalLines(payload.portId, SNAPSHOT_LINE_CAP);
        void popoutEventService
          .emitTerminalSnapshot({ portId: payload.portId, terminal: { ...terminal, lines } })
          .catch((e) => console.debug('[usePopoutBridge] emitTerminalSnapshot failed:', e));
      })
      .then((u) => {
        if (cancelled) u();
        else unlisteners.push(u);
      })
      .catch((e) => console.debug('[usePopoutBridge] onTerminalRequestSnapshot failed:', e));

    // 终端弹出窗关闭（Rust on_window_event 探测）→ 回贴标签，主窗恢复终端显示。
    popoutEventService
      .onTerminalClosed((payload) => {
        if (cancelled || !popoutService.terminalClosed(payload.portId)) return;
        const state = useAppStore.getState();
        const tab = findSerialTabByPortId(state, payload.portId);
        if (tab) state.setTabPoppedOut(tab.id, false);
      })
      .then((u) => {
        if (cancelled) u();
        else unlisteners.push(u);
      })
      .catch((e) => console.debug('[usePopoutBridge] onTerminalClosed failed:', e));

    // Runtime consumers still receive committed sets, never unsaved drafts.
    const unsubscribeRules = useRuleStore.subscribe((state, prevState) => {
      if (cancelled || state.sendCommandSets === prevState.sendCommandSets) return;
      popoutEventService
        .emitCommandSetsChanged(state.sendCommandSets)
        .catch((e) => console.debug('[usePopoutBridge] emitCommandSetsChanged failed:', e));
    });

    let previousEditorSnapshot = getEntityEditorSnapshot<SendCommandSet>('sendCommandSets');
    const unsubscribeEditor = subscribeEntityEditor(() => {
      const snapshot = getEntityEditorSnapshot<SendCommandSet>('sendCommandSets');
      if (cancelled || snapshot === previousEditorSnapshot) return;
      previousEditorSnapshot = snapshot;
      void popoutEventService.emitCommandEditorSnapshot(commandEditorSnapshot(activeClient.current?.clientId))
        .catch(error => console.debug('[usePopoutBridge] editor snapshot failed:', error));
    });

    // 活动标签变更 → 广播新 portId，弹窗更新发送目标指示。
    const unsubscribeApp = useAppStore.subscribe((state, prevState) => {
      if (cancelled || getActivePortId(state) === getActivePortId(prevState)) return;
      popoutEventService
        .emitActiveTabChanged({ portId: getActivePortId(state) })
        .catch((e) => console.debug('[usePopoutBridge] emitActiveTabChanged failed:', e));
    });

    return () => {
      cancelled = true;
      unlisteners.forEach((u) => u());
      unregisterClient();
      unsubscribeRules();
      unsubscribeEditor();
      unsubscribeApp();
    };
  }, [t]);
}
