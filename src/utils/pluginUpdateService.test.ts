import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarketplaceUpdate } from '../types';
import { pluginService } from '../services/plugin';
import i18n from '../i18n';
import { useToastStore } from '../stores/useToastStore';
import { useAppStore } from '../stores/useAppStore';
import { commitUpdateMode } from './updateService';
import {
  PLUGIN_UPDATE_CHECK_PERIOD_MS,
  availablePluginUpdates,
  commitPluginMarketplaceUrl,
  getCommittedPluginMarketplaceUrl,
  isPluginMarketplaceUrlCommitted,
  isPluginUpdateCheckEnabled,
  pluginUpdateFingerprint,
  pluginUpdateMessage,
  pluginUpdateTiming,
  resetPluginUpdateServiceForTests,
  resetPluginUpdateTracking,
  runPluginAutoCheck,
  runPluginManualCheck,
  runPluginUpdateCheck,
  shouldCheckPluginUpdates,
} from './pluginUpdateService';

vi.mock('../services/plugin', () => ({
  pluginService: { checkPluginUpdates: vi.fn() },
}));

// vitest 默认 environment=node：无 localStorage——提供最小 polyfill（记账测试用）。
const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, String(value)),
  removeItem: (key: string) => void storage.delete(key),
  clear: () => storage.clear(),
});

// i18n init 是异步的；通知文案测试必须等资源包落地（否则 t() 回显原始 key）。
const i18nReady = new Promise<void>((resolve) => {
  if (i18n.isInitialized) resolve();
  else i18n.on('initialized', () => resolve());
});

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_750_000_000_000;
const SOURCE = 'https://market.example/index.json';

function update(overrides: Partial<MarketplaceUpdate> = {}): MarketplaceUpdate {
  return {
    id: 'plugin.alpha',
    currentVersion: '1.0.0',
    latestVersion: '1.1.0',
    updateAvailable: true,
    descriptionUrl: 'https://market.example/alpha.json',
    downloadUrl: 'https://market.example/alpha.zip',
    manifest: {
      id: 'plugin.alpha',
      name: 'Alpha Plugin',
      version: '1.1.0',
      description: '',
      apiVersion: '1',
      permissions: [],
    },
    ...overrides,
  };
}

function named(id: string, name: string): MarketplaceUpdate {
  return update({ id, manifest: { ...update().manifest, id, name } });
}

function toastList() {
  return [...useToastStore.getState().stashed, ...useToastStore.getState().toasts];
}

