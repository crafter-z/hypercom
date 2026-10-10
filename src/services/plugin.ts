import { invoke } from '@tauri-apps/api/core';
import type { PluginStateSnapshot, PluginHttpRequest, PluginHttpResponse, PluginListResponse } from '../types';

export const pluginService = {
  listPlugins: (): Promise<PluginListResponse> => invoke('list_plugins'),
  installPlugin: (sourcePath: string): Promise<PluginStateSnapshot> => invoke('install_plugin', { sourcePath }),
  uninstallPlugin: (id: string): Promise<PluginStateSnapshot> => invoke('uninstall_plugin', { id }),
  setPluginEnabled: (id: string, enabled: boolean, expectedGeneration: string): Promise<PluginStateSnapshot> =>
    invoke('set_plugin_enabled', { id, enabled, expectedGeneration }),
  setPluginPermissions: (id: string, permissions: string[], expectedGeneration: string): Promise<PluginStateSnapshot> =>
    invoke('set_plugin_permissions', { id, permissions, expectedGeneration }),
  readPluginAsset: (id: string, relPath: string): Promise<string | null> =>
    invoke('read_plugin_asset', { id, relPath }),
  writePluginAsset: (id: string, relPath: string, content: string): Promise<void> =>
    invoke('write_plugin_asset', { id, relPath, content }),
  pluginHttp: (pluginId: string, request: PluginHttpRequest): Promise<PluginHttpResponse> =>
    invoke('plugin_http', { pluginId, request }),
  pluginOpenExternal: (pluginId: string, url: string): Promise<void> =>
    invoke('plugin_open_external', { pluginId, url }),
};
