import { useEffect } from 'react';
import { useSystemStore } from '../stores/useSystemStore';
import { updateTiming, shouldAutoCheck, isUpdateCheckEnabled, runAutoCheck, getCommittedUpdateMode } from '../utils/updateService';
import {
  isPluginUpdateCheckEnabled,
  pluginUpdateTiming,
  runPluginAutoCheck,
  shouldCheckPluginUpdates,
} from '../utils/pluginUpdateService';

/**
 * 会话内周期重评估间隔（issue #12 二轮）：串口工具常驻运行，「启动评估一次」
 * 覆盖不了挂机数天不重启的用户。评估本身经 shouldAutoCheck 门控（7 天周期 +
 * snooze），未到期时只读一次 localStorage，成本可忽略。
 */
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * 自动更新生命周期（issue #12）
 * - config 就绪（`ui.configReady`，useConfigPersistence.loadConfig 成功或失败后置位）后
 *   首次评估：模式 none → 跳过；否则按「周期 7 天 + snooze + 首启立即」决定
 *   是否检查（纯函数 shouldAutoCheck）。配置仍在加载时不按默认 stable 发请求，
 *   避免慢启动覆盖用户已持久化的 none/preview 意图。
 * - **软件更新与插件市场更新联动**：两者独立门控（macOS 不检查软件本体，
 *   但仍检查插件市场），并发执行；插件侧按 7 天周期记账（shouldCheckPluginUpdates）。
 * - **会话内每 6h 重评估**（二轮）：覆盖长期挂机场景。检查成功（有无更新同）
 *   各自记账；失败静默不记账——下次启动/下个周期重试（console/debug 由
 *   diagLog 落盘，不打扰用户）。
 * - 发现更新 → 打开 UpdateDialog / 插件更新通知（通知中心）。
 * - 仅在主窗挂载一次（App.tsx）。
 */
export function useAutoUpdate(): void {
  useEffect(() => {
    let cancelled = false;
    let started = false;

    const evaluate = async () => {
      if (cancelled) return;
      const mode = getCommittedUpdateMode();
      // none 同时关闭软件与插件的自动检查。
      if (mode === 'none') return;
      const now = Date.now();

      const appDue = isUpdateCheckEnabled()
        && shouldAutoCheck(mode, now, updateTiming.getLastCheckAt(), updateTiming.getSnoozeUntil());
      const pluginDue = isPluginUpdateCheckEnabled()
        && shouldCheckPluginUpdates(mode, now, pluginUpdateTiming.getLastCheckAt());

      const checks: Promise<unknown>[] = [];
      if (appDue) checks.push(runAutoCheck());
      if (pluginDue) checks.push(runPluginAutoCheck());
      if (checks.length > 0) await Promise.all(checks);
    };

    const start = () => {
      if (started || cancelled) return;
      started = true;
      void evaluate();
    };

    // Keep listening until loading settles; a timeout cannot establish user intent.
    const unsub = useSystemStore.subscribe((state, prev) => {
      if (state.ui.configReady && !prev.ui.configReady) start();
    });
    // 挂载时已就绪（未来挂载顺序变化时）→ 直接评估。
    if (useSystemStore.getState().ui.configReady) {
      start();
    }

    // ---- 会话内周期重评估（issue #12 二轮：长期挂机场景）----
    const interval = setInterval(() => {
      if (!useSystemStore.getState().ui.configReady) return;
      void evaluate();
    }, RECHECK_INTERVAL_MS);

    return () => {
      cancelled = true;
      unsub();
      clearInterval(interval);
    };
  }, []);
}