beforeEach(async () => {
  await i18nReady;
  await i18n.changeLanguage('zh-CN');
  vi.mocked(pluginService.checkPluginUpdates).mockReset();
  useToastStore.setState({ toasts: [], stashed: [], centerOpen: false });
  useAppStore.getState().setConfig({ pluginMarketplaceUrl: SOURCE });
  commitUpdateMode('stable');
  storage.clear();
  resetPluginUpdateServiceForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('shouldCheckPluginUpdates (7 天周期)', () => {
  it('mode none never checks', () => {
    expect(shouldCheckPluginUpdates('none', NOW, null)).toBe(false);
    expect(shouldCheckPluginUpdates('none', NOW, NOW - 30 * DAY)).toBe(false);
  });

  it('never checked → immediate check (首启立即检查)', () => {
    expect(shouldCheckPluginUpdates('stable', NOW, null)).toBe(true);
    expect(shouldCheckPluginUpdates('preview', NOW, null)).toBe(true);
  });

  it('within 7 days → no check; exactly/past 7 days → check', () => {
    expect(shouldCheckPluginUpdates('stable', NOW, NOW - 6 * DAY)).toBe(false);
    expect(shouldCheckPluginUpdates('stable', NOW, NOW - (7 * DAY - 1))).toBe(false);
    expect(shouldCheckPluginUpdates('stable', NOW, NOW - 7 * DAY)).toBe(true);
    expect(shouldCheckPluginUpdates('preview', NOW, NOW - 30 * DAY)).toBe(true);
  });

  it('clock rollback triggers a check instead of waiting forever', () => {
    expect(shouldCheckPluginUpdates('stable', NOW, NOW + 5 * DAY)).toBe(true);
  });

  it('period constant is exactly 7 days', () => {
    expect(PLUGIN_UPDATE_CHECK_PERIOD_MS).toBe(7 * DAY);
  });
});

describe('isPluginUpdateCheckEnabled (只门控自动检查)', () => {
  it('is disabled in a DEV build regardless of platform', () => {
    // vitest 中 import.meta.env.DEV 被静态替换为 true；手动检查另行绕过。
    expect(isPluginUpdateCheckEnabled()).toBe(false);
  });
});

describe('availablePluginUpdates (只通知已安装插件)', () => {
  it('keeps only updateAvailable entries with a current version', () => {
    const installed = update();
    const currentNull = update({ id: 'plugin.null', currentVersion: null });
    const currentEmpty = update({ id: 'plugin.empty', currentVersion: '  ' });
    const noUpdate = update({ id: 'plugin.current', updateAvailable: false });
    expect(availablePluginUpdates([installed, currentNull, currentEmpty, noUpdate]).map((u) => u.id))
      .toEqual(['plugin.alpha']);
  });
});

describe('pluginUpdateFingerprint', () => {
  it('sorts id@latestVersion pairs so entry order does not matter', () => {
    const a = update({ id: 'plugin.a', latestVersion: '1.1.0' });
    const b = update({ id: 'plugin.b', latestVersion: '2.0.0' });
    expect(pluginUpdateFingerprint([b, a])).toBe('plugin.a@1.1.0,plugin.b@2.0.0');
    expect(pluginUpdateFingerprint([a, b])).toBe(pluginUpdateFingerprint([b, a]));
  });

  it('deduplicates repeated id@latestVersion pairs', () => {
    const a = update({ id: 'plugin.a', latestVersion: '1.1.0' });
    expect(pluginUpdateFingerprint([a, a])).toBe('plugin.a@1.1.0');
  });
});

describe('runPluginUpdateCheck', () => {
  it('empty source → skipped without invoking the backend', async () => {
    commitPluginMarketplaceUrl('   ');
    const outcome = await runPluginUpdateCheck();
    expect(outcome).toMatchObject({ skipped: true, failed: false, updates: [], notified: false });
    expect(pluginService.checkPluginUpdates).not.toHaveBeenCalled();
  });

  it('notifies once per id@latestVersion batch and writes the fingerprint', async () => {
    vi.mocked(pluginService.checkPluginUpdates).mockResolvedValue([
      update(),
      update({ id: 'plugin.beta', manifest: { ...update().manifest, id: 'plugin.beta', name: 'Beta Plugin' } }),
    ]);
    const outcome = await runPluginUpdateCheck({ sourceUrl: SOURCE });
    expect(outcome.failed).toBe(false);
    expect(outcome.notified).toBe(true);
    expect(outcome.updates).toHaveLength(2);
    expect(pluginService.checkPluginUpdates).toHaveBeenCalledExactlyOnceWith(SOURCE);

    const toasts = toastList();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({
      severity: 'info',
      durationMs: 0,
      action: 'open-plugin-settings',
      title: i18n.t('update.pluginUpdatesTitle'),
    });
    expect(toasts[0].message).toContain('Alpha Plugin');
    expect(toasts[0].message).toContain('Beta Plugin');
    const fingerprint = pluginUpdateFingerprint(outcome.updates);
    expect(pluginUpdateTiming.getNotified()).toBe(fingerprint);
    expect(localStorage.getItem('hypercom.pluginUpdate.notified')).toBe(fingerprint);

    // Same batch again → no duplicate notification.
    const again = await runPluginUpdateCheck({ sourceUrl: SOURCE });
    expect(again.notified).toBe(false);
    expect(toastList()).toHaveLength(1);
  });

  it('re-notifies after the batch changes (a plugin update landed)', async () => {
    vi.mocked(pluginService.checkPluginUpdates).mockResolvedValueOnce([update()]);
    await runPluginUpdateCheck({ sourceUrl: SOURCE });
    expect(toastList()).toHaveLength(1);

    vi.mocked(pluginService.checkPluginUpdates).mockResolvedValueOnce([
      update({ latestVersion: '1.2.0' }),
    ]);
    const changed = await runPluginUpdateCheck({ sourceUrl: SOURCE });
    expect(changed.notified).toBe(true);
    expect(toastList()).toHaveLength(2);
    expect(pluginUpdateTiming.getNotified()).toBe('plugin.alpha@1.2.0');
  });

  it('clears the fingerprint when no installed plugin has an update', async () => {
    pluginUpdateTiming.setNotified('plugin.alpha@1.1.0');
    vi.mocked(pluginService.checkPluginUpdates).mockResolvedValue([]);
    const outcome = await runPluginUpdateCheck({ sourceUrl: SOURCE });
    expect(outcome).toMatchObject({ skipped: false, failed: false, notified: false });
    expect(pluginUpdateTiming.getNotified()).toBeNull();
    expect(toastList()).toHaveLength(0);
  });

  it('only notifies installed plugins and ignores marketplace-only entries', async () => {
    vi.mocked(pluginService.checkPluginUpdates).mockResolvedValue([
      update(),
      update({ id: 'plugin.not-installed', currentVersion: null, manifest: { ...update().manifest, id: 'plugin.not-installed', name: 'Not Installed' } }),
      update({ id: 'plugin.up-to-date', updateAvailable: false, manifest: { ...update().manifest, id: 'plugin.up-to-date', name: 'Up To Date' } }),
    ]);
    const outcome = await runPluginUpdateCheck({ sourceUrl: SOURCE });
    expect(outcome.updates.map((u) => u.id)).toEqual(['plugin.alpha']);
    const toasts = toastList();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toContain('Alpha Plugin');
    expect(toasts[0].message).not.toContain('Not Installed');
    expect(toasts[0].message).not.toContain('Up To Date');
  });

  it('notify:false suppresses the toast but still returns the available updates', async () => {
    vi.mocked(pluginService.checkPluginUpdates).mockResolvedValue([update()]);
    const outcome = await runPluginUpdateCheck({ sourceUrl: SOURCE, notify: false });
    expect(outcome.updates).toHaveLength(1);
    expect(outcome.notified).toBe(false);
    expect(toastList()).toHaveLength(0);
    expect(pluginUpdateTiming.getNotified()).toBeNull();
  });

  it('backend failure is silent: failed outcome, no toast, no throw', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.mocked(pluginService.checkPluginUpdates).mockRejectedValue(new Error('network down'));
    const outcome = await runPluginUpdateCheck({ sourceUrl: SOURCE });
    expect(outcome).toMatchObject({ skipped: false, failed: true, updates: [], notified: false });
    expect(toastList()).toHaveLength(0);
    expect(debug).toHaveBeenCalled();
  });
});

describe('pluginUpdateMessage (≤3 全列，>3 前 3 个 + 等)', () => {
  it('lists up to three names with the Chinese separator', () => {
    const message = pluginUpdateMessage([named('a', '甲'), named('b', '乙')]);
    expect(message).toContain('甲、乙');
    expect(message).not.toContain('等');
  });

  it('lists only the first three names plus “等” for larger batches', () => {
    const message = pluginUpdateMessage([
      named('a', '甲'), named('b', '乙'), named('c', '丙'), named('d', '丁'),
    ]);
    expect(message).toContain('4');
    expect(message).toContain('甲、乙、丙');
    expect(message).not.toContain('丁');
    expect(message).toContain('等');
  });

  it('uses the English separator when English is active', async () => {
    await i18n.changeLanguage('en-US');
    const message = pluginUpdateMessage([named('a', 'Alpha'), named('b', 'Beta')]);
    expect(message).toContain('Alpha, Beta');
  });

  it('falls back to the plugin id when the manifest has no name', () => {
    const nameless = update({ manifest: { ...update().manifest, name: '' } });
    expect(pluginUpdateMessage([nameless])).toContain('plugin.alpha');
  });
});

describe('runPluginAutoCheck (自动：DEV/模式/周期门控 + 记账)', () => {
  it('skips when disabled, without calling the backend', async () => {
    const outcome = await runPluginAutoCheck(false);
    expect(outcome.skipped).toBe(true);
    expect(pluginService.checkPluginUpdates).not.toHaveBeenCalled();
    expect(pluginUpdateTiming.getLastCheckAt()).toBeNull();
  });

  it('skips in mode none even with an enabled override', async () => {
    commitUpdateMode('none');
    const outcome = await runPluginAutoCheck(true);
    expect(outcome.skipped).toBe(true);
    expect(pluginService.checkPluginUpdates).not.toHaveBeenCalled();
  });

  it('skips inside the 7-day period and runs again once it elapses', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    commitPluginMarketplaceUrl(SOURCE);
    pluginUpdateTiming.markCheckedAt(NOW - 6 * DAY);
    expect((await runPluginAutoCheck(true)).skipped).toBe(true);
    expect(pluginService.checkPluginUpdates).not.toHaveBeenCalled();

    pluginUpdateTiming.markCheckedAt(NOW - 7 * DAY);
    vi.mocked(pluginService.checkPluginUpdates).mockResolvedValue([]);
    const outcome = await runPluginAutoCheck(true);
    expect(outcome.skipped).toBe(false);
    expect(pluginService.checkPluginUpdates).toHaveBeenCalledOnce();
    expect(pluginUpdateTiming.getLastCheckAt()).toBe(NOW);
  });

  it('coalesces a concurrent automatic check while one is in flight', async () => {
    commitPluginMarketplaceUrl(SOURCE);
    let resolveCheck!: (updates: MarketplaceUpdate[]) => void;
    vi.mocked(pluginService.checkPluginUpdates).mockImplementation(
      () => new Promise((resolve) => { resolveCheck = resolve; }),
    );
    const first = runPluginAutoCheck(true);
    const second = await runPluginAutoCheck(true);
    expect(second.skipped).toBe(true);
    expect(pluginService.checkPluginUpdates).toHaveBeenCalledOnce();

    resolveCheck([]);
    expect((await first).skipped).toBe(false);
    // The in-flight latch releases after settlement, so a later due check runs.
    commitPluginMarketplaceUrl(SOURCE, { resetTiming: true });
    vi.mocked(pluginService.checkPluginUpdates).mockResolvedValue([]);
    expect((await runPluginAutoCheck(true)).skipped).toBe(false);
  });

  it('records lastCheckAt only on a successful non-skipped check', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    commitPluginMarketplaceUrl(SOURCE);
    vi.mocked(pluginService.checkPluginUpdates).mockRejectedValue(new Error('offline'));
    expect((await runPluginAutoCheck(true)).failed).toBe(true);
    expect(pluginUpdateTiming.getLastCheckAt()).toBeNull();

    vi.mocked(pluginService.checkPluginUpdates).mockResolvedValue([]);
    expect((await runPluginAutoCheck(true)).failed).toBe(false);
    expect(pluginUpdateTiming.getLastCheckAt()).toBe(NOW);
  });

  it('uses the committed marketplace source, never the settings draft', async () => {
    commitPluginMarketplaceUrl('https://committed.example/index.json');
    useAppStore.getState().setConfig({ pluginMarketplaceUrl: 'https://draft.example/index.json' });
    vi.mocked(pluginService.checkPluginUpdates).mockResolvedValue([]);
    await runPluginAutoCheck(true);
    expect(pluginService.checkPluginUpdates).toHaveBeenCalledWith('https://committed.example/index.json');
  });

  it('skips and does not mark when the committed source is empty', async () => {
    commitPluginMarketplaceUrl('');
    useAppStore.getState().setConfig({ pluginMarketplaceUrl: '' });
    const outcome = await runPluginAutoCheck(true);
    expect(outcome.skipped).toBe(true);
    expect(pluginService.checkPluginUpdates).not.toHaveBeenCalled();
    expect(pluginUpdateTiming.getLastCheckAt()).toBeNull();
  });
});

