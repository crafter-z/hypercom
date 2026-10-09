import { useAppStore } from '../stores/useAppStore';
import type { PluginConfigEntry, PluginView } from '../types';

// Only completed mutating commands invalidate an in-flight read. A list response
// is a read snapshot and must not cancel another consumer's identical read.
let mutationGeneration = 0;
let pluginViews: PluginView[] = [];
const viewListeners = new Set<() => void>();

export function pluginMutationGeneration(): number {
  return mutationGeneration;
}

export function syncStorePluginConfigs(entries: PluginConfigEntry[]): void {
  mutationGeneration++;
  useAppStore.getState().setConfig({ pluginConfigs: entries });
}

/** Publish a read snapshot shared by the host and the settings page. */
export function syncPluginListSnapshot(plugins: PluginView[], entries: PluginConfigEntry[]): void {
  pluginViews = plugins;
  useAppStore.getState().setConfig({ pluginConfigs: entries });
  for (const listener of viewListeners) listener();
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
  mutationGeneration = 0;
  pluginViews = [];
  viewListeners.clear();
}
