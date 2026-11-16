/**
 * 插件市场更新检查服务
 *
 * 职责：
 * - 软件更新检查（自动/手动）联动触发插件市场更新检查：
 *   只对「已安装插件」的可用更新即时推送通知（通知中心可点击打开插件设置页）。
 * - 自动检查周期同为 7 天；localStorage 记账（per-install，不随 config 导出）。
 * - 已提交市场源（committed source）与设置草稿隔离：后台检查永远使用已提交
 *   到磁盘的市场源，避免未保存的草稿改变后台行为。
 * - 失败静默（console.debug），不向用户抛错误——插件更新是辅助能力。
 * - 同一批 `id@latestVersion` 指纹去重：同一批更新只通知一次；批次变化
 *   （插件升级/上新）才重新通知；无更新时清除指纹。
 *
 * DEV 只门控「自动」检查（手动检查是显式用户意图）；不按平台排除，macOS
 * 同样可以检查插件市场。
 */
import i18n from '../i18n';
import { pluginService } from '../services/plugin';
import { useAppStore } from '../stores/useAppStore';
import { useToastStore } from '../stores/useToastStore';
import type { MarketplaceUpdate, UpdateCheckMode } from '../types';
import { getCommittedUpdateMode, parseStoredTs } from './updateService';

/** 自动检查周期：与软件更新一致，均为 7 天。 */
export const PLUGIN_UPDATE_CHECK_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

/** localStorage 记账 key（per-install；notified 存批次指纹字符串）。 */
export const PLUGIN_UPDATE_LAST_CHECK_KEY = 'hypercom.pluginUpdate.lastCheckAt';
export const PLUGIN_UPDATE_NOTIFIED_KEY = 'hypercom.pluginUpdate.notified';

function readStorage(key: string): string | null {
  return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
}

function writeStorage(key: string, value: string): void {
  if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
}

function removeStorage(key: string): void {
  if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
}

/** 插件更新检查记账（typeof localStorage 守卫；缺失存储 = 无持久账本，不抛错）。 */
export const pluginUpdateTiming = {
  getLastCheckAt(): number | null {
    return parseStoredTs(readStorage(PLUGIN_UPDATE_LAST_CHECK_KEY));
  },
  /** 成功完成一次自动检查后标记（无论有无更新）。手动检查不记账。 */
  markCheckedAt(now: number = Date.now()): void {
    writeStorage(PLUGIN_UPDATE_LAST_CHECK_KEY, String(now));
  },
  clearLastCheck(): void {
    removeStorage(PLUGIN_UPDATE_LAST_CHECK_KEY);
  },
  /** 最近一次已通知批次的 `id@latestVersion` 指纹。 */
  getNotified(): string | null {
    const raw = readStorage(PLUGIN_UPDATE_NOTIFIED_KEY);
    return raw !== null && raw.trim() !== '' ? raw : null;
  },
  setNotified(fingerprint: string): void {
    writeStorage(PLUGIN_UPDATE_NOTIFIED_KEY, fingerprint);
  },
  clearNotified(): void {
    removeStorage(PLUGIN_UPDATE_NOTIFIED_KEY);
  },
};

/** 自动插件检查只在正式构建启用（DEV 下不触网）；不排除 macOS 平台。 */
export function isPluginUpdateCheckEnabled(): boolean {
  return !import.meta.env.DEV;
}

/**
 * 纯函数：此刻是否应触发插件更新自动检查。
 * - `mode === 'none'` → 永远 false
 * - 从未检查过（lastCheckAt === null）或时钟回拨 → true（首启立即检查）
 * - 距上次成功检查 ≥ 7 天 → true
 *
 * 注意没有 snooze 语义：snooze 是软件更新弹窗的「7 天后提醒」，
 * 插件通知走通知中心，不参与该记账。
 */
export function shouldCheckPluginUpdates(
  mode: UpdateCheckMode,
  now: number,
  lastCheckAt: number | null,
): boolean {
  if (mode === 'none') return false;
  if (lastCheckAt === null || now < lastCheckAt) return true;
  return now - lastCheckAt >= PLUGIN_UPDATE_CHECK_PERIOD_MS;
}

/**
 * 只保留「已安装插件」的可用更新。
 * 未安装的插件（currentVersion 为空/缺失）不是更新，也不应打扰用户。
 */
export function availablePluginUpdates(updates: readonly MarketplaceUpdate[]): MarketplaceUpdate[] {
  return updates.filter((update) => update.updateAvailable === true
    && typeof update.currentVersion === 'string'
    && update.currentVersion.trim() !== '');
}

/** 排序后去重的 `id@latestVersion` 拼串，用于同批次通知去重。 */
export function pluginUpdateFingerprint(updates: readonly MarketplaceUpdate[]): string {
  return [...new Set(updates.map((update) => `${update.id}@${update.latestVersion}`))].sort().join(',');
}

function pluginNames(updates: readonly MarketplaceUpdate[]): string[] {
  return updates.map((update) => update.manifest?.name?.trim() || update.id);
}

function joinNames(names: readonly string[]): string {
  const separator = i18n.language?.toLowerCase().startsWith('zh') ? '、' : ', ';
  return names.join(separator);
}

/** 通知正文：≤3 个列出全部名字；>3 个只列前 3 个 + “等”。 */
export function pluginUpdateMessage(updates: readonly MarketplaceUpdate[]): string {
  const names = pluginNames(updates);
  const many = names.length > 3;
  const visible = many ? names.slice(0, 3) : names;
  return i18n.t(many ? 'update.pluginUpdatesAvailableMore' : 'update.pluginUpdatesAvailable', {
    count: names.length,
    names: joinNames(visible),
  });
}

