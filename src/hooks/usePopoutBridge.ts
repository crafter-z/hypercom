import { useEffect } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { useRuleStore } from '../stores/useRuleStore';
import { useTerminalStore } from '../stores/useTerminalStore';
import { popoutEventService } from '../services/tauri';
import { sendToPort } from './useSerialSend';

/**
 * 终端快照行数上限（R3）：缓冲接近 memoryLimitMb 时整包快照载荷过大，
 * 仅推最近 N 行——弹出窗是"实时监视器"，远古历史价值低。v1 取 5000。
 */
const SNAPSHOT_LINE_CAP = 5000;

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

    // 弹窗挂载即请求对表：回放当前活动标签 + 当前命令集，避免指示器/命令列表
    // 在首次变更信号到达前失真（命令集载荷含未保存编辑，弹窗无需回库重读）。
    popoutEventService
      .onRequestSync(() => {
        void popoutEventService.emitActiveTabChanged({
          portId: useAppStore.getState().activeTabId,
        });
        void popoutEventService.emitCommandSetsChanged(
          useRuleStore.getState().sendCommandSets
        );
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
        const terminal = useTerminalStore.getState().terminals[payload.portId];
        if (!terminal) {
          console.debug('[usePopoutBridge] terminal snapshot skipped — no buffer for', payload.portId);
          return;
        }
        const lines = terminal.lines.length > SNAPSHOT_LINE_CAP
          ? terminal.lines.slice(terminal.lines.length - SNAPSHOT_LINE_CAP)
          : terminal.lines;
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
        useAppStore.getState().setTabPoppedOut(payload.portId, false);
      })
      .then((u) => {
        if (cancelled) u();
        else unlisteners.push(u);
      })
      .catch((e) => console.debug('[usePopoutBridge] onTerminalClosed failed:', e));

    // 命令集变更 → 广播完整命令集载荷（immer 变更后引用必变，引用比较即真值）。
    // 携带载荷而非仅信号：主窗 useRuleStore 是唯一真相，config.json 异步落盘，
    // 配置弹窗里未保存的编辑不在盘上——弹窗回库重读会漏掉这些编辑。
    const unsubscribeRules = useRuleStore.subscribe((state, prevState) => {
      if (state.sendCommandSets === prevState.sendCommandSets) return;
      void popoutEventService.emitCommandSetsChanged(state.sendCommandSets);
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
