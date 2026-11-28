import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { RemoteViewSessionDto } from './control';
import type { PluginNativeMessage, PluginViewBinding, PluginViewHostMessage, PluginViewRect, PluginViewportRect } from '../types/pluginViews';

export const pluginViewService = {
  create: (binding: PluginViewBinding): Promise<void> => invoke('create_plugin_view', { binding }),
  createProjected: (binding: PluginViewBinding, session: RemoteViewSessionDto): Promise<void> =>
    invoke('create_projected_plugin_view', { binding, session }),
  update: (instanceId: string, rect: PluginViewRect, visible: boolean, layoutRevision: number, occlusions: PluginViewportRect[] = []): Promise<void> =>
    invoke('update_plugin_view', { instanceId, rect, visible, layoutRevision, occlusions }),
  send: (instanceId: string, message: PluginViewHostMessage): Promise<void> =>
    invoke('send_plugin_view_message', { instanceId, message }),
  destroy: (instanceId: string): Promise<void> => invoke('destroy_plugin_view', { instanceId }),
  onMessage: (callback: (message: PluginNativeMessage) => void): Promise<() => void> =>
    listen<PluginNativeMessage>('plugin:view-message', (event) => callback(event.payload)),
};
