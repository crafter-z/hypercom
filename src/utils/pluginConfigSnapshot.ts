import { useAppStore } from '../stores/useAppStore';
import type { PluginConfigEntry } from '../types';

// Main-window plugin list fetches may resolve after a later authorization change.
// A completed mutation invalidates every earlier list read, across both host and settings hooks.
let mutationGeneration = 0;

export function pluginMutationGeneration(): number {
  return mutationGeneration;
}

export function syncStorePluginConfigs(entries: PluginConfigEntry[]): void {
  mutationGeneration++;
  useAppStore.getState().setConfig({ pluginConfigs: entries });
}
