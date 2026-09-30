import { invoke } from '@tauri-apps/api/core';
import type { PluginConfigEntry, PluginHttpRequest, PluginHttpResponse, PluginListResponse } from '../types';

export const pluginService = {
  listPlugins: (): Promise<PluginListResponse> => invoke('list_plugins'),
  installPlugin: (sourcePath: string): Promise<PluginConfigEntry[]> => invoke('install_plugin', { sourcePath }),
  uninstallPlugin: (id: string): Promise<PluginConfigEntry[]> => invoke('uninstall_plugin', { id }),
  setPluginEnabled: (id: string, enabled: boolean): Promise<PluginConfigEntry[]> =>
    invoke('set_plugin_enabled', { id, enabled }),
  setPluginPermissions: (id: string, permissions: string[]): Promise<PluginConfigEntry[]> =>
    invoke('set_plugin_permissions', { id, permissions }),
  readPluginAsset: (id: string, relPath: string): Promise<string> =>
    invoke('read_plugin_asset', { id, relPath }),
  writePluginAsset: (id: string, relPath: string, content: string): Promise<void> =>
    invoke('write_plugin_asset', { id, relPath, content }),
  pluginHttp: (pluginId: string, request: PluginHttpRequest): Promise<PluginHttpResponse> =>
    invoke('plugin_http', { pluginId, request }),
  pluginOpenExternal: (pluginId: string, url: string): Promise<void> =>
    invoke('plugin_open_external', { pluginId, url }),
};
