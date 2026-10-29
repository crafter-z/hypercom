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
  it('initializes only a backend-confirmed absent state file', async () => {
    mockRead.mockResolvedValue(null);
    expect(await pluginKv.get('com.example.test', 'key')).toBeUndefined();
    await pluginKv.set('com.example.test', 'created', true);
    expect(mockRead).toHaveBeenCalledWith('com.example.test', 'data/state.json');
    expect(mockRead).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mockWrite.mock.calls[0][2] as string)).toEqual({ created: true });
  });

  it('set 后 get 命中缓存并写盘', async () => {
    mockRead.mockResolvedValue(null);
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
    mockRead.mockResolvedValue(null);
    await pluginKv.set('com.example.test', 'a', 1);
    await pluginKv.set('com.example.test', 'a', undefined);
    expect(await pluginKv.get('com.example.test', 'a')).toBeUndefined();
  });

  it('读回已有 state.json 内容', async () => {
    mockRead.mockResolvedValue(JSON.stringify({ saved: 'yes' }));
    expect(await pluginKv.get('com.example.test', 'saved')).toBe('yes');
  });

  it('retries a busy read before a subsequent set and preserves existing disk keys', async () => {
    let disk = JSON.stringify({ saved: 'private data', count: 2 });
    mockRead.mockRejectedValueOnce(new Error('plugin IO busy'));
    mockRead.mockImplementation(async () => disk);
    mockWrite.mockImplementation(async (_id: string, _path: string, content: string) => { disk = content; });
    await expect(pluginKv.get('com.example.test', 'saved')).rejects.toThrow('plugin IO busy');
    expect(mockWrite).not.toHaveBeenCalled();
    await pluginKv.set('com.example.test', 'added', 3);
    expect(mockRead).toHaveBeenCalledTimes(2);
    expect(JSON.parse(disk)).toEqual({ saved: 'private data', count: 2, added: 3 });
    expect(await pluginKv.get('com.example.test', 'saved')).toBe('private data');
  });

  it.each(['permission denied', 'read IO failure'])('propagates %s without caching empty state', async (message) => {
    mockRead.mockRejectedValue(new Error(message));
    await expect(pluginKv.get('com.example.test', 'saved')).rejects.toThrow(message);
    await expect(pluginKv.set('com.example.test', 'added', 3)).rejects.toThrow(message);
    expect(mockRead).toHaveBeenCalledTimes(2);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it.each(['not json{{{', 'null', '[]', '42', '"text"', 'true'])(
    'does not cache or overwrite invalid persisted state %s', async (disk) => {
      mockRead.mockResolvedValue(disk);
      await expect(pluginKv.get('com.example.test', 'saved')).rejects.toBeInstanceOf(Error);
      await expect(pluginKv.set('com.example.test', 'added', 3)).rejects.toBeInstanceOf(Error);
      expect(mockRead).toHaveBeenCalledTimes(2);
      expect(mockWrite).not.toHaveBeenCalled();
      mockRead.mockResolvedValue('{"repaired":true}');
      await pluginKv.set('com.example.test', 'added', 3);
      expect(JSON.parse(mockWrite.mock.calls[0][2] as string)).toEqual({ repaired: true, added: 3 });
    },
  );

  it('deduplicates failed first reads and lets the next call retry the disk state', async () => {
    let rejectRead!: (error: Error) => void;
    mockRead.mockImplementationOnce(() => new Promise<string>((_resolve, reject) => { rejectRead = reject; }));
    const outcomes = Promise.allSettled([
      pluginKv.get('com.example.test', 'saved'),
      pluginKv.set('com.example.test', 'added', true),
    ]);
    expect(mockRead).toHaveBeenCalledTimes(1);
    rejectRead(new Error('plugin IO busy'));
    expect((await outcomes).every((result) => result.status === 'rejected')).toBe(true);
    expect(mockWrite).not.toHaveBeenCalled();
    mockRead.mockResolvedValue('{"saved":true}');
    await pluginKv.set('com.example.test', 'added', true);
    expect(mockRead).toHaveBeenCalledTimes(2);
    expect(JSON.parse(mockWrite.mock.calls[0][2] as string)).toEqual({ saved: true, added: true });
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
  it('serializes disk snapshots even when the first backend write is delayed', async () => {
    mockRead.mockResolvedValue(null);
    let releaseFirst!: () => void;
    mockWrite.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseFirst = resolve; }));
    mockWrite.mockResolvedValue(undefined);
    const first = pluginKv.set('com.example.test', 'a', 1);
    await vi.waitFor(() => expect(mockWrite).toHaveBeenCalledTimes(1));
    const second = pluginKv.set('com.example.test', 'b', 2);
    await Promise.resolve();
    expect(mockWrite).toHaveBeenCalledTimes(1);
    releaseFirst();
    await Promise.all([first, second]);
    expect(JSON.parse(mockWrite.mock.calls[1][2] as string)).toEqual({ a: 1, b: 2 });
  });

  it('does not cache an old inflight read after invalidation', async () => {
    let release!: (value: string) => void;
    mockRead.mockImplementationOnce(() => new Promise<string>((resolve) => { release = resolve; }));
    const oldRead = pluginKv.get('com.example.test', 'old');
    const rejected = expect(oldRead).rejects.toThrow('plugin storage invalidated');
    invalidate('com.example.test');
    mockRead.mockResolvedValue('{"new":true}');
    expect(await pluginKv.get('com.example.test', 'new')).toBe(true);
    release('{"old":true}');
    await rejected;
    expect(await pluginKv.get('com.example.test', 'old')).toBeUndefined();
    expect(mockRead).toHaveBeenCalledTimes(2);
  });

  it('rejects a set invalidated during its first read without writing', async () => {
    let release!: (value: string) => void;
    mockRead.mockImplementationOnce(() => new Promise<string>((resolve) => { release = resolve; }));
    const pending = pluginKv.set('com.example.test', 'old', true);
    const rejected = expect(pending).rejects.toThrow('plugin storage invalidated');
    invalidate('com.example.test');
    release('{}');
    await rejected;
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('invalidates queued writes while keeping new writes behind a running disk write', async () => {
    mockRead.mockResolvedValue('{}');
    let release!: () => void;
    mockWrite.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const running = pluginKv.set('com.example.test', 'running', true);
    await vi.waitFor(() => expect(mockWrite).toHaveBeenCalledTimes(1));
    const queued = pluginKv.set('com.example.test', 'queued', true);
    await Promise.resolve();
    const rejected = expect(queued).rejects.toThrow('plugin storage invalidated');
    invalidate('com.example.test');
    mockRead.mockResolvedValue('{"reinstalled":true}');
    const fresh = pluginKv.set('com.example.test', 'fresh', true);
    await Promise.resolve();
    expect(mockWrite).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([running, rejected, fresh]);
    expect(mockWrite).toHaveBeenCalledTimes(2);
    expect(JSON.parse(mockWrite.mock.calls[1][2] as string)).toEqual({ reinstalled: true, fresh: true });
  });

  it('does not dispatch a queued write after its requester retires', async () => {
    mockRead.mockResolvedValue('{}');
    let releaseFirst!: () => void;
    mockWrite.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseFirst = resolve; }));
    let retired = false;
    const authority = (): void => {
      if (retired) throw new Error('request retired');
    };
    const running = pluginKv.set('com.example.test', 'running', true, authority);
    await vi.waitFor(() => expect(mockWrite).toHaveBeenCalledTimes(1));
    const queued = pluginKv.set('com.example.test', 'queued', true, authority);
    retired = true;
    releaseFirst();
    await running;
    await expect(queued).rejects.toThrow('request retired');
    expect(mockWrite).toHaveBeenCalledTimes(1);
  });

  it('stores values and keys well beyond the old size limits without truncation', async () => {
    mockRead.mockResolvedValue(null);
    const key = 'k'.repeat(4096);
    const large = '数'.repeat(4 * 1024 * 1024);
    await pluginKv.set('com.example.test', key, { large, nested: { list: [1, 2, 3] } });
    expect(await pluginKv.get('com.example.test', key)).toEqual({ large, nested: { list: [1, 2, 3] } });
    const snapshot: unknown = JSON.parse(mockWrite.mock.calls[0][2] as string);
    expect(snapshot).toEqual({ [key]: { large, nested: { list: [1, 2, 3] } } });
  });

  it.each([
    ['Map', new Map([['a', 1]])],
    ['Set', new Set([1])],
    ['Date', new Date(0)],
    ['Uint8Array', new Uint8Array([1, 2])],
    ['function', () => 1],
    ['nested undefined', { a: undefined }],
    ['NaN', { n: Number.NaN }],
    ['Infinity', [Number.POSITIVE_INFINITY]],
    ['BigInt', { n: BigInt(1) }],
    ['sparse array', new Array(2)],
  ])('rejects non-JSON %s values without writing', async (_label, value) => {
    mockRead.mockResolvedValue('{"saved":true}');
    await expect(pluginKv.set('com.example.test', 'bad', value)).rejects.toThrow('plugin storage');
    expect(mockWrite).not.toHaveBeenCalled();
    expect(await pluginKv.get('com.example.test', 'saved')).toBe(true);
  });

  it('rejects cyclic values, getters and toJSON without writing', async () => {
    mockRead.mockResolvedValue('{}');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(pluginKv.set('com.example.test', 'cycle', cyclic)).rejects.toThrow('cycles');
    const getter = {};
    Object.defineProperty(getter, 'value', { enumerable: true, get: () => 1 });
    await expect(pluginKv.set('com.example.test', 'getter', getter)).rejects.toThrow('getters');
    await expect(pluginKv.set('com.example.test', 'toJSON', { toJSON: () => 1 })).rejects.toThrow('toJSON');
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('accepts non-callable toJSON values as ordinary JSON data', async () => {
    mockRead.mockResolvedValue(null);
    const value = { toJSON: 'text', nested: { toJSON: 1 } };
    await pluginKv.set('com.example.test', 'literal', value);
    expect(await pluginKv.get('com.example.test', 'literal')).toEqual(value);
    expect(mockWrite).toHaveBeenCalledTimes(1);
  });

  it('does not treat a repeated, non-cyclic reference as a cycle', async () => {
    mockRead.mockResolvedValue(null);
    const shared = { value: 1 };
    await pluginKv.set('com.example.test', 'shared', { left: shared, right: shared });
    expect(await pluginKv.get('com.example.test', 'shared')).toEqual({ left: { value: 1 }, right: { value: 1 } });
  });

  it('keeps the last committed snapshot after a failed write and continues the queue', async () => {
    mockRead.mockResolvedValue('{"saved":true}');
    mockWrite.mockRejectedValueOnce(new Error('disk full'));
    await expect(pluginKv.set('com.example.test', 'lost', true)).rejects.toThrow('disk full');
    await pluginKv.set('com.example.test', 'next', true);
    expect(JSON.parse(mockWrite.mock.calls[1][2] as string)).toEqual({ saved: true, next: true });
    expect(await pluginKv.get('com.example.test', 'lost')).toBeUndefined();
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

  it('uses the default extension points for null and omitted targets', () => {
    rebuildPluginUi([{
      id: 'com.example.ui', enabled: true,
      manifest: { ui: {
        buttons: [
          { id: 'null-button', label: 'Null', icon: null, target: null },
          { id: 'default-button', label: 'Default' },
        ],
        menuItems: [
          { id: 'null-menu', label: 'Null', target: null },
          { id: 'default-menu', label: 'Default' },
        ],
      } },
    }]);
    expect(getPluginUiSnapshot().toolbarButtons[0].buttons.map((button) => button.id)).toEqual(['null-button', 'default-button']);
    expect(getPluginUiSnapshot().portMenuItems[0].menuItems.map((item) => item.id)).toEqual(['null-menu', 'default-menu']);
    expect(getPluginUiSnapshot().toolbarButtons[0].buttons[0].icon).toBeUndefined();
  });

  it('excludes declarations aimed at different host extension points', () => {
    rebuildPluginUi([{
      id: 'com.example.ui', enabled: true,
      manifest: { name: 'UI Plugin', ui: {
        buttons: [
          { id: 'toolbar', label: 'Toolbar', target: 'sidebar' },
          { id: 'wrong', label: 'Wrong', target: 'port-context' },
        ],
        menuItems: [
          { id: 'menu', label: 'Menu', target: 'port-context' },
          { id: 'wrong', label: 'Wrong', target: 'sidebar' },
        ],
      } },
    }]);
    expect(getPluginUiSnapshot().toolbarButtons[0].buttons.map((button) => button.id)).toEqual(['toolbar']);
    expect(getPluginUiSnapshot().portMenuItems[0].menuItems.map((item) => item.id)).toEqual(['menu']);
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
