/**
 * pluginKv — 插件私有 KV 存储（issue #17，评审 v2 D6/P2）
 *
 * KV 存 `<plugins_dir>/<id>/data/state.json`（**不落 config.json**——评审 v2 P2：
 * config 只存启用/权限状态；KV 是插件数据，随插件生命周期，卸载即清理，
 * 且避开「启动快照陷阱」issue #5-2）。经后端 `write_plugin_asset`（限 data/）/
 * `read_plugin_asset` 读写。
 *
 * v1 实现：整体读写 state.json（单文件，KV 量小；写时整体替换）。读缓存
 * 内存 Map 避免每 get 一次 RPC；set 后同步写盘（防丢失）。
 */
import { pluginService } from '../services/tauri';

/** 内存缓存：pluginId → Map<key, value>（读盘后缓存；写盘后更新）。 */
const cache = new Map<string, Map<string, unknown>>();
/** Disk snapshots must be serialized: overlapping write_plugin_asset calls can finish out of order. */
const writes = new Map<string, Promise<void>>();
const generations = new Map<string, number>();

const STATE_FILE = 'data/state.json';

/** 读取插件 KV 值（无 → undefined）。 */
export async function get(pluginId: string, key: string): Promise<unknown> {
  const m = await load(pluginId);
  return m.get(key);
}

/** 写入插件 KV 值（value 必须 JSON 可序列化）。写盘整体替换。 */
export async function set(pluginId: string, key: string, value: unknown): Promise<void> {
  const generation = generations.get(pluginId) ?? 0;
  const loaded = await load(pluginId);
  if (generation !== (generations.get(pluginId) ?? 0)) throw new Error('plugin storage invalidated');
  const previous = writes.get(pluginId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    if (generation !== (generations.get(pluginId) ?? 0)) throw new Error('plugin storage invalidated');
    const current = cache.get(pluginId) ?? loaded;
    const candidate = new Map(current);
    if (value === undefined) candidate.delete(key);
    else candidate.set(key, value);
    const snapshot = JSON.stringify(Object.fromEntries(candidate), null, 2);
    await pluginService.writePluginAsset(pluginId, STATE_FILE, snapshot);
    if (generation === (generations.get(pluginId) ?? 0)) cache.set(pluginId, candidate);
  });
  writes.set(pluginId, next);
  try {
    await next;
  } finally {
    if (writes.get(pluginId) === next) writes.delete(pluginId);
  }
}

/** 读入插件 KV（缓存命中直接返回；读盘失败/无 state.json → 空 Map）。
 *  **in-flight 去重**（评审复审修复并发首载竞态）：缓存未命中时并发调用方
 *  共享同一次读盘 Promise——旧实现双读盘各自建 Map、后写盘者整体覆盖前者的
 *  set（丢键）。 */
const inflight = new Map<string, Promise<Map<string, unknown>>>();

async function load(pluginId: string): Promise<Map<string, unknown>> {
  const cached = cache.get(pluginId);
  if (cached) return cached;
  const pending = inflight.get(pluginId);
  if (pending) return pending;
  const generation = generations.get(pluginId) ?? 0;
  const promise = (async (): Promise<Map<string, unknown>> => {
    let raw: string;
    try {
      raw = await pluginService.readPluginAsset(pluginId, STATE_FILE);
    } catch {
      // 无 state.json（首次）——空 Map。
      const empty = new Map<string, unknown>();
      if (generation === (generations.get(pluginId) ?? 0)) cache.set(pluginId, empty);
      return empty;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      parsed = {}; // 损坏的 state.json 降级为空（插件数据非关键）。
    }
    const m = new Map<string, unknown>(Object.entries(parsed));
    if (generation === (generations.get(pluginId) ?? 0)) cache.set(pluginId, m);
    return m;
  })();
  inflight.set(pluginId, promise);
  try {
    return await promise;
  } finally {
    if (inflight.get(pluginId) === promise) inflight.delete(pluginId);
  }
}

/** Uninstall/reinstall invalidates cached reads and prevents queued writes from starting.
 * An already-running backend write cannot be cancelled here. */
export function invalidate(pluginId: string): void {
  cache.delete(pluginId);
  inflight.delete(pluginId);
  generations.set(pluginId, (generations.get(pluginId) ?? 0) + 1);
  writes.delete(pluginId);
}

export const pluginKv = { get, set, invalidate };
