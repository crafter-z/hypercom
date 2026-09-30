/**
 * usePluginHost / usePluginList — 插件宿主装配 + 设置页数据（issue #17）
 *
 * **usePluginHost()：主窗单例**（App.tsx 挂载一次，镜像 usePopoutBridge）——
 * 启动时 sync 宿主会话（启用插件拉 worker）、list_plugins 写回
 * store.config.pluginConfigs（issue #5-2 快照陷阱 + 运行时启停/权限的源）、
 * 订阅 config.pluginConfigs 变化（worker 启停 + rx 装配，rx 仅授予
 * terminal:read 的启用插件）、把 pluginObserver RX 行批转发到各合格插件、
 * 崩溃回调刷新。
 *
 * **usePluginList()：设置页数据 hook**——纯列表 state + 命令（install/uninstall/
 * enable/权限），不碰宿主生命周期（host 同步由 usePluginHost 的 config 订阅驱动）。
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { pluginService } from '../services/tauri';
import { pluginHost } from '../utils/pluginHost';
import { attachRxObserver, attachBytesObserver } from '../utils/pluginHostApi';
import { pluginKv } from '../utils/pluginKv';
import { rebuildPluginUi } from '../utils/pluginUiRegistry';
import { pluginMutationGeneration, syncStorePluginConfigs } from '../utils/pluginConfigSnapshot';
import { useAppStore } from '../stores/useAppStore';
import { useSystemStore } from '../stores/useSystemStore';
import { notifyError, notifySuccess } from '../stores/useToastStore';
import type { AppConfig, PluginView } from '../types';

/**
 * 把 pluginObserver RX 行批转发到某插件 worker 事件通道（rx.line/rx.detached）。
 * post 在**每次投递时**惰性查会话：装配时机（合格集同步）早于 worker 启动
 * （syncWithConfig 异步 enable）——装配点 session 为 null 是常态，不能据此
 * 早退存 no-op（复审 e2e 实测：否则 rx 转发永久失效）。会话未就绪的行静默
 * 丢弃（启动窗口期毫秒级，RX 观察语义可容忍）。
 */
function attachRxForPlugin(pluginId: string): () => void {
  return attachRxObserver({
    post: (m, transfer) => {
      if (!rxEligiblePluginIds().has(pluginId)) return;
      pluginHost.get(pluginId)?.post(m, transfer);
    },
  });
}

/** pluginConfigs 值签名（订阅守卫用——setConfig 原地合并使 ref 比较失效）。 */
function pluginConfigsSig(cfg: AppConfig): string {
  return JSON.stringify(cfg.pluginConfigs ?? []);
}

/**
 * RX 观察装配资格：已启用**且**已授予 terminal:read。设计 §5「宿主 → 插件事件」
 * 规定 rx.line 需要 terminal:read——未授权插件不得收到 RX 字节（worker 内代码
 * 可重挂 self.onmessage 截获事件，事件通道必须按权限关闸，评审 v2 D8 本地能力
 * 靠桥侧校验的推论）。
 */
export function rxEligiblePluginIds(): Set<string> {
  const cfg = useAppStore.getState().config;
  return new Set(
    (cfg.pluginConfigs ?? [])
      .filter((p) => p.enabled && p.grantedPermissions.includes('terminal:read'))
      .map((p) => p.id),
  );
}

/** RX 原始字节旁路装配资格：已启用**且**已授予 rx:bytes（issue #17 能力补强）。
 * 字节流是原始串口数据，属敏感观察——未授权插件不得收到。 */
export function rxBytesEligiblePluginIds(): Set<string> {
  const cfg = useAppStore.getState().config;
  return new Set(
    (cfg.pluginConfigs ?? [])
      .filter((p) => p.enabled && p.grantedPermissions.includes('rx:bytes'))
      .map((p) => p.id),
  );
}

/** 把 rx 装配同步到当前合格集（新合格 → attach；失格 → detach）。 */
function syncRxAttachments(rxAttachments: Map<string, () => void>): void {
  const desired = rxEligiblePluginIds();
  for (const id of desired) {
    if (!rxAttachments.has(id)) rxAttachments.set(id, attachRxForPlugin(id));
  }

  for (const id of [...rxAttachments.keys()]) {
    if (!desired.has(id)) {
      rxAttachments.get(id)?.();
      rxAttachments.delete(id);
    }
  }
}

