import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { PluginNativeMessage, PluginViewBinding, PluginViewRect } from '../types/pluginViews';

export const pluginViewService = {
  create: (binding: PluginViewBinding): Promise<void> => invoke('create_plugin_view', { binding }),
  update: (instanceId: string, rect: PluginViewRect, visible: boolean, layoutRevision: number): Promise<void> =>
    invoke('update_plugin_view', { instanceId, rect, visible, layoutRevision }),
  send: (instanceId: string, message: unknown): Promise<void> =>
    invoke('send_plugin_view_message', { instanceId, message }),
  destroy: (instanceId: string): Promise<void> => invoke('destroy_plugin_view', { instanceId }),
  onMessage: (callback: (message: PluginNativeMessage) => void): Promise<() => void> =>
    listen<PluginNativeMessage>('plugin:view-message', (event) => callback(event.payload)),
};
