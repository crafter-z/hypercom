/**
 * 自动更新服务（issue #12）
 *
 * 职责：
 * - 调用后端 `check_for_update` / `download_and_install_update`（经 updateService tauri 包装）
 * - 自动检查的周期（7 天）与 snooze 记账（localStorage，per-install）
 * - DEV 短路：`import.meta.env.DEV` 下一切检查返回 null（对齐 SIM 门控纪律）
 * - 手动检查 bypass 周期/snooze
 *
 * 纯逻辑（`shouldAutoCheck` / `parseStoredTs`）独立导出便于单测。
 */
import type { UpdateCheckMode, UpdatePayload } from '../types';
import { updateService as tauriUpdate } from '../services/tauri';

/** 自动检查周期：统一 7 天（用户决策，2026-08-15）。 */
export const CHECK_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

/** localStorage 记账 key（per-install，不随 config 导出）。 */
const LS_LAST_CHECK = 'hypercom.update.lastCheckAt';
const LS_SNOOZE = 'hypercom.update.snoozeUntil';

export interface CheckOutcome {
  /** 是否有可用更新（有 → 弹窗数据；无 → null） */
  update: UpdatePayload | null;
  /** 检查是否失败（网络/API 异常；失败不重置 lastCheckAt） */
  failed: boolean;
}

/**
 * 纯函数：此刻是否应触发自动检查。
 * - `mode === 'none'` → 永远 false
 * - 从未成功检查过（lastCheckAt === null）→ true（首次启动立即检查，用户决策）
 * - snooze 未到期 → false（「7 天后提醒」期间暂停，含周期已到情形）
 * - 距上次成功检查 ≥ 7 天 → true
 */
export function shouldAutoCheck(
  mode: UpdateCheckMode,
  now: number,
  lastCheckAt: number | null,
  snoozeUntil: number | null,
): boolean {
  if (mode === 'none') return false;
  if (lastCheckAt === null) return true;
  if (snoozeUntil !== null && now < snoozeUntil) return false;
  return now - lastCheckAt >= CHECK_PERIOD_MS;
}

/** 解析 localStorage 数值（非法/缺失 → null）。 */
export function parseStoredTs(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ==================== localStorage 记账 ====================

export const updateTiming = {
  getLastCheckAt(): number | null {
    return parseStoredTs(localStorage.getItem(LS_LAST_CHECK));
  },
  getSnoozeUntil(): number | null {
    return parseStoredTs(localStorage.getItem(LS_SNOOZE));
  },
  /** 成功完成一次自动检查后标记（无论有无更新） */
  markCheckedAt(now: number = Date.now()): void {
    localStorage.setItem(LS_LAST_CHECK, String(now));
  },
  /**
   * 清除检查时间记账（issue #12 复审：设置里改通道时与 clearSnooze 一并调用）。
   * lastCheckAt 不分通道——切通道后旧通道的 7 天周期会推迟新通道首检，
   * 清掉使新意图立即生效（首启语义：lastCheckAt=null → 立即检查）。
   */
  clearLastCheck(): void {
    localStorage.removeItem(LS_LAST_CHECK);
  },
  /** 「7 天后再次提醒」 */
  setSnooze(days: number = 7, now: number = Date.now()): void {
    localStorage.setItem(LS_SNOOZE, String(now + days * 24 * 60 * 60 * 1000));
  },
  /** 清除 snooze（设置变更/主动更新后） */
  clearSnooze(): void {
    localStorage.removeItem(LS_SNOOZE);
  },
};

/** DEV 构建不检查（debug 走后端 Ok(None) 双保险）。 */
export function isUpdateCheckEnabled(): boolean {
  return !import.meta.env.DEV;
}

/**
 * 执行一次通道检查（自动与手动共用）。
 * 返回 outcome；失败时 `failed=true`（调用方决定提示层级：自动静默 / 手动 toast）。
 * 自动调用的调用方负责在成功后修 lastCheckAt、在「7 天后」/「永不」动作后记账。
 *
 * @param enabledOverride 仅测试用：绕过 DEV 门控注入「可用」状态（vitest 中
 *   import.meta.env.DEV 被静态替换为 true，无法 stubEnv）。生产调用不传。
 */
export async function runCheck(
  channel: 'stable' | 'preview',
  enabledOverride?: boolean,
): Promise<CheckOutcome> {
  const enabled = enabledOverride ?? isUpdateCheckEnabled();
  if (!enabled) {
    return { update: null, failed: false };
  }
  try {
    const update = await tauriUpdate.checkForUpdate(channel);
    return { update, failed: false };
  } catch (e) {
    console.debug('[update] check failed:', e);
    return { update: null, failed: true };
  }
}

/**
 * 手动检查（About 对话框）：bypass 周期/snooze，且**不过 DEV 门控**——
 * 手动检查是显式用户意图（点「检查更新」即触发），后端 debug 构建另有
 * `#[cfg(debug_assertions)]` 返回 Ok(None) 的双保险（开发时点按钮显示"已是最新"，
 * 不触网）。这样 E2E 也能在 dev server 上 mock `check_for_update` 驱动弹窗。
 */
export async function manualCheck(channel: 'stable' | 'preview'): Promise<CheckOutcome> {
  try {
    const update = await tauriUpdate.checkForUpdate(channel);
    return { update, failed: false };
  } catch (e) {
    console.debug('[update] manual check failed:', e);
    return { update: null, failed: true };
  }
}