/** 把 rx.bytes 装配同步到当前合格集（新合格 → attach；失格 → detach）。 */
function syncByteAttachments(bytesAttachments: Map<string, () => void>): void {
  const desired = rxBytesEligiblePluginIds();
  for (const id of desired) {
    if (!bytesAttachments.has(id)) {
      bytesAttachments.set(
        id,
        attachBytesObserver({
          post: (m, transfer) => {
            if (!rxBytesEligiblePluginIds().has(id)) return;
            if (m.type === 'rx.detached' && rxEligiblePluginIds().has(id)) return;
            pluginHost.get(id)?.post(m, transfer);
          },
        }),
      );
    }
  }

  for (const id of [...bytesAttachments.keys()]) {
    if (!desired.has(id)) {
      bytesAttachments.get(id)?.();
      bytesAttachments.delete(id);
    }
  }
}

/** 主窗单例装配（App.tsx）。返回空——装配是副作用。 */
export function usePluginHost(): void {
  const rxAttachmentsRef = useRef(new Map<string, () => void>());
  const bytesAttachmentsRef = useRef(new Map<string, () => void>());

  useEffect(() => {
    // **StrictMode 安全**（镜像 usePopoutBridge 无 startedRef 守卫——守卫会让
    // 「mount→cleanup→effect」序列的第二次 effect 全部跳过，订阅/boot 丢失，
    // 复审 e2e 实测 worker 永不启动）：每次 effect 全量注册，cleanup 全量拆除。

    let active = true;
    let refreshVersion = 0;
    const refresh = async (): Promise<void> => {
      const version = ++refreshVersion;
      const mutation = pluginMutationGeneration();
      try {
        const res = await pluginService.listPlugins();
        if (!active || version !== refreshVersion || mutation !== pluginMutationGeneration()) return;
        syncStorePluginConfigs(res.pluginConfigs);
        rebuildPluginUi(res.plugins);
      } catch (e) {
        if (active) console.error('[usePluginHost] list failed:', e);
      }
    };

    const boot = (): void => {
      if (!active || !useSystemStore.getState().ui.configReady) return;
      pluginHost.syncWithConfig();
      syncRxAttachments(rxAttachmentsRef.current);
      syncByteAttachments(bytesAttachmentsRef.current);
      void refresh();
    };
    const unsubReady = useSystemStore.subscribe((state, prev) => {
      if (state.ui.configReady && !prev.ui.configReady) boot();
    });
    boot();

    // config.pluginConfigs 变化（启用/权限/安装——含 refresh 写回自身）→
    // 按合格集同步 rx 装配 + sync 会话（worker 启停）。
    // **守卫必须值比较**：setConfig 是 Object.assign 原地合并（useAppStore），
    // state.config 与 prev.config 是同一对象——ref 相等守卫会永真早退
    // （复审 e2e 实测：worker 永不启动）。JSON 签名（数组小、低频）兜住 3s
    // 端口轮询噪音。
    let lastSig = pluginConfigsSig(useAppStore.getState().config);
    const unsub = useAppStore.subscribe((state) => {
      const sig = pluginConfigsSig(state.config);
      if (sig === lastSig) return;
      lastSig = sig;
      if (!useSystemStore.getState().ui.configReady) return;
      syncRxAttachments(rxAttachmentsRef.current);
      syncByteAttachments(bytesAttachmentsRef.current);
      pluginHost.syncWithConfig();
    });
    pluginHost.setCallbacks({ onPluginCrashed: () => void refresh() });

    return () => {
      active = false;
      unsubReady();
      unsub();
      for (const unsubRx of rxAttachmentsRef.current.values()) {
        unsubRx();
      }
      rxAttachmentsRef.current.clear();
      for (const unsubBytes of bytesAttachmentsRef.current.values()) {
        unsubBytes();
      }
      bytesAttachmentsRef.current.clear();
      pluginHost.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/** 设置页数据 hook：列表 + 命令。不碰宿主生命周期。 */
export function usePluginList() {
  const [plugins, setPlugins] = useState<PluginView[]>([]);
  const [loading, setLoading] = useState(false);
  const listRefreshVersion = useRef(0);
  const permissionsInFlight = useRef(new Map<string, Promise<void>>());

  /** Refresh the plugin list and the host UI registration snapshot. */
  const refresh = useCallback(async () => {
    const version = ++listRefreshVersion.current;
    const mutation = pluginMutationGeneration();
    try {
      const res = await pluginService.listPlugins();
      if (version !== listRefreshVersion.current || mutation !== pluginMutationGeneration()) return;
      setPlugins(res.plugins);
      syncStorePluginConfigs(res.pluginConfigs);
      rebuildPluginUi(res.plugins);
    } catch (e) {
      console.error('[usePluginList] list failed:', e);
      notifyError(e);
    }
  }, []);

  // 打开设置页时加载一次。
  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** 安装插件（zip 或目录路径，经对话框选择）。 */
  const installPlugin = useCallback(
    async (sourcePath: string) => {
      setLoading(true);
      try {
        const previous = useAppStore.getState().config.pluginConfigs ?? [];
        const entries = await pluginService.installPlugin(sourcePath);
        for (const entry of entries) {
          const old = previous.find((p) => p.id === entry.id);
          if (!old || old.installedAt !== entry.installedAt) {
            pluginKv.invalidate(entry.id);
            pluginHost.disable(entry.id);
          }
        }
        syncStorePluginConfigs(entries);
        notifySuccess('plugins.installed');
        await refresh();
      } catch (e) {
        console.error('[usePluginList] install failed:', e);
        notifyError(e);
        throw e;
      } finally {
        setLoading(false);
      }
    },
    [refresh],
  );

  /** 卸载插件。 */
  const uninstallPlugin = useCallback(
    async (pluginId: string) => {
      setLoading(true);
      try {
        const entries = await pluginService.uninstallPlugin(pluginId);
        pluginKv.invalidate(pluginId);
        syncStorePluginConfigs(entries);
        notifySuccess('plugins.uninstalled');
        await refresh();
      } catch (e) {
        console.error('[usePluginList] uninstall failed:', e);
        notifyError(e);
      } finally {
        setLoading(false);
      }
    },
    [refresh],
  );

  /** 启用/禁用插件（config 变化经 usePluginHost 订阅同步宿主会话）。 */
  const setEnabled = useCallback(
    async (pluginId: string, enabled: boolean) => {
      try {
        const entries = await pluginService.setPluginEnabled(pluginId, enabled);
        syncStorePluginConfigs(entries);
        notifySuccess(enabled ? 'plugins.enabled' : 'plugins.disabled');
        await refresh();
      } catch (e) {
        console.error('[usePluginList] setEnabled failed:', e);
        notifyError(e);
      }
    },
    [refresh],
  );

  /** Toggle against the latest authoritative grants after preceding mutations settle. */
  const togglePermission = useCallback((pluginId: string, permission: string): Promise<void> => {
    const previous = permissionsInFlight.current.get(pluginId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const entry = useAppStore.getState().config.pluginConfigs?.find((p) => p.id === pluginId);
      if (!entry) throw new Error(`plugin ${pluginId} not installed`);
      const permissions = entry.grantedPermissions.includes(permission)
        ? entry.grantedPermissions.filter((p) => p !== permission)
        : [...entry.grantedPermissions, permission];
      const entries = await pluginService.setPluginPermissions(pluginId, permissions);
      ++listRefreshVersion.current;
      syncStorePluginConfigs(entries);
      await refresh();
    }).catch((e: unknown) => {
      console.error('[usePluginList] togglePermission failed:', e);
      notifyError(e);
    });
    permissionsInFlight.current.set(pluginId, next);
    void next.finally(() => {
      if (permissionsInFlight.current.get(pluginId) === next) permissionsInFlight.current.delete(pluginId);
    });
    return next;
  }, [refresh]);


  const api: PluginListApi = {
    plugins,
    loading,
    refresh,
    installPlugin,
    uninstallPlugin,
    setEnabled,
    togglePermission,
  };
  return api;
}

/** usePluginList 返回的 API 契约（设置页消费）。 */
export interface PluginListApi {
  plugins: PluginView[];
  loading: boolean;
  refresh: () => Promise<void>;
  installPlugin: (sourcePath: string) => Promise<void>;
  uninstallPlugin: (pluginId: string) => Promise<void>;
  setEnabled: (pluginId: string, enabled: boolean) => Promise<void>;
  togglePermission: (pluginId: string, permission: string) => Promise<void>;
}
