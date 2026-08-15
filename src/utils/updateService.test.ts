import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  CHECK_PERIOD_MS,
  parseStoredTs,
  runCheck,
  shouldAutoCheck,
  updateTiming,
  manualCheck,
} from './updateService';
import { updateService as tauriUpdate } from '../services/tauri';
import type { UpdatePayload } from '../types';

// mock services/tauri 模块：runCheck 只依赖 updateService（tauri 包装）。
// DEV 门控经 runCheck 的 enabledOverride 参数控制（vitest 中 import.meta.env.DEV
// 被 vite 静态替换为 true，无法 stubEnv）。
vi.mock('../services/tauri', () => ({
  updateService: {
    checkForUpdate: vi.fn(),
    downloadAndInstall: vi.fn(),
    onProgress: vi.fn(() => () => {}),
  },
}));

// vitest 默认 environment=node：无 localStorage——提供最小 polyfill（仅记账测试用）
const storage = new Map<string, string>();
beforeEach(() => {
  storage.clear();
});
vi.stubGlobal('localStorage', {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, String(v)),
  removeItem: (k: string) => void storage.delete(k),
  clear: () => storage.clear(),
});

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_750_000_000_000;

describe('shouldAutoCheck (issue #12, 7 天周期)', () => {
  it('mode none never checks', () => {
    expect(shouldAutoCheck('none', NOW, null, null)).toBe(false);
    expect(shouldAutoCheck('none', NOW, NOW - 30 * DAY, null)).toBe(false);
  });

  it('never checked → immediate check (首次启动立即检查)', () => {
    expect(shouldAutoCheck('stable', NOW, null, null)).toBe(true);
    expect(shouldAutoCheck('preview', NOW, null, null)).toBe(true);
  });

  it('within 7 days → no check', () => {
    expect(shouldAutoCheck('stable', NOW, NOW - 6 * DAY, null)).toBe(false);
    expect(shouldAutoCheck('stable', NOW, NOW - (7 * DAY - 1), null)).toBe(false);
  });

  it('exactly/past 7 days → check', () => {
    expect(shouldAutoCheck('stable', NOW, NOW - 7 * DAY, null)).toBe(true);
    expect(shouldAutoCheck('stable', NOW, NOW - 30 * DAY, null)).toBe(true);
  });

  it('snooze blocks even when period passed (7天后提醒)', () => {
    const snooze = NOW + 7 * DAY;
    expect(shouldAutoCheck('stable', NOW, NOW - 30 * DAY, snooze)).toBe(false);
    // snooze 到期后恢复检查
    expect(shouldAutoCheck('stable', NOW + 8 * DAY, NOW - 30 * DAY, snooze)).toBe(true);
  });

  it('snooze in the past does not block', () => {
    expect(shouldAutoCheck('stable', NOW, NOW - 30 * DAY, NOW - 1)).toBe(true);
  });
});

describe('parseStoredTs', () => {
  it('parses valid epoch ms', () => {
    expect(parseStoredTs('1750000000000')).toBe(1750000000000);
    expect(parseStoredTs('0')).toBe(null);
    expect(parseStoredTs('-5')).toBe(null);
    expect(parseStoredTs('abc')).toBe(null);
    expect(parseStoredTs(null)).toBe(null);
  });
});

describe('CHECK_PERIOD_MS', () => {
  it('is exactly 7 days', () => {
    expect(CHECK_PERIOD_MS).toBe(7 * DAY);
  });
});

describe('runCheck (issue #12 三分支)', () => {
  beforeEach(() => {
    vi.mocked(tauriUpdate.checkForUpdate).mockReset();
  });

  it('has update → returns payload with failed=false', async () => {
    const payload: UpdatePayload = {
      version: '0.6.0',
      currentVersion: '0.5.2',
      date: 1750000000,
      notes: 'release notes',
      channel: 'stable',
    };
    vi.mocked(tauriUpdate.checkForUpdate).mockResolvedValue(payload);
    const outcome = await runCheck('stable', true);
    expect(outcome.failed).toBe(false);
    expect(outcome.update).toEqual(payload);
    expect(tauriUpdate.checkForUpdate).toHaveBeenCalledWith('stable');
  });

  it('no update → returns null with failed=false', async () => {
    vi.mocked(tauriUpdate.checkForUpdate).mockResolvedValue(null);
    const outcome = await runCheck('preview', true);
    expect(outcome.failed).toBe(false);
    expect(outcome.update).toBeNull();
  });

  it('invoke rejects → returns failed=true, update=null (网络失败静默)', async () => {
    vi.mocked(tauriUpdate.checkForUpdate).mockRejectedValue(new Error('network down'));
    const outcome = await runCheck('stable', true);
    expect(outcome.failed).toBe(true);
    expect(outcome.update).toBeNull();
  });

  it('passes preview channel through', async () => {
    vi.mocked(tauriUpdate.checkForUpdate).mockResolvedValue(null);
    await runCheck('preview', true);
    expect(tauriUpdate.checkForUpdate).toHaveBeenCalledWith('preview');
  });

  it('short-circuits when update check disabled (DEV 构建不触网)', async () => {
    const outcome = await runCheck('stable', false);
    expect(outcome).toEqual({ update: null, failed: false });
    expect(tauriUpdate.checkForUpdate).not.toHaveBeenCalled();
  });

  it('omitted override → enabled state from import.meta.env (vitest DEV=true → 短路)', async () => {
    const outcome = await runCheck('stable');
    expect(outcome.failed).toBe(false);
    expect(outcome.update).toBeNull();
    expect(tauriUpdate.checkForUpdate).not.toHaveBeenCalled();
  });
});

describe('manualCheck (issue #12: 显式意图，不过 DEV 门控)', () => {
  beforeEach(() => {
    vi.mocked(tauriUpdate.checkForUpdate).mockReset();
  });

  it('calls backend even in DEV (manual = explicit intent; backend debug 另有 Ok(None) 兜底)', async () => {
    const payload = {
      version: '0.6.0',
      currentVersion: '0.5.2',
      date: 1750000000,
      notes: 'notes',
      channel: 'preview' as const,
    };
    vi.mocked(tauriUpdate.checkForUpdate).mockResolvedValue(payload);
    const outcome = await manualCheck('preview');
    expect(outcome.failed).toBe(false);
    expect(outcome.update).toEqual(payload);
    expect(tauriUpdate.checkForUpdate).toHaveBeenCalledWith('preview');
  });

  it('backend rejects → failed=true (手动失败需通知用户)', async () => {
    vi.mocked(tauriUpdate.checkForUpdate).mockRejectedValue(new Error('network down'));
    const outcome = await manualCheck('stable');
    expect(outcome.failed).toBe(true);
    expect(outcome.update).toBeNull();
  });
});

describe('updateTiming (localStorage 记账)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('markCheckedAt then getLastCheckAt roundtrip', () => {
    expect(updateTiming.getLastCheckAt()).toBeNull();
    updateTiming.markCheckedAt(NOW);
    expect(updateTiming.getLastCheckAt()).toBe(NOW);
  });

  it('setSnooze stores now + 7d; clearSnooze removes', () => {
    updateTiming.setSnooze(7, NOW);
    expect(updateTiming.getSnoozeUntil()).toBe(NOW + 7 * DAY);
    updateTiming.clearSnooze();
    expect(updateTiming.getSnoozeUntil()).toBeNull();
  });
});