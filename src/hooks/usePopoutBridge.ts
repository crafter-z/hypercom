import { useEffect } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { useRuleStore } from '../stores/useRuleStore';
import { popoutEventService } from '../services/tauri';
import { sendToPort } from './useSerialSend';

/**
 * Hook: 弹出窗意图总线（主窗侧，`App.tsx` 中恰好调用一次）。
 *
 * 弹出窗是独立 webview，与主窗不共享可变前端态，只交换意图/事件：
 * - 入站：`popout:send-command` → 经 `sendToPort` 走主窗既有发送管线
 *   （TX 回显 / 流量统计 / 发送历史因此与手动发送完全一致）；
 *   `popout:open-config` → 打开 ConfigModal 指定页。
 * - 出站：订阅 store，命令集 / 活动标签变化时广播"刷新信号"
 *   （不携带数据——弹窗收到信号后自己回 SQLite / 自行消费载荷）。
 *
 * 与 useSerialReceive 同属"App 级单例监听器"：重复调用会双重注册。
 */
export function usePopoutBridge() {
  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let cancelled = false;

    // 异步注册竞态保护：参考 SendSection onFileProgress 模式。
    popoutEventService
      .onSendCommand((payload) => {
        const portId = useAppStore.getState().activeTabId;
        if (!portId) {
          console.debug('[usePopoutBridge] popout:send-command ignored — no active tab');
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
        const store = useAppStore.getState();
        store.setConfigActiveTab(payload.page);
        store.toggleConfigModal(true);
      })
      .then((u) => {
        if (cancelled) u();
        else unlisteners.push(u);
      })
      .catch((e) => console.debug('[usePopoutBridge] onOpenConfig failed:', e));

    // 弹窗挂载即请求对表：回放一次当前活动标签，避免指示器在首次切标签前失真。
    popoutEventService
      .onRequestSync(() => {
        void popoutEventService.emitActiveTabChanged({
          portId: useAppStore.getState().activeTabId,
        });
      })
      .then((u) => {
        if (cancelled) u();
        else unlisteners.push(u);
      })
      .catch((e) => console.debug('[usePopoutBridge] onRequestSync failed:', e));

    // 命令集变更 → 广播信号，弹窗回库重读（immer 变更后引用必变，引用比较即真值）。
    const unsubscribeRules = useRuleStore.subscribe((state, prevState) => {
      if (state.sendCommandSets === prevState.sendCommandSets) return;
      void popoutEventService.emitCommandSetsChanged();
    });

    // 活动标签变更 → 广播新 portId，弹窗更新发送目标指示。
    const unsubscribeApp = useAppStore.subscribe((state, prevState) => {
      if (state.activeTabId === prevState.activeTabId) return;
      void popoutEventService.emitActiveTabChanged({ portId: state.activeTabId });
    });

    return () => {
      cancelled = true;
      unlisteners.forEach((u) => u());
      unsubscribeRules();
      unsubscribeApp();
    };
  }, []);
}
