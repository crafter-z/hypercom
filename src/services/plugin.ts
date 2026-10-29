import { invoke } from '@tauri-apps/api/core';
import type {
  PluginHttpChunk,
  PluginHttpHead,
  PluginHttpRequest,
  PluginListResponse,
  PluginStateSnapshot,
} from '../types';

function assertAssetWriteContent(content: string | undefined, base64: string | undefined): void {
  if ((content === undefined) === (base64 === undefined)) {
    throw new Error('writePluginAsset 需要 content 或 base64 之一');
  }
}

export const pluginService = {
  listPlugins: (): Promise<PluginListResponse> => invoke('list_plugins'),
  installPlugin: (sourcePath: string, replaceExisting?: boolean): Promise<PluginStateSnapshot> =>
    invoke('install_plugin', { sourcePath, replaceExisting }),
  /** Reload installed code in place; preserves installGeneration/consent/data. */
  reloadPlugin: (id: string, expectedGeneration: string): Promise<PluginStateSnapshot> =>
    invoke('reload_plugin', { id, expectedGeneration }),
  uninstallPlugin: (id: string, expectedGeneration: string): Promise<PluginStateSnapshot> =>
    invoke('uninstall_plugin', { id, expectedGeneration }),
  setPluginEnabled: (id: string, enabled: boolean, expectedGeneration: string): Promise<PluginStateSnapshot> =>
    invoke('set_plugin_enabled', { id, enabled, expectedGeneration }),
  setPluginPermissions: (id: string, permissions: string[], expectedGeneration: string): Promise<PluginStateSnapshot> =>
    invoke('set_plugin_permissions', { id, permissions, expectedGeneration }),
  setPluginTrustedWeb: (id: string, trusted: boolean, expectedGeneration: string): Promise<PluginStateSnapshot> =>
    invoke('set_plugin_trusted_web', { id, trusted, expectedGeneration }),
  clearPluginWebData: (id: string, expectedGeneration: string): Promise<PluginStateSnapshot> =>
    invoke('clear_plugin_web_data', { id, expectedGeneration }),
  // Binary responses use base64 on Tauri's JSON wire, decoded before reaching the Worker.
  readPluginAsset: (id: string, relPath: string, format: 'text' | 'binary' = 'text'): Promise<string | null> =>
    invoke('read_plugin_asset', { id, relPath, format }),
  /** Text or raw bytes; content/base64 are mutually exclusive on the wire. */
  writePluginAsset: (id: string, relPath: string, content?: string, base64?: string): Promise<void> => {
    assertAssetWriteContent(content, base64);
    return invoke('write_plugin_asset', { id, relPath, content, base64 });
  },
  pluginHttpOpen: (
    pluginId: string,
    expectedGeneration: string,
    requestId: string,
    request: PluginHttpRequest,
  ): Promise<PluginHttpHead> =>
    invoke('plugin_http_open', { pluginId, expectedGeneration, requestId, request }),
  pluginHttpRead: (pluginId: string, expectedGeneration: string, requestId: string): Promise<PluginHttpChunk> =>
    invoke('plugin_http_read', { pluginId, expectedGeneration, requestId }),
  pluginHttpCancel: (pluginId: string, expectedGeneration: string, requestId: string): Promise<void> =>
    invoke('plugin_http_cancel', { pluginId, expectedGeneration, requestId }),
  pluginOpenExternal: (pluginId: string, url: string): Promise<void> =>
    invoke('plugin_open_external', { pluginId, url }),
};
