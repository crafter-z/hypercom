import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  CHECK_PERIOD_MS,
  parseStoredTs,
  runCheck,
  runAutoCheck,
  shouldAutoCheck,
  updateTiming,
  manualCheck,
  commitUpdateMode,
  getCommittedUpdateMode,
  beginUpdateInstall,
  finishUpdateInstall,
  dismissUpdate,
  isMacPlatform,
} from './updateService';
import { updateService as tauriUpdate } from '../services/tauri';
import type { UpdatePayload } from '../types';
import { useSystemStore } from '../stores/useSystemStore';
import { useAppStore } from '../stores/useAppStore';

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
  vi.stubGlobal('navigator', { platform: 'Win32' });
  useSystemStore.getState().setUIState({ isUpdateOpen: false, updateCandidate: null, isUpdateInstalling: false });
  commitUpdateMode('stable');
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
  it('snooze blocks a first check with no success ledger', () => {
    expect(shouldAutoCheck('stable', NOW, null, NOW + 7 * DAY)).toBe(false);
    expect(shouldAutoCheck('stable', NOW + 7 * DAY, null, NOW + 7 * DAY)).toBe(true);
  });


  it('snooze in the past does not block', () => {
    expect(shouldAutoCheck('stable', NOW, NOW - 30 * DAY, NOW - 1)).toBe(true);
  });

  it('clock rollback recovers the period but never overrides an explicit snooze', () => {
    expect(shouldAutoCheck('stable', NOW, NOW + 5 * DAY, null)).toBe(true);
    expect(shouldAutoCheck('stable', NOW, NOW + DAY, NOW + 2 * DAY)).toBe(false);
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

describe('runAutoCheck (issue #12 二轮：检查+记账一体)', () => {
  beforeEach(() => {
    vi.mocked(tauriUpdate.checkForUpdate).mockReset();
    localStorage.clear();
  });

  it('success (有更新) → marks lastCheckAt at completion + returns payload', async () => {
    const payload: UpdatePayload = {
      version: '0.6.0',
      currentVersion: '0.5.2',
      date: 1750000000,
      notes: 'notes',
      channel: 'stable',
    };
    vi.mocked(tauriUpdate.checkForUpdate).mockResolvedValue(payload);
    const update = await runAutoCheck(true);
    expect(update).toEqual(payload);
    expect(updateTiming.getLastCheckAt()).not.toBeNull();
  });

  it('concurrent call while check in flight → null (in-flight 锁防双弹窗)', async () => {
    let resolveCheck: (v: UpdatePayload | null) => void = () => {};
    vi.mocked(tauriUpdate.checkForUpdate).mockImplementation(
      () => new Promise((resolve) => { resolveCheck = resolve; })
    );
    const first = runAutoCheck(true);
    const second = await runAutoCheck(true);
    expect(second).toBeNull(); // re-entrant call returns null immediately
    resolveCheck(null);
    await first;
  });

  it('success (无更新) → still marks lastCheckAt', async () => {
    vi.mocked(tauriUpdate.checkForUpdate).mockResolvedValue(null);
    commitUpdateMode('preview');
    const update = await runAutoCheck(true);
    expect(update).toBeNull();
    expect(updateTiming.getLastCheckAt()).not.toBeNull();
  });

  it('failure → null without marking (下次启动重试)', async () => {
    vi.mocked(tauriUpdate.checkForUpdate).mockRejectedValue(new Error('network down'));
    const update = await runAutoCheck(true);
    expect(update).toBeNull();
    expect(updateTiming.getLastCheckAt()).toBeNull();
  });

  it('starts a newly committed channel while the old channel is pending, discarding the old completion', async () => {
    let resolveStable!: (update: UpdatePayload | null) => void;
    let resolvePreview!: (update: UpdatePayload | null) => void;
    vi.mocked(tauriUpdate.checkForUpdate).mockImplementation((channel) => new Promise((resolve) => {
      if (channel === 'stable') resolveStable = resolve;
      else resolvePreview = resolve;
    }));
    const old = runAutoCheck(true);
    commitUpdateMode('preview');
    const current = runAutoCheck(true);
    expect(tauriUpdate.checkForUpdate).toHaveBeenNthCalledWith(1, 'stable');
    expect(tauriUpdate.checkForUpdate).toHaveBeenNthCalledWith(2, 'preview');
    resolveStable({ version: 'old', currentVersion: '0.5.2', date: null, notes: null, channel: 'stable' });
    expect(await old).toBeNull();
    expect(updateTiming.getLastCheckAt()).toBeNull();
    expect(useSystemStore.getState().ui.updateCandidate).toBeNull();
    const preview: UpdatePayload = { version: 'new', currentVersion: '0.5.2', date: null, notes: null, channel: 'preview' };
    resolvePreview(preview);
    expect(await current).toEqual(preview);
    expect(useSystemStore.getState().ui.updateCandidate).toEqual(preview);
  });

  it.each(['none', 'stable'] as const)('invalidates pending completion on committing %s, even with the same channel', async (mode) => {
    let complete!: (update: UpdatePayload | null) => void;
    vi.mocked(tauriUpdate.checkForUpdate).mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const pending = runAutoCheck(true);
    commitUpdateMode(mode);
    complete({ version: 'old', currentVersion: '0.5.2', date: null, notes: null, channel: 'stable' });
    expect(await pending).toBeNull();
    expect(updateTiming.getLastCheckAt()).toBeNull();
    expect(useSystemStore.getState().ui.updateCandidate).toBeNull();
  });

  it('does not treat an unsaved settings draft as committed mode', async () => {
    useAppStore.getState().setConfig({ updateCheckMode: 'preview' });
    vi.mocked(tauriUpdate.checkForUpdate).mockResolvedValue(null);
    expect(getCommittedUpdateMode()).toBe('stable');
    await runAutoCheck(true);
    expect(tauriUpdate.checkForUpdate).toHaveBeenCalledWith('stable');
  });

  it('does not record disabled checks as successful network checks', async () => {
    await runAutoCheck(false);
    expect(updateTiming.getLastCheckAt()).toBeNull();
  });

  it('dismissal invalidates a pending completion without recording it', async () => {
    let complete!: (update: UpdatePayload | null) => void;
    vi.mocked(tauriUpdate.checkForUpdate).mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const pending = runAutoCheck(true);
    dismissUpdate();
    complete({ version: 'old', currentVersion: '0.5.2', date: null, notes: null, channel: 'stable' });
    expect(await pending).toBeNull();
    expect(updateTiming.getLastCheckAt()).toBeNull();
    expect(updateTiming.getSnoozeUntil()).not.toBeNull();
  });

  it('freezes candidate and rejects auto/manual completions even after installation failure recovery', async () => {
    const shown: UpdatePayload = { version: 'shown', currentVersion: '0.5.2', date: null, notes: 'original', channel: 'stable' };
    useSystemStore.getState().setUIState({ isUpdateOpen: true, updateCandidate: shown });
    const completions: Array<(value: UpdatePayload | null) => void> = [];
    vi.mocked(tauriUpdate.checkForUpdate).mockImplementation(() => new Promise((resolve) => { completions.push(resolve); }));
    const auto = runAutoCheck(true);
    const manual = manualCheck('preview');
    expect(beginUpdateInstall()).toEqual(shown);
    expect(beginUpdateInstall()).toBeNull();
    commitUpdateMode('none', true);
    dismissUpdate();
    expect(useSystemStore.getState().ui.updateCandidate).toEqual(shown);
    expect(useSystemStore.getState().ui.isUpdateOpen).toBe(true);
    expect(useSystemStore.getState().ui.isUpdateInstalling).toBe(true);
    expect(updateTiming.getSnoozeUntil()).toBeNull();
    finishUpdateInstall();
    completions.forEach((resolve) => resolve({ ...shown, version: 'replacement', channel: 'preview' }));
    expect(await auto).toBeNull();
    expect((await manual).discarded).toBe(true);
    expect(useSystemStore.getState().ui.updateCandidate).toEqual(shown);
    expect(updateTiming.getLastCheckAt()).toBeNull();
    expect(beginUpdateInstall()).toEqual(shown);
    finishUpdateInstall();
  });

  it('loading a persisted channel preserves an existing snooze across sessions', () => {
    updateTiming.setSnooze(7, NOW);
    updateTiming.markCheckedAt(NOW);
    commitUpdateMode('preview');
    expect(updateTiming.getSnoozeUntil()).toBe(NOW + 7 * DAY);
    expect(updateTiming.getLastCheckAt()).toBe(NOW);
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
    commitUpdateMode('none');
    updateTiming.markCheckedAt(NOW);
    updateTiming.setSnooze(7, NOW);
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

  it('keeps a manual preview result when an older automatic stable check completes later', async () => {
    let resolveStable!: (value: UpdatePayload | null) => void;
    let resolvePreview!: (value: UpdatePayload | null) => void;
    vi.mocked(tauriUpdate.checkForUpdate).mockImplementation((channel) => new Promise((resolve) => {
      if (channel === 'stable') resolveStable = resolve;
      else resolvePreview = resolve;
    }));
    const automatic = runAutoCheck(true);
    const manual = manualCheck('preview');
    const preview: UpdatePayload = { version: '0.7.0-preview.1', currentVersion: '0.6.8', date: null, notes: 'manual preview', channel: 'preview' };
    resolvePreview(preview);
    expect((await manual).update).toEqual(preview);
    resolveStable({ ...preview, version: '0.6.9', channel: 'stable' });
    expect(await automatic).toBeNull();
    expect(useSystemStore.getState().ui.updateCandidate).toEqual(preview);
    expect(updateTiming.getLastCheckAt()).toBeNull();
  });

  it('does not invoke the unsupported macOS updater even for manual intent', async () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' });
    expect((await manualCheck('stable')).discarded).toBe(true);
    expect(tauriUpdate.checkForUpdate).not.toHaveBeenCalled();
  });
});

describe('isMacPlatform (issue #12 已知边界落地：macOS 暂不支持自动更新)', () => {
  it('detects mac from platform string (纯函数注入，不依赖运行环境)', () => {
    // 注意：Node 21+ 存在全局 navigator（platform 反映宿主 OS），CI macOS
    // runner 上默认读取即命中 MacIntel——测试必须显式传参才能跨平台稳定。
    // **禁止无参断言**：默认读取宿主平台，跨平台结果不同（macOS runner
    // 上为 true、Windows/Linux 为 false），本地验证无法发现。
    expect(isMacPlatform('MacIntel')).toBe(true);
    expect(isMacPlatform('MacPPC')).toBe(true);
    expect(isMacPlatform('Win32')).toBe(false);
    expect(isMacPlatform('Linux x86_64')).toBe(false);
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

  it('clearLastCheck removes the check timestamp (issue #12 复审：改通道立即生效)', () => {
    updateTiming.markCheckedAt(NOW);
    expect(updateTiming.getLastCheckAt()).toBe(NOW);
    updateTiming.clearLastCheck();
    expect(updateTiming.getLastCheckAt()).toBeNull();
    // 清账后回到「从未检查过」语义 → shouldAutoCheck 立即放行
    expect(shouldAutoCheck('preview', NOW, updateTiming.getLastCheckAt(), null)).toBe(true);
  });
});