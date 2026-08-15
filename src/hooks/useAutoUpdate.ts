import { useEffect } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { updateTiming, shouldAutoCheck, isUpdateCheckEnabled, runCheck } from '../utils/updateService';
import type { UpdatePayload } from '../types';

/**
 * 自动更新生命周期（issue #12）
 * - App 启动后评估一次：模式 none → 跳过；否则按「周期 7 天 + snooze + 首启立即」
 *   决定是否自动检查（纯函数 shouldAutoCheck）。
 * - 自动检查成功（有无更新同）→ 记 lastCheckAt；失败静默（仅 console/debug，由
 *   diagLog 落盘）+ diagLog 路径——不打扰用户。
 * - 发现更新 → 打开 UpdateDialog（通知中心无需参与，弹窗即通知）。
 * - 仅在主窗挂载一次（App.tsx）。
 */
export function useAutoUpdate(): void {
  useEffect(() => {
    // DEV 构建短路（后端 debug 另有一层 Ok(None) 双保险）
    if (!isUpdateCheckEnabled()) return;

    let cancelled = false;

    const evaluate = async () => {
      const { config } = useAppStore.getState();
      const mode = config.updateCheckMode;
      const now = Date.now();

      if (!shouldAutoCheck(mode, now, updateTiming.getLastCheckAt(), updateTiming.getSnoozeUntil())) {
        return;
      }

      const channel = mode === 'preview' ? 'preview' : 'stable';
      const outcome = await runCheck(channel);
      if (cancelled) return;

      if (outcome.failed) {
        // 自动检查失败：静默 + 已由 runCheck console.debug（diagLog 捕获）。
        // 不重置 lastCheckAt → 下次启动重试。
        return;
      }
      // 成功（有无更新）→ 记录检查时间，进入 7 天周期
      updateTiming.markCheckedAt(now);

      if (outcome.update) {
        const payload: UpdatePayload = outcome.update;
        useAppStore.getState().setUIState({
          isUpdateOpen: true,
          updateCandidate: payload,
        });
      }
    };

    // 给 AppInit/配置加载一个窗口期（config 未就绪时 updateCheckMode 是默认值，
    // 直接读取会误判模式）——延迟 3s 再评估。
    const timer = setTimeout(evaluate, 3000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);
}