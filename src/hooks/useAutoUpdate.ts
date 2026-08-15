import { useEffect } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { updateTiming, shouldAutoCheck, isUpdateCheckEnabled, runAutoCheck } from '../utils/updateService';

/** 就绪信号失联时的兜底等待上限（异常场景才走到，按当前 config 评估）。 */
const CONFIG_READY_FALLBACK_MS = 15_000;

/**
 * 会话内周期重评估间隔（issue #12 二轮）：串口工具常驻运行，「启动评估一次」
 * 覆盖不了挂机数天不重启的用户。评估本身经 shouldAutoCheck 门控（7 天周期 +
 * snooze），未到期时只读一次 localStorage，成本可忽略。
 */
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * 自动更新生命周期（issue #12）
 * - config 就绪（`ui.configReady`，useConfigPersistence.loadConfig 完成置位）后
 *   首次评估：模式 none → 跳过；否则按「周期 7 天 + snooze + 首启立即」决定
 *   是否检查（纯函数 shouldAutoCheck）。复审修复：替代旧 3s 启发式窗口——
 *   config 加载慢于 3s 时旧实现按默认模式误判。
 * - **会话内每 6h 重评估**（二轮）：覆盖长期挂机场景。检查成功（有无更新同）
 *   经 runAutoCheck 记 lastCheckAt 完成时刻；失败静默不记账——下次启动/下个
 *   周期重试（console/debug 由 diagLog 落盘，不打扰用户）。
 * - 发现更新 → 打开 UpdateDialog（通知中心无需参与，弹窗即通知）。
 * - 仅在主窗挂载一次（App.tsx）。
 */
export function useAutoUpdate(): void {
  useEffect(() => {
    // DEV 构建短路（后端 debug 另有一层 Ok(None) 双保险）
    if (!isUpdateCheckEnabled()) return;

    let cancelled = false;
    let started = false;

    const evaluate = async () => {
      const { config } = useAppStore.getState();
      const mode = config.updateCheckMode;
      const now = Date.now();

      if (!shouldAutoCheck(mode, now, updateTiming.getLastCheckAt(), updateTiming.getSnoozeUntil())) {
        return;
      }

      const channel = mode === 'preview' ? 'preview' : 'stable';
      const update = await runAutoCheck(channel);
      if (cancelled) return;

      if (update) {
        useAppStore.getState().setUIState({
          isUpdateOpen: true,
          updateCandidate: update,
        });
      }
    };

    const start = () => {
      if (started || cancelled) return;
      started = true;
      void evaluate();
    };

    // 等 config 就绪信号（false→true 跳变）；15s 兜底防信号失联。
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    const unsub = useAppStore.subscribe((state, prev) => {
      if (state.ui.configReady && !prev.ui.configReady) {
        unsub();
        if (fallbackTimer !== null) clearTimeout(fallbackTimer);
        start();
      }
    });
    fallbackTimer = setTimeout(() => {
      unsub();
      start();
    }, CONFIG_READY_FALLBACK_MS);
    // 挂载时已就绪（未来挂载顺序变化时）→ 直接评估。
    if (useAppStore.getState().ui.configReady) {
      start();
    }

    // ---- 会话内周期重评估（issue #12 二轮：长期挂机场景）----
    const interval = setInterval(() => {
      if (!useAppStore.getState().ui.configReady) return;
      void evaluate();
    }, RECHECK_INTERVAL_MS);

    return () => {
      cancelled = true;
      unsub();
      if (fallbackTimer !== null) clearTimeout(fallbackTimer);
      clearInterval(interval);
    };
  }, []);
}
