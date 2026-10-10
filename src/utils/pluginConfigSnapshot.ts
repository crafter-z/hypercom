import { useAppStore } from '../stores/useAppStore';
import type { PluginStateSnapshot, PluginListResponse, PluginView } from '../types';
import { pluginKv } from './pluginKv';
import { rebuildPluginUi } from './pluginUiRegistry';

let acceptedRevision = -1;
let pluginViews: PluginView[] = [];
const viewListeners = new Set<() => void>();

/** Never let an older command response revive permissions revoked by a newer commit. */
export function syncStorePluginConfigs(snapshot: PluginStateSnapshot): boolean {
  const state = useAppStore.getState();
  if (snapshot.revision < Math.max(acceptedRevision, state.config.revision ?? -1)) return false;
  for (const previous of state.config.pluginConfigs ?? []) {
    const next = snapshot.pluginConfigs.find((entry) => entry.id === previous.id);
    if (!next || next.installGeneration !== previous.installGeneration) pluginKv.invalidate(previous.id);
  }
  acceptedRevision = snapshot.revision;
  // A stale manifest must not acquire the generation of replacement code.
  pluginViews = pluginViews.flatMap((view) => {
    const entry = snapshot.pluginConfigs.find((plugin) => plugin.id === view.id);
    if (!entry || entry.installGeneration !== view.installGeneration) return [];
    return [{ ...view, enabled: entry.enabled, grantedPermissions: entry.grantedPermissions }];
  });
  state.setConfig({ revision: snapshot.revision, pluginConfigs: snapshot.pluginConfigs });
  rebuildPluginUi(pluginViews);
  for (const listener of viewListeners) listener();
  return true;
}

/** A coherent disk/config read obeys the same ordering as mutation responses. */
export function syncPluginListSnapshot(snapshot: PluginListResponse): boolean {
  if (!syncStorePluginConfigs(snapshot)) return false;
  pluginViews = snapshot.plugins;
  rebuildPluginUi(pluginViews);
  for (const listener of viewListeners) listener();
  return true;
}

export function subscribePluginViews(listener: () => void): () => void {
  viewListeners.add(listener);
  return () => viewListeners.delete(listener);
}

export function getPluginViews(): PluginView[] {
  return pluginViews;
}

/** Test/lifecycle reset for the module singleton. */
export function resetPluginSnapshotForTest(): void {
  acceptedRevision = -1;
  pluginViews = [];
  viewListeners.clear();
}
