import { useEffect, useRef } from 'react';
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
import type { CommandEditorSnapshot } from '../services/tauri';
import { registerEditorParticipant } from '../utils/editorLeave';

/**
 * 终端快照行数上限（R3）：缓冲接近 memoryLimitMb 时整包快照载荷过大，
 * 仅推最近 N 行——弹出窗是"实时监视器"，远古历史价值低。v1 取 5000。
 */
const SNAPSHOT_LINE_CAP = 5000;
const commandEditorSession = crypto.randomUUID();
function commandEditorSnapshot(): CommandEditorSnapshot {
  return { ...getEntityEditorSnapshot<SendCommandSet>('sendCommandSets'), sessionId: commandEditorSession };
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
  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let cancelled = false;
    // The client reports only unacknowledged local buffers; core guards drafts.
    const unregisterClient = registerEditorParticipant('popout:pending-commands', {
      isDirty: () => unresolvedClient.current,
      save: async () => {
        const result = await popoutEventService.requestCommandEditorClientLeave('save');
        if (result.success) unresolvedClient.current = false;
        return result.success;
      },
      discard: async () => {
        const result = await popoutEventService.requestCommandEditorClientLeave('discard');
        if (!result.success) throw new Error(result.error ?? 'editor.saveFailed');
        unresolvedClient.current = false;
      },
      label: () => t('popout.quickSendTitle'),
    });
    void popoutEventService.onCommandEditorClientState(unresolved => {
      if (!cancelled) unresolvedClient.current = unresolved;
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
            if (request.sessionId !== commandEditorSession) throw new Error('editor.conflict');
            let current = getEntityEditorSnapshot<SendCommandSet>('sendCommandSets');
            if (request.action !== 'replace' && current.saving) {
              await saveEntityDraft('sendCommandSets');
              if (cancelled) return;
              current = getEntityEditorSnapshot<SendCommandSet>('sendCommandSets');
            }
            if (request.version !== current.version) throw new Error('editor.conflict');
            if (request.action === 'replace') {
              replaceEntityDraft('sendCommandSets', request.items, request.version);
              success = true;
            } else if (request.action === 'save') {
              success = await saveEntityDraft('sendCommandSets', request.id);
              const after = getEntityEditorSnapshot('sendCommandSets');
              if (success && (request.id ? after.dirtyIds.includes(request.id) : after.dirty)) success = false;
              if (!success) error = after.error ?? 'editor.saveFailed';
            } else {
              discardEntityDraft('sendCommandSets', request.id);
              success = true;
            }
          } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause);
          }
          if (!cancelled) await popoutEventService.emitCommandEditorResult({
            requestId: request.requestId, success, error,
            snapshot: commandEditorSnapshot(),
          });
        })().catch(error => console.debug('[usePopoutBridge] command editor ACK failed:', error));
      })
      .then((u) => {
        if (cancelled) u();
        else {
          unlisteners.push(u);
          void popoutEventService.emitCommandEditorSnapshot(commandEditorSnapshot())
            .catch(error => console.debug('[usePopoutBridge] initial editor snapshot failed:', error));
        }
      })
      .catch((e) => console.debug('[usePopoutBridge] onCommandEditorRequest failed:', e));

    // Replay only after the popout has registered all snapshot listeners.
    popoutEventService
      .onRequestSync(() => {
        if (cancelled) return;
        // 弹窗可能已销毁（emit 在弹窗 webview 关闭时 reject）——全部静默降级。
        popoutEventService
          .emitActiveTabChanged({ portId: getActivePortId(useAppStore.getState()) })
          .catch((e) => console.debug('[usePopoutBridge] emitActiveTabChanged failed:', e));
        popoutEventService
          .emitCommandSetsChanged(useRuleStore.getState().sendCommandSets)
          .catch((e) => console.debug('[usePopoutBridge] emitCommandSetsChanged failed:', e));
        void popoutEventService.emitCommandEditorSnapshot(commandEditorSnapshot())
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
      void popoutEventService.emitCommandEditorSnapshot({ ...snapshot, sessionId: commandEditorSession })
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
