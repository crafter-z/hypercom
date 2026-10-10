/**
 * usePluginHost / usePluginList — 插件宿主装配 + 设置页数据（issue #17）
 *
 * 主窗 usePluginHost 管理 Worker、RX 观察器和配置同步；usePluginList 只提供
 * 设置页列表及变更命令。插件列表快照由 pluginConfigSnapshot 共享，避免设置页
 * 与宿主各自持有过期视图。
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { pluginService } from '../services/tauri';
import { pluginHost } from '../utils/pluginHost';
import { attachRxObserver, attachBytesObserver } from '../utils/pluginHostApi';
import {
  getPluginViews,
  subscribePluginViews,
  syncPluginListSnapshot,
  syncStorePluginConfigs,
} from '../utils/pluginConfigSnapshot';
import { useAppStore } from '../stores/useAppStore';
import { useSystemStore } from '../stores/useSystemStore';
import { notifyError, notifySuccess } from '../stores/useToastStore';
import type { AppConfig, PluginView } from '../types';

// Permission updates replace the complete grant array. Keep one queue per
// plugin outside React component instances so page switches cannot resurrect a
// stale grant snapshot.
const permissionQueues = new Map<string, Promise<void>>();

function attachRxForPlugin(pluginId: string): () => void {
  return attachRxObserver({
    post: (message, transfer) => {
      if (!rxEligiblePluginIds().has(pluginId)) return;
      pluginHost.get(pluginId)?.post(message, transfer);
    },
  });
}

function pluginConfigsSig(config: AppConfig): string {
  return JSON.stringify(config.pluginConfigs ?? []);
}

export function rxEligiblePluginIds(): Set<string> {
  const configs = useAppStore.getState().config.pluginConfigs ?? [];
  return new Set(
    configs
      .filter((plugin) => plugin.enabled && plugin.grantedPermissions.includes('terminal:read'))
      .map((plugin) => plugin.id),
  );
}

export function rxBytesEligiblePluginIds(): Set<string> {
  const configs = useAppStore.getState().config.pluginConfigs ?? [];
  return new Set(
    configs
      .filter((plugin) => plugin.enabled && plugin.grantedPermissions.includes('rx:bytes'))
      .map((plugin) => plugin.id),
  );
}

function syncRxAttachments(attachments: Map<string, () => void>): void {
  const desired = rxEligiblePluginIds();
  for (const id of desired) {
    if (!attachments.has(id)) attachments.set(id, attachRxForPlugin(id));
  }
  for (const id of [...attachments.keys()]) {
    if (!desired.has(id)) {
      attachments.get(id)?.();
      attachments.delete(id);
    }
  }
}

function syncByteAttachments(attachments: Map<string, () => void>): void {
  const desired = rxBytesEligiblePluginIds();
  for (const id of desired) {
    if (attachments.has(id)) continue;
    attachments.set(id, attachBytesObserver({
      post: (message, transfer) => {
        if (!rxBytesEligiblePluginIds().has(id)) return;
        if (message.type === 'rx.detached' && rxEligiblePluginIds().has(id)) return;
        pluginHost.get(id)?.post(message, transfer);
      },
    }));
  }
  for (const id of [...attachments.keys()]) {
    if (!desired.has(id)) {
      attachments.get(id)?.();
      attachments.delete(id);
    }
  }
}

export function usePluginHost(): void {
  const rxAttachmentsRef = useRef(new Map<string, () => void>());
  const bytesAttachmentsRef = useRef(new Map<string, () => void>());

  useEffect(() => {
    let active = true;
    let refreshVersion = 0;
    const refresh = async (): Promise<void> => {
      const version = ++refreshVersion;
      // Backend revisions order both reads and writes; request order only handles page lifetime.
      try {
        const result = await pluginService.listPlugins();
        if (!active || version !== refreshVersion) return;
        if (syncPluginListSnapshot(result)) pluginHost.syncWithConfig();
      } catch (error) {
        if (active) console.error('[usePluginHost] list failed:', error);
      }
    };
    const boot = (): void => {
      if (!active || !useSystemStore.getState().ui.configReady) return;
      pluginHost.syncWithConfig();
      syncRxAttachments(rxAttachmentsRef.current);
      syncByteAttachments(bytesAttachmentsRef.current);
      void refresh();
    };
    const unsubscribeReady = useSystemStore.subscribe((state, previous) => {
      if (state.ui.configReady && !previous.ui.configReady) boot();
    });
    boot();

    let lastSignature = pluginConfigsSig(useAppStore.getState().config);
    const unsubscribeConfig = useAppStore.subscribe((state) => {
      const signature = pluginConfigsSig(state.config);
      if (signature === lastSignature) return;
      lastSignature = signature;
      if (!useSystemStore.getState().ui.configReady) return;
      syncRxAttachments(rxAttachmentsRef.current);
      syncByteAttachments(bytesAttachmentsRef.current);
      pluginHost.syncWithConfig();
    });
    pluginHost.setCallbacks({ onPluginCrashed: () => void refresh() });

    return () => {
      active = false;
      unsubscribeReady();
      unsubscribeConfig();
      for (const unsubscribe of rxAttachmentsRef.current.values()) unsubscribe();
      rxAttachmentsRef.current.clear();
      for (const unsubscribe of bytesAttachmentsRef.current.values()) unsubscribe();
      bytesAttachmentsRef.current.clear();
      pluginHost.dispose();
    };
  }, []);
}

export function usePluginList() {
  const [plugins, setPlugins] = useState<PluginView[]>(() => getPluginViews());
  const [loading, setLoading] = useState(false);
  const listRefreshVersion = useRef(0);

  useEffect(() => subscribePluginViews(() => setPlugins(getPluginViews())), []);

  const refresh = useCallback(async () => {
    const version = ++listRefreshVersion.current;
    try {
      const result = await pluginService.listPlugins();
      if (version !== listRefreshVersion.current) return;
      if (syncPluginListSnapshot(result) && useSystemStore.getState().ui.configReady) pluginHost.syncWithConfig(true);
    } catch (error) {
      console.error('[usePluginList] list failed:', error);
      notifyError(error);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const installPlugin = useCallback(async (sourcePath: string) => {
    setLoading(true);
    try {
      const snapshot = await pluginService.installPlugin(sourcePath);
      syncStorePluginConfigs(snapshot);
      notifySuccess('plugins.installed');
      await refresh();
    } catch (error) {
      console.error('[usePluginList] install failed:', error);
      notifyError(error);
      throw error;
    } finally {
      setLoading(false);
    }
  }, [refresh]);

  const uninstallPlugin = useCallback(async (pluginId: string) => {
    setLoading(true);
    try {
      const snapshot = await pluginService.uninstallPlugin(pluginId);
      syncStorePluginConfigs(snapshot);
      notifySuccess('plugins.uninstalled');
      await refresh();
    } catch (error) {
      console.error('[usePluginList] uninstall failed:', error);
      notifyError(error);
    } finally {
      setLoading(false);
    }
  }, [refresh]);

  const setEnabled = useCallback(async (pluginId: string, enabled: boolean, expectedGeneration: string) => {
    try {
      await permissionQueues.get(pluginId);
      const snapshot = await pluginService.setPluginEnabled(pluginId, enabled, expectedGeneration);
      syncStorePluginConfigs(snapshot);
      notifySuccess(enabled ? 'plugins.enabled' : 'plugins.disabled');
      await refresh();
    } catch (error) {
      console.error('[usePluginList] setEnabled failed:', error);
      notifyError(error);
    }
  }, [refresh]);

  const togglePermission = useCallback((pluginId: string, permission: string, expectedGeneration: string): Promise<void> => {
    const previous = permissionQueues.get(pluginId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const entry = useAppStore.getState().config.pluginConfigs?.find((plugin) => plugin.id === pluginId);
      if (!entry || entry.installGeneration !== expectedGeneration) throw new Error(`plugin ${pluginId} installation changed; refresh before granting permissions`);
      const permissions = entry.grantedPermissions.includes(permission)
        ? entry.grantedPermissions.filter((item) => item !== permission)
        : [...entry.grantedPermissions, permission];
      const snapshot = await pluginService.setPluginPermissions(pluginId, permissions, expectedGeneration);
      ++listRefreshVersion.current;
      syncStorePluginConfigs(snapshot);
      await refresh();
    }).catch((error: unknown) => {
      console.error('[usePluginList] togglePermission failed:', error);
      notifyError(error);
    });
    permissionQueues.set(pluginId, next);
    void next.finally(() => {
      if (permissionQueues.get(pluginId) === next) permissionQueues.delete(pluginId);
    });
    return next;
  }, [refresh]);

  return { plugins, loading, refresh, installPlugin, uninstallPlugin, setEnabled, togglePermission } satisfies PluginListApi;
}

export interface PluginListApi {
  plugins: PluginView[];
  loading: boolean;
  refresh: () => Promise<void>;
  installPlugin: (sourcePath: string) => Promise<void>;
  uninstallPlugin: (pluginId: string) => Promise<void>;
  setEnabled: (pluginId: string, enabled: boolean, expectedGeneration: string) => Promise<void>;
  togglePermission: (pluginId: string, permission: string, expectedGeneration: string) => Promise<void>;
}
