/**
 * usePluginHost / usePluginList — 插件宿主装配 + 设置页数据（issue #17）
 *
 * 主窗 usePluginHost 管理 Worker、RX 观察器和配置同步；usePluginList 只提供
 * 设置页列表及变更命令。插件列表快照由 pluginConfigSnapshot 共享，避免设置页
 * 与宿主各自持有过期视图。
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { pluginService } from '../services/tauri';
import type { PluginDirectoryInstallRequest } from '../services/plugin';
import { pluginHost } from '../utils/pluginHost';
import { attachRxObserver, attachBytesObserver } from '../utils/pluginHostApi';
import {
  getPluginViews,
  subscribePluginViews,
  syncPluginListSnapshot,
  syncStorePluginConfigs,
} from '../utils/pluginConfigSnapshot';
import { reloadPluginViews } from '../utils/pluginViewRuntime';
import { startPluginControlBridge } from '../utils/pluginControlBridge';
import {
  effectivePermissions, hasTrustedViews, permissionDelta, reviewablePermissions, reviewStillApplies,
  type PluginPermissionDecision,
} from '../utils/pluginPermissionReview';
import { useAppStore } from '../stores/useAppStore';
import { useSystemStore } from '../stores/useSystemStore';
import { extractErrorMessage, notifyError, notifySuccess } from '../stores/useToastStore';
import type { AppConfig, MarketplaceIndex, MarketplaceUpdate, PluginView } from '../types';

// Backend refuses a same/lower-version install unless the caller explicitly
// replaces it. The refusal is not a user-visible failure: the settings page
// asks for confirmation and retries with replaceExisting. Keep the code in
// sync with the Rust CommandError prefix.
const INSTALL_CANCELLED = 'plugin_install_cancelled';
const REPLACE_CONFIRMATION_PREFIX = 'plugin_replace_confirmation_required';

export function isPluginReplaceConfirmationError(error: unknown): boolean {
  return extractErrorMessage(error).trim().startsWith(REPLACE_CONFIRMATION_PREFIX);
}

/** Extract the backend-reviewed target identity from a replacement refusal. */
export function replacementTargetId(error: unknown): string | undefined {
  const message = extractErrorMessage(error).trim();
  if (!message.startsWith(REPLACE_CONFIRMATION_PREFIX)) return undefined;
  const match = message.match(/:\s*(?:插件\s+)?([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)(?:\s|$)/);
  return match?.[1];
}

// Permission updates replace the complete grant array. Keep one queue per
// plugin outside React component instances so page switches cannot resurrect a
// stale grant snapshot.
const permissionQueues = new Map<string, Promise<void>>();

function queuePermissionMutation(pluginId: string, operation: () => Promise<void>): Promise<void> {
  const previous = permissionQueues.get(pluginId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  permissionQueues.set(pluginId, next);
  const release = () => {
    if (permissionQueues.get(pluginId) === next) permissionQueues.delete(pluginId);
  };
  void next.then(release, release);
  return next;
}

async function reconcileMutationFailure(): Promise<void> {
  try {
    const result = await pluginService.listPlugins();
    syncPluginListSnapshot(result);
    if (useSystemStore.getState().ui.configReady) pluginHost.syncWithConfig(true);
  } catch (recoveryError) {
    // An error after a durable trust mutation has no safe local interpretation.
    // Retire every Worker until an authoritative snapshot can be obtained.
    console.error('[usePluginList] authoritative plugin recovery failed:', recoveryError);
    pluginHost.dispose();
  }
}

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
    const refresh = async (attempt = 0): Promise<void> => {
      const version = ++refreshVersion;
      // Backend revisions order both reads and writes; request order only handles page lifetime.
      try {
        const result = await pluginService.listPlugins();
        if (!active || version !== refreshVersion) return;
        if (syncPluginListSnapshot(result)) pluginHost.syncWithConfig();
      } catch (error) {
        if (!active) return;
        // Initial manifest read can race app startup; retry with bounded
        // backoff instead of leaving Worker/UI registries stale until restart.
        if (attempt < 4) {
          await new Promise<void>((resolve) => setTimeout(resolve, Math.min(250 * 2 ** attempt, 4000)));
          if (active && version === refreshVersion) await refresh(attempt + 1);
          return;
        }
        console.error('[usePluginHost] list failed:', error);
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
    const stopControlBridge = startPluginControlBridge();

    return () => {
      active = false;
      stopControlBridge();
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

/**
 * Marketplace reads are deliberately scoped to the source URL captured at the
 * start of each request. A source edit invalidates the request epoch, so a
 * slow response from the previous source cannot replace the current index or
 * update list.
 */
export interface PluginMarketplaceApi {
  index: MarketplaceIndex | null;
  updates: MarketplaceUpdate[];
  loading: boolean;
  error: string | null;
  fetchIndex: () => Promise<MarketplaceIndex | null>;
  checkUpdates: () => Promise<MarketplaceUpdate[] | null>;
}

export function usePluginMarketplace(sourceUrl: string): PluginMarketplaceApi {
  const sourceKey = sourceUrl.trim();
  const [index, setIndex] = useState<MarketplaceIndex | null>(null);
  const [indexSource, setIndexSource] = useState<string | null>(null);
  const [updates, setUpdates] = useState<MarketplaceUpdate[]>([]);
  const [updatesSource, setUpdatesSource] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorSource, setErrorSource] = useState<string | null>(null);
  const requestVersionRef = useRef(0);
  const sourceRef = useRef(sourceKey);
  // Keep this ref current during render so a click immediately after editing
  // cannot be accepted against the previous source before effects run.
  if (sourceRef.current !== sourceKey) {
    sourceRef.current = sourceKey;
    requestVersionRef.current += 1;
  }

  useEffect(() => {
    setIndex(null);
    setIndexSource(null);
    setUpdates([]);
    setUpdatesSource(null);
    setError(null);
    setErrorSource(null);
    setLoading(false);
  }, [sourceKey]);

  const fetchIndex = useCallback(async (): Promise<MarketplaceIndex | null> => {
    if (!sourceKey) {
      setError('marketplace source is empty');
      setErrorSource(sourceKey);
      return null;
    }
    const version = ++requestVersionRef.current;
    const requestedSource = sourceKey;
    setLoading(true);
    setError(null);
    setErrorSource(null);
    try {
      const result = await pluginService.fetchPluginMarketplace(requestedSource);
      if (version !== requestVersionRef.current || sourceRef.current !== requestedSource) return null;
      setIndex(result);
      setIndexSource(requestedSource);
      setUpdates([]);
      setUpdatesSource(null);
      return result;
    } catch (reason) {
      if (version !== requestVersionRef.current || sourceRef.current !== requestedSource) return null;
      const message = extractErrorMessage(reason);
      setError(message);
      setErrorSource(requestedSource);
      return null;
    } finally {
      if (version === requestVersionRef.current && sourceRef.current === requestedSource) setLoading(false);
    }
  }, [sourceKey]);

  const checkUpdates = useCallback(async (): Promise<MarketplaceUpdate[] | null> => {
    if (!sourceKey) {
      setError('marketplace source is empty');
      setErrorSource(sourceKey);
      return null;
    }
    const version = ++requestVersionRef.current;
    const requestedSource = sourceKey;
    setLoading(true);
    setError(null);
    setErrorSource(null);
    try {
      const result = await pluginService.checkPluginUpdates(requestedSource);
      if (version !== requestVersionRef.current || sourceRef.current !== requestedSource) return null;
      setUpdates(result);
      setUpdatesSource(requestedSource);
      return result;
    } catch (reason) {
      if (version !== requestVersionRef.current || sourceRef.current !== requestedSource) return null;
      const message = extractErrorMessage(reason);
      setError(message);
      setErrorSource(requestedSource);
      return null;
    } finally {
      if (version === requestVersionRef.current && sourceRef.current === requestedSource) setLoading(false);
    }
  }, [sourceKey]);

  return {
    index: indexSource === sourceKey ? index : null,
    updates: updatesSource === sourceKey ? updates : [],
    loading,
    error: errorSource === sourceKey ? error : null,
    fetchIndex,
    checkUpdates,
  };
}

export function usePluginList() {
  const [plugins, setPlugins] = useState<PluginView[]>(() => getPluginViews());
  const [loading, setLoading] = useState(false);
  const listRefreshVersion = useRef(0);

  useEffect(() => subscribePluginViews(() => setPlugins(getPluginViews())), []);

  // Mutation follow-ups must observe list failures: a reload cannot remount
  // views or announce success using a manifest list that was never refreshed.
  const refreshSnapshot = useCallback(async (): Promise<PluginView[]> => {
    const version = ++listRefreshVersion.current;
    const result = await pluginService.listPlugins();
    if (version !== listRefreshVersion.current) return getPluginViews();
    const accepted = syncPluginListSnapshot(result);
    if (accepted && useSystemStore.getState().ui.configReady) pluginHost.syncWithConfig(true);
    // A revision-rejected response must not be treated as authoritative by
    // callers (install handoff); expose the last accepted snapshot instead.
    return getPluginViews();
  }, []);

  const refresh = useCallback(async (): Promise<PluginView[]> => {
    try {
      return await refreshSnapshot();
    } catch (error) {
      console.error('[usePluginList] list failed:', error);
      notifyError(error);
      return getPluginViews();
    }
  }, [refreshSnapshot]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const installPlugin = useCallback(async (
    sourcePath: string,
    replaceExisting = false,
    expectedGeneration?: string,
    directory?: PluginDirectoryInstallRequest,
  ): Promise<PluginView | null> => {
    setLoading(true);
    // Do not suspend unrelated plugins while validating/installing a source.
    // Native mutations recheck authority; the returned installation snapshot
    // below retires only the replaced/disabled session.
    // Identify the installed plugin from the authoritative install snapshot
    // (id + installGeneration), never by diffing the renderer's manifest list:
    // that list may be empty/stale and `find` would return an unrelated plugin,
    // opening the permission review for the wrong plugin.
    const previousGenerations = new Map(
      (useAppStore.getState().config.pluginConfigs ?? []).map(entry => [entry.id, entry.installGeneration]),
    );
    try {
      const snapshot = directory
        ? await pluginService.installPluginDirectory(sourcePath, directory, replaceExisting || undefined, expectedGeneration)
        : expectedGeneration === undefined
          ? await pluginService.installPlugin(sourcePath, replaceExisting || undefined)
          : await pluginService.installPlugin(sourcePath, replaceExisting || undefined, expectedGeneration);
      const installedEntries = snapshot.pluginConfigs.filter(
        entry => previousGenerations.get(entry.id) !== entry.installGeneration,
      );
      // A concurrent install can add another candidate. Never ask the user
      // to approve an arbitrary entry when the response is ambiguous.
      const installedEntry = installedEntries.length === 1 ? installedEntries[0] : undefined;
      const accepted = syncStorePluginConfigs(snapshot);
      if (accepted && useSystemStore.getState().ui.configReady) pluginHost.syncWithConfig(true);
      await refresh();
      notifySuccess('plugins.installed');
      if (!installedEntry) return null;
      return getPluginViews().find(
        plugin => plugin.id === installedEntry.id && plugin.installGeneration === installedEntry.installGeneration,
      ) ?? null;
    } catch (error) {
      // An accepted preparation cancel can never publish or retire capabilities.
      if (directory && extractErrorMessage(error) === INSTALL_CANCELLED) return null;
      if (!replaceExisting && isPluginReplaceConfirmationError(error)) {
        // Expected same/lower-version refusal. Nothing changed on disk; let
        // the caller ask for explicit replacement instead of showing a failure.
        pluginHost.syncWithConfig(true);
        throw error;
      }
      await reconcileMutationFailure();
      console.error('[usePluginList] install failed:', error);
      notifyError(error);
      throw error;
    } finally {
      setLoading(false);
    }
  }, [refresh]);

  const installMarketplacePlugin = useCallback(async (update: MarketplaceUpdate, expectedGeneration?: string): Promise<PluginView | null> => {
    setLoading(true);
    try {
      const snapshot = await pluginService.installMarketplacePlugin(
        update.descriptionUrl,
        update.id,
        update.latestVersion,
        expectedGeneration,
      );
      const installedEntry = snapshot.pluginConfigs.find(
        entry => entry.id === update.id && entry.installGeneration !== expectedGeneration,
      );
      const accepted = syncStorePluginConfigs(snapshot);
      if (accepted && useSystemStore.getState().ui.configReady) pluginHost.syncWithConfig(true);
      await refresh();
      notifySuccess('plugins.installed');
      if (!installedEntry) return null;
      return getPluginViews().find(
        plugin => plugin.id === installedEntry.id && plugin.installGeneration === installedEntry.installGeneration,
      ) ?? null;
    } catch (reason) {
      await reconcileMutationFailure();
      console.error('[usePluginList] marketplace install failed:', reason);
      notifyError(reason);
      throw reason;
    } finally {
      setLoading(false);
    }
  }, [refresh]);

  const reloadPlugin = useCallback((pluginId: string, expectedGeneration: string): Promise<void> =>
    queuePermissionMutation(pluginId, async () => {
      // Re-read inside the queue: a pending mutation may already have replaced
      // the installation the caller reviewed.
      const entry = useAppStore.getState().config.pluginConfigs?.find(plugin => plugin.id === pluginId);
      if (!entry || entry.installGeneration !== expectedGeneration) {
        const error = new Error(`plugin ${pluginId} installation changed; refresh before reloading`);
        notifyError(error);
        throw error;
      }
      if (!entry.enabled) {
        const error = new Error(`plugin ${pluginId} is disabled; enable it before reloading`);
        notifyError(error);
        throw error;
      }
      setLoading(true);
      try {
        // Retire the old code before the backend reload so a fresh session can
        // never be cancelled by the backend's own view/HTTP retirement.
        pluginHost.disable(pluginId);
        const snapshot = await pluginService.reloadPlugin(pluginId, expectedGeneration);
        if (!syncStorePluginConfigs(snapshot)) {
          throw new Error(`plugin ${pluginId} reload response was stale; refresh before relying on it`);
        }
        // Same installation identity: data, grants and web trust are untouched.
        // reload() disables and re-enables the current config entry, resolving
        // once the fresh session start attempt settles (pure-HTML stays Worker-free).
        await pluginHost.reload(pluginId);
        // Re-read the installed manifest/code listings before remounting views.
        await refreshSnapshot();
        await reloadPluginViews(pluginId);
        notifySuccess('plugins.reloaded');
      } catch (error) {
        await reconcileMutationFailure();
        console.error('[usePluginList] reload failed:', error);
        notifyError(error);
        throw error;
      } finally {
        setLoading(false);
      }
    }), [refreshSnapshot]);

  const applyPermissionReview = useCallback(({ plugin, intent, permissions, trustWeb }: PluginPermissionDecision): Promise<void> => queuePermissionMutation(plugin.id, async () => {
    setLoading(true);
    let mutationAttempted = false;
    try {
      const refreshed = await refreshSnapshot();
      const current = refreshed.find(candidate => candidate.id === plugin.id);
      const entry = useAppStore.getState().config.pluginConfigs?.find(candidate => candidate.id === plugin.id);
      if (!current || !entry || entry.installGeneration !== plugin.installGeneration || !reviewStillApplies(plugin, {
        ...current, enabled: entry.enabled, grantedPermissions: entry.grantedPermissions, trustedWebGranted: entry.trustedWebGranted,
      })) throw new Error('Plugin installation or permissions changed; review the current state again');
      const declared = reviewablePermissions(plugin);
      const previous = effectivePermissions(plugin);
      const requested = [...new Set(permissions)];
      const delta = permissionDelta(previous, requested);
      if (requested.some(permission => !declared.includes(permission)) ||
          intent === 'enable' && (delta.added.length || delta.removed.length)) {
        throw new Error('Plugin review includes unreviewed permission changes');
      }
      const requiresTrust = hasTrustedViews(plugin.manifest) && plugin.trustedWebGranted !== true;
      if (trustWeb && !requiresTrust || intent !== 'manage' && requiresTrust && !trustWeb) {
        throw new Error('Trusted webpages require separate consent before enabling this plugin');
      }
      const acceptSnapshot = (snapshot: Awaited<ReturnType<typeof pluginService.setPluginPermissions>>) => {
        if (!syncStorePluginConfigs(snapshot)) throw new Error('Plugin review response was stale; review the current state again');
      };
      const generation = plugin.installGeneration;
      // Trust and regular grants are separate durable mutations; reconcile if
      // a later step fails. No implicit grant is made by the enable command.
      if (trustWeb) {
        mutationAttempted = true;
        acceptSnapshot(await pluginService.setPluginTrustedWeb(plugin.id, true, generation));
      }
      if (delta.added.length || delta.removed.length) {
        mutationAttempted = true;
        acceptSnapshot(await pluginService.setPluginPermissions(plugin.id, requested, generation));
      }
      if (intent !== 'manage') {
        mutationAttempted = true;
        acceptSnapshot(await pluginService.setPluginEnabled(plugin.id, true, generation));
      }
      if (!mutationAttempted) return;
      await refresh();
      notifySuccess(intent === 'manage' ? 'plugins.permissionsSaved' : 'plugins.enabled');
    } catch (error) {
      if (mutationAttempted) await reconcileMutationFailure();
      console.error('[usePluginList] permission review failed:', error);
      notifyError(error);
      throw error;
    } finally {
      setLoading(false);
    }
  }), [refresh, refreshSnapshot]);

  const uninstallPlugin = useCallback((pluginId: string, expectedGeneration: string) => queuePermissionMutation(pluginId, async () => {
    const entry = useAppStore.getState().config.pluginConfigs?.find(plugin => plugin.id === pluginId);
    if (!expectedGeneration || entry?.installGeneration !== expectedGeneration) {
      notifyError(new Error(`plugin ${pluginId} installation changed; review the current version before uninstalling`));
      return;
    }
    setLoading(true);
    try {
      // Retire only the Worker belonging to the installation the user reviewed.
      pluginHost.disable(pluginId);
      const snapshot = await pluginService.uninstallPlugin(pluginId, expectedGeneration);
      syncStorePluginConfigs(snapshot);
      notifySuccess('plugins.uninstalled');
      await refresh();
    } catch (error) {
      await reconcileMutationFailure();
      console.error('[usePluginList] uninstall failed:', error);
      notifyError(error);
    } finally {
      setLoading(false);
    }
  }), [refresh]);

  const setEnabled = useCallback((pluginId: string, enabled: boolean, expectedGeneration: string) => queuePermissionMutation(pluginId, async () => {
    try {
      const snapshot = await pluginService.setPluginEnabled(pluginId, enabled, expectedGeneration);
      if (!syncStorePluginConfigs(snapshot)) throw new Error('Plugin enable or disable response was stale; review the current state again');
      notifySuccess(enabled ? 'plugins.enabled' : 'plugins.disabled');
      await refresh();
    } catch (error) {
      await reconcileMutationFailure();
      console.error('[usePluginList] setEnabled failed:', error);
      notifyError(error);
    }
  }), [refresh]);
  const revokeTrustedWeb = useCallback((pluginId: string, expectedGeneration: string): Promise<void> => queuePermissionMutation(pluginId, async () => {
    const entry = useAppStore.getState().config.pluginConfigs?.find(plugin => plugin.id === pluginId);
    if (!expectedGeneration || entry?.installGeneration !== expectedGeneration) {
      notifyError(new Error('Plugin installation changed; review the current version before revoking webpage trust'));
      return;
    }
    setLoading(true);
    pluginHost.disable(pluginId);
    try {
      const snapshot = await pluginService.setPluginTrustedWeb(pluginId, false, expectedGeneration);
      syncStorePluginConfigs(snapshot);
      await refresh();
    } catch (error) {
      await reconcileMutationFailure();
      notifyError(error);
      throw error;
    } finally {
      setLoading(false);
    }
  }), [refresh]);

  const clearWebData = useCallback((pluginId: string, expectedGeneration: string): Promise<void> => queuePermissionMutation(pluginId, async () => {
    const entry = useAppStore.getState().config.pluginConfigs?.find(plugin => plugin.id === pluginId);
    if (!expectedGeneration || entry?.installGeneration !== expectedGeneration) {
      notifyError(new Error('Plugin installation changed; review the current version before clearing webpage data'));
      return;
    }
    setLoading(true);
    pluginHost.disable(pluginId);
    try {
      const disabled = await pluginService.setPluginEnabled(pluginId, false, expectedGeneration);
      syncStorePluginConfigs(disabled);
      const cleared = await pluginService.clearPluginWebData(pluginId, expectedGeneration);
      syncStorePluginConfigs(cleared);
      await refresh();
      notifySuccess('plugins.webDataCleared');
    } catch (error) {
      await reconcileMutationFailure();
      notifyError(error);
      throw error;
    } finally {
      setLoading(false);
    }
  }), [refresh]);

  return { plugins, loading, refresh, installPlugin, installMarketplacePlugin, reloadPlugin, applyPermissionReview, uninstallPlugin, setEnabled, revokeTrustedWeb, clearWebData } satisfies PluginListApi;
}

export interface PluginListApi {
  plugins: PluginView[];
  loading: boolean;
  refresh: () => Promise<PluginView[]>;
  installPlugin: (sourcePath: string, replaceExisting?: boolean, expectedGeneration?: string, directory?: PluginDirectoryInstallRequest) => Promise<PluginView | null>;
  installMarketplacePlugin: (update: MarketplaceUpdate, expectedGeneration?: string) => Promise<PluginView | null>;
  reloadPlugin: (pluginId: string, expectedGeneration: string) => Promise<void>;
  applyPermissionReview: (decision: PluginPermissionDecision) => Promise<void>;
  uninstallPlugin: (pluginId: string, expectedGeneration: string) => Promise<void>;
  setEnabled: (pluginId: string, enabled: boolean, expectedGeneration: string) => Promise<void>;
  revokeTrustedWeb: (pluginId: string, expectedGeneration: string) => Promise<void>;
  clearWebData: (pluginId: string, expectedGeneration: string) => Promise<void>;
}
