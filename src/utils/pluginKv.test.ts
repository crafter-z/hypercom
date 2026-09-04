/**
 * pluginKv / pluginUiRegistry 测试（issue #17）
 *
 * pluginKv：KV 读写走 data/state.json（mock pluginService——不触后端）。
 * pluginUiRegistry：rebuild 快照 + 订阅通知。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pluginKv, invalidate } from './pluginKv';
import {
  rebuildPluginUi,
  subscribePluginUi,
  getPluginUiSnapshot,
  resetPluginUiForTest,
} from './pluginUiRegistry';

const mockRead = vi.fn();
const mockWrite = vi.fn();

vi.mock('../services/tauri', () => ({
  pluginService: {
    readPluginAsset: (...a: unknown[]) => mockRead(...a),
    writePluginAsset: (...a: unknown[]) => mockWrite(...a),
  },
}));

afterEach(() => {
  mockRead.mockReset();
  mockWrite.mockReset();
  vi.restoreAllMocks();
  resetPluginUiForTest();
  // 清 pluginKv 缓存（每个测试独立）。
  invalidate('com.example.test');
});

describe('pluginKv（评审 v2 D6/P2：KV 存 data/state.json 不落 config）', () => {
  it('get 无 state.json 时返回 undefined（读失败降级空）', async () => {
    mockRead.mockRejectedValue(new Error('no file'));
    expect(await pluginKv.get('com.example.test', 'key')).toBeUndefined();
    expect(mockRead).toHaveBeenCalledWith('com.example.test', 'data/state.json');
  });

  it('set 后 get 命中缓存并写盘', async () => {
    mockRead.mockRejectedValue(new Error('no file')); // 首次读失败
    await pluginKv.set('com.example.test', 'baud', 115200);
    expect(mockWrite).toHaveBeenCalledWith(
      'com.example.test',
      'data/state.json',
      expect.stringContaining('"baud": 115200'),
    );
    // 缓存命中：不二次读盘。
    expect(await pluginKv.get('com.example.test', 'baud')).toBe(115200);
    expect(mockRead).toHaveBeenCalledTimes(1);
  });

  it('set undefined 删除 key', async () => {
    mockRead.mockRejectedValue(new Error('no file'));
    await pluginKv.set('com.example.test', 'a', 1);
    await pluginKv.set('com.example.test', 'a', undefined);
    expect(await pluginKv.get('com.example.test', 'a')).toBeUndefined();
  });

  it('损坏的 state.json 降级为空（不炸）', async () => {
    mockRead.mockResolvedValue('not json{{{');
    expect(await pluginKv.get('com.example.test', 'x')).toBeUndefined();
  });

  it('读回已有 state.json 内容', async () => {
    mockRead.mockResolvedValue(JSON.stringify({ saved: 'yes' }));
    expect(await pluginKv.get('com.example.test', 'saved')).toBe('yes');
  });
  it('并发首载去重：两次并发 set 共享一次读盘，双键保全（复审竞态修复）', async () => {
    // 首次读盘挂起——两个 set 并发到达，必须共享同一 Promise（一次 read）。
    let releaseRead!: (v: string) => void;
    mockRead.mockImplementation(
      () => new Promise<string>((resolve) => { releaseRead = resolve; }),
    );
    const p1 = pluginKv.set('com.example.test', 'a', 1);
    const p2 = pluginKv.set('com.example.test', 'b', 2);
    releaseRead(JSON.stringify({}));
    await Promise.all([p1, p2]);
    expect(mockRead).toHaveBeenCalledTimes(1);
    // 双键都在（旧实现：双读盘双 Map，后写盘者覆盖前者 → 丢键）。
    expect(await pluginKv.get('com.example.test', 'a')).toBe(1);
    expect(await pluginKv.get('com.example.test', 'b')).toBe(2);
    // 写盘两次（各自 set 触发），最后一次 state 同时含两键。
    expect(mockWrite).toHaveBeenCalledTimes(2);
    const lastWrite = JSON.parse(mockWrite.mock.calls[1][2] as string);
    expect(lastWrite).toEqual({ a: 1, b: 2 });
  });
});

describe('pluginUiRegistry（评审 v2 D2）', () => {
  const view = (overrides: Partial<{ enabled: boolean; buttons: number; menuItems: number }>) => ({
    id: 'com.example.ui',
    enabled: overrides.enabled ?? true,
    manifest: {
      name: 'UI Plugin',
      ui: {
        buttons: Array.from({ length: overrides.buttons ?? 0 }, (_, i) => ({
          id: `b${i}`,
          label: `B${i}`,
          target: 'sidebar',
        })),
        menuItems: Array.from({ length: overrides.menuItems ?? 0 }, (_, i) => ({
          id: `m${i}`,
          label: `M${i}`,
          target: 'port-context',
        })),
      },
    },
  });

  it('rebuild 收集 enabled 插件的声明 UI', () => {
    rebuildPluginUi([view({ buttons: 2, menuItems: 1 })]);
    const snap = getPluginUiSnapshot();
    expect(snap.toolbarButtons).toHaveLength(1);
    expect(snap.toolbarButtons[0].buttons).toHaveLength(2);
    expect(snap.portMenuItems).toHaveLength(1);
  });

  it('disabled 插件不渲染 UI', () => {
    rebuildPluginUi([view({ enabled: false, buttons: 1, menuItems: 1 })]);
    const snap = getPluginUiSnapshot();
    expect(snap.toolbarButtons).toHaveLength(0);
    expect(snap.portMenuItems).toHaveLength(0);
  });

  it('无 ui 声明的插件不注册', () => {
    rebuildPluginUi([{ id: 'com.example.noui', enabled: true, manifest: { name: 'NoUI' } }]);
    const snap = getPluginUiSnapshot();
    expect(snap.toolbarButtons).toHaveLength(0);
    expect(snap.portMenuItems).toHaveLength(0);
  });

  it('rebuild 触发订阅者通知', () => {
    const listener = vi.fn();
    const unsub = subscribePluginUi(listener);
    rebuildPluginUi([view({ buttons: 1 })]);
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
    rebuildPluginUi([]);
    expect(listener).toHaveBeenCalledTimes(1); // 注销后不再通知
  });

  it('manifest 损坏的插件（无 manifest）不注册', () => {
    rebuildPluginUi([{ id: 'com.example.bad', enabled: true, manifest: null }]);
    const snap = getPluginUiSnapshot();
    expect(snap.toolbarButtons).toHaveLength(0);
  });
});