describe('runPluginManualCheck (显式意图：绕过 DEV/模式/周期，但不记账)', () => {
  it('bypasses DEV, none mode and the 7-day ledger', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    commitUpdateMode('none');
    commitPluginMarketplaceUrl(SOURCE);
    pluginUpdateTiming.markCheckedAt(NOW - 1_000);
    vi.mocked(pluginService.checkPluginUpdates).mockResolvedValue([]);

    const outcome = await runPluginManualCheck();
    expect(outcome.skipped).toBe(false);
    expect(pluginService.checkPluginUpdates).toHaveBeenCalledExactlyOnceWith(SOURCE);
    // Manual intent must not shift the automatic 7-day schedule.
    expect(pluginUpdateTiming.getLastCheckAt()).toBe(NOW - 1_000);
  });

  it('still requires a non-empty source', async () => {
    commitPluginMarketplaceUrl('');
    useAppStore.getState().setConfig({ pluginMarketplaceUrl: '' });
    const outcome = await runPluginManualCheck();
    expect(outcome.skipped).toBe(true);
    expect(pluginService.checkPluginUpdates).not.toHaveBeenCalled();
  });

  it('never records lastCheckAt even when it finds updates', async () => {
    commitPluginMarketplaceUrl(SOURCE);
    vi.mocked(pluginService.checkPluginUpdates).mockResolvedValue([update()]);
    const outcome = await runPluginManualCheck();
    expect(outcome.updates).toHaveLength(1);
    expect(outcome.notified).toBe(true);
    expect(pluginUpdateTiming.getLastCheckAt()).toBeNull();
  });
});

