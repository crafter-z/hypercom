/**
 * usePluginHost / usePluginList — 插件宿主装配 + 设置页数据（issue #17）
 *
 * **usePluginHost()：主窗单例**（App.tsx 挂载一次，镜像 usePopoutBridge）——
 * 启动时 sync 宿主会话（启用插件拉 worker）、订阅 config.pluginConfigs 变化、
 * 把 pluginObserver RX 行批转发到各启用插件 worker 事件通道、崩溃回调刷新。
 * **不可在设置页调用**——它的 cleanup 会 dispose 宿主（设置页卸载即杀 worker）。
 *
 * **usePluginList()：设置页数据 hook**——纯列表 state + 命令（install/uninstall/
 * enable/权限），不碰宿主生命周期（host 同步由 usePluginHost 的 config 订阅驱动）。
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { pluginService } from '../services/tauri';
import { pluginHost } from '../utils/pluginHost';
import { attachRxObserver } from '../utils/pluginHostApi';
import { pluginKv } from '../utils/pluginKv';
import { rebuildPluginUi } from '../utils/pluginUiRegistry';
import { useAppStore } from '../stores/useAppStore';
import { notifyError, notifySuccess } from '../stores/useToastStore';
import type { PluginView } from '../types';

/** 把 pluginObserver RX 行批转发到某插件 worker 事件通道（rx.line/rx.detached）。 */
function attachRxForPlugin(pluginId: string): () => void {
  const session = pluginHost.get(pluginId);
  if (!session) return () => undefined;
  return attachRxObserver({
    post: (m, transfer) => session.post(m, transfer),
  });
}

/** 主窗单例装配（App.tsx）。返回空——装配是副作用。 */
export function usePluginHost(): void {
  const startedRef = useRef(false);
  const rxAttachmentsRef = useRef(new Map<string, () => void>());

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const refresh = async (): Promise<void> => {
      try {
        const list = await pluginService.listPlugins();
        // 重建声明式 UI 注册表（Sidebar 扩展点渲染数据源）。
        rebuildPluginUi(list);
      } catch (e) {
        console.error('[usePluginHost] list failed:', e);
      }
    };

    const attachAll = (): void => {
      const cfg = useAppStore.getState().config;
      for (const entry of cfg.pluginConfigs ?? []) {
        if (entry.enabled && !rxAttachmentsRef.current.has(entry.id)) {
          rxAttachmentsRef.current.set(entry.id, attachRxForPlugin(entry.id));
        }
      }
    };

    // 初始：sync 会话（拉 worker）+ 装配 rx。
    const boot = async (): Promise<void> => {
      pluginHost.syncWithConfig();
      attachAll();
      await refresh();
    };
    void boot().catch((e) => console.error('[usePluginHost] boot failed:', e));

    // config.pluginConfigs 变化 → sync 会话 + 装配/卸载 rx + 崩溃回调刷新。
    const unsub = useAppStore.subscribe((state, prev) => {
      if (state.config.pluginConfigs === prev.config.pluginConfigs) return;
      const prevEnabled = new Set(
        (prev.config.pluginConfigs ?? []).filter((p) => p.enabled).map((p) => p.id),
      );
      const nextEnabled = new Set(
        (state.config.pluginConfigs ?? []).filter((p) => p.enabled).map((p) => p.id),
      );
      for (const id of nextEnabled) {
        if (!prevEnabled.has(id)) {
          rxAttachmentsRef.current.set(id, attachRxForPlugin(id));
        }
      }
      for (const id of prevEnabled) {
        if (!nextEnabled.has(id)) {
          rxAttachmentsRef.current.get(id)?.();
          rxAttachmentsRef.current.delete(id);
        }
      }
      pluginHost.syncWithConfig();
    });

    pluginHost.setCallbacks({ onPluginCrashed: () => void refresh() });

    return () => {
      unsub();
      for (const unsubRx of rxAttachmentsRef.current.values()) {
        unsubRx();
      }
      rxAttachmentsRef.current.clear();
      pluginHost.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/** 设置页数据 hook：列表 + 命令。不碰宿主生命周期。 */
export function usePluginList() {
  const [plugins, setPlugins] = useState<PluginView[]>([]);
  const [loading, setLoading] = useState(false);

  /** 刷新插件列表（磁盘扫描 + config 状态）。 */
  const refresh = useCallback(async () => {
    try {
      const list = await pluginService.listPlugins();
      setPlugins(list);
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
        await pluginService.installPlugin(sourcePath);
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
        pluginKv.invalidate(pluginId);
        await pluginService.uninstallPlugin(pluginId);
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
        await pluginService.setPluginEnabled(pluginId, enabled);
        notifySuccess(enabled ? 'plugins.enabled' : 'plugins.disabled');
        await refresh();
      } catch (e) {
        console.error('[usePluginList] setEnabled failed:', e);
        notifyError(e);
      }
    },
    [refresh],
  );

  /** 授予/撤销权限（整体替换；manifest 声明是上限，后端校验子集）。 */
  const grantPermissions = useCallback(
    async (pluginId: string, permissions: string[]) => {
      try {
        await pluginService.setPluginPermissions(pluginId, permissions);
        notifySuccess('plugins.permissionsSaved');
        await refresh();
      } catch (e) {
        console.error('[usePluginList] grantPermissions failed:', e);
        notifyError(e);
      }
    },
    [refresh],
  );

  const api: PluginListApi = {
    plugins,
    loading,
    refresh,
    installPlugin,
    uninstallPlugin,
    setEnabled,
    grantPermissions,
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
  grantPermissions: (pluginId: string, permissions: string[]) => Promise<void>;
}