export interface PluginUpdateCheckOutcome {
  /** 没有可检查的市场源（或自动检查门控不通过）→ 未发起后端请求。 */
  skipped: boolean;
  /** 网络/后端失败；失败静默且不计入 lastCheckAt。 */
  failed: boolean;
  /** 过滤后的「已安装插件可用更新」列表。 */
  updates: MarketplaceUpdate[];
  /** 本次是否新推送了通知（同批次去重命中时为 false）。 */
  notified: boolean;
}

const skippedOutcome = (): PluginUpdateCheckOutcome => ({
  skipped: true,
  failed: false,
  updates: [],
  notified: false,
});

/**
 * 执行一次插件市场更新检查（自动/手动共用）。
 *
 * @param sourceUrl 显式市场源；缺省用已提交市场源（不是设置草稿）。
 * @param notify 默认 true：发现已安装插件更新时推送粘性通知；空批次清指纹。
 * @returns 永不 reject；失败时 `failed=true`。
 */
export async function runPluginUpdateCheck(
  options: { sourceUrl?: string; notify?: boolean } = {},
): Promise<PluginUpdateCheckOutcome> {
  const source = (options.sourceUrl ?? getCommittedPluginMarketplaceUrl()).trim();
  const notify = options.notify ?? true;
  if (!source) return skippedOutcome();
  try {
    const result = await pluginService.checkPluginUpdates(source);
    const updates = availablePluginUpdates(result);
    let notified = false;
    if (notify) {
      if (updates.length === 0) {
        // 没有已安装插件的更新：清掉旧批次指纹，后续再有更新时重新通知。
        pluginUpdateTiming.clearNotified();
      } else {
        const fingerprint = pluginUpdateFingerprint(updates);
        if (fingerprint !== pluginUpdateTiming.getNotified()) {
          useToastStore.getState().push({
            severity: 'info',
            title: i18n.t('update.pluginUpdatesTitle'),
            message: pluginUpdateMessage(updates),
            // 粘性通知：直到用户手动关闭/清空，避免一闪而过错过更新。
            durationMs: 0,
            action: 'open-plugin-settings',
          });
          pluginUpdateTiming.setNotified(fingerprint);
          notified = true;
        }
      }
    }
    return { skipped: false, failed: false, updates, notified };
  } catch (error) {
    console.debug('[pluginUpdate] check failed:', error);
    return { skipped: false, failed: true, updates: [], notified: false };
  }
}

let autoCheckInFlight = false;

/**
 * 自动检查：受 DEV 门控、已提交更新模式与 7 天周期约束；成功才记 lastCheckAt。
 * 同一时刻最多一个自动检查在途（与软件更新 autoFlights 同一纪律），避免
 * 慢网络下 6h 重评估/模式保存与首检叠加出重复请求和重复通知。
 * @param enabledOverride 仅测试用：绕过 DEV 静态替换。
 */
export async function runPluginAutoCheck(enabledOverride?: boolean): Promise<PluginUpdateCheckOutcome> {
  const enabled = enabledOverride ?? isPluginUpdateCheckEnabled();
  if (!enabled || autoCheckInFlight) return skippedOutcome();
  if (!shouldCheckPluginUpdates(getCommittedUpdateMode(), Date.now(), pluginUpdateTiming.getLastCheckAt())) {
    return skippedOutcome();
  }
  autoCheckInFlight = true;
  try {
    const outcome = await runPluginUpdateCheck();
    if (!outcome.skipped && !outcome.failed) pluginUpdateTiming.markCheckedAt();
    return outcome;
  } finally {
    autoCheckInFlight = false;
  }
}

/**
 * 手动检查：显式用户意图，绕过 DEV/模式/周期，但仍要求非空市场源；
 * 不记 lastCheckAt（不改变自动检查周期）。
 */
export function runPluginManualCheck(): Promise<PluginUpdateCheckOutcome> {
  return runPluginUpdateCheck();
}

// Committed marketplace source is deliberately independent of the settings
// store's draft: background checks must never observe an unsaved URL edit.
let committedMarketplaceUrl: string | null = null;

/** 已提交市场源；尚未初始化（config 加载前）时回退当前 store 值。 */
export function getCommittedPluginMarketplaceUrl(): string {
  const url = committedMarketplaceUrl ?? useAppStore.getState().config.pluginMarketplaceUrl;
  return (url ?? '').trim();
}

/** 已提交源是否已初始化（区分「未初始化回退草稿」与真实的已提交值）。 */
export function isPluginMarketplaceUrlCommitted(): boolean {
  return committedMarketplaceUrl !== null;
}

/**
 * 提交市场源。`resetTiming` 时清空 7 天记账与通知指纹——新源需要立即
 * 重新检查，且旧源已通知的批次不再适用。
 */
export function commitPluginMarketplaceUrl(
  url: string,
  options: { resetTiming?: boolean } = {},
): void {
  committedMarketplaceUrl = url.trim();
  if (options.resetTiming) resetPluginUpdateTracking();
}

/** 清空插件更新检查记账与已通知指纹（更新模式变化、市场源切换时调用）。 */
export function resetPluginUpdateTracking(): void {
  pluginUpdateTiming.clearLastCheck();
  pluginUpdateTiming.clearNotified();
}

/** 测试重置：已提交源回到未初始化 + 清账本 + 释放 in-flight 锁。 */
export function resetPluginUpdateServiceForTests(): void {
  committedMarketplaceUrl = null;
  autoCheckInFlight = false;
  resetPluginUpdateTracking();
}