describe('已提交市场源与记账重置', () => {
  it('returns the trimmed committed source', () => {
    commitPluginMarketplaceUrl('  https://market.example/other.json  ');
    expect(getCommittedPluginMarketplaceUrl()).toBe('https://market.example/other.json');
  });

  it('falls back to the store source before the first commit', () => {
    useAppStore.getState().setConfig({ pluginMarketplaceUrl: '  https://draft.example/index.json  ' });
    resetPluginUpdateServiceForTests();
    expect(isPluginMarketplaceUrlCommitted()).toBe(false);
    expect(getCommittedPluginMarketplaceUrl()).toBe('https://draft.example/index.json');
    commitPluginMarketplaceUrl('https://committed.example/index.json');
    expect(isPluginMarketplaceUrlCommitted()).toBe(true);
  });

  it('resetTiming clears both the 7-day ledger and the notified fingerprint', () => {
    pluginUpdateTiming.markCheckedAt(NOW);
    pluginUpdateTiming.setNotified('plugin.alpha@1.1.0');
    commitPluginMarketplaceUrl('https://new.example/index.json', { resetTiming: true });
    expect(pluginUpdateTiming.getLastCheckAt()).toBeNull();
    expect(pluginUpdateTiming.getNotified()).toBeNull();
  });

  it('commit without resetTiming preserves the ledger', () => {
    pluginUpdateTiming.markCheckedAt(NOW);
    commitPluginMarketplaceUrl('https://new.example/index.json');
    expect(pluginUpdateTiming.getLastCheckAt()).toBe(NOW);
  });

  it('resetPluginUpdateTracking clears the ledger and fingerprint', () => {
    pluginUpdateTiming.markCheckedAt(NOW);
    pluginUpdateTiming.setNotified('plugin.alpha@1.1.0');
    resetPluginUpdateTracking();
    expect(pluginUpdateTiming.getLastCheckAt()).toBeNull();
    expect(pluginUpdateTiming.getNotified()).toBeNull();
  });

  it('test reset returns the committed source to uninitialized', () => {
    commitPluginMarketplaceUrl('https://committed.example/index.json');
    useAppStore.getState().setConfig({ pluginMarketplaceUrl: 'https://store.example/index.json' });
    resetPluginUpdateServiceForTests();
    expect(getCommittedPluginMarketplaceUrl()).toBe('https://store.example/index.json');
  });
});
