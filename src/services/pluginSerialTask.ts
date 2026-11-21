import { invoke } from '@tauri-apps/api/core';

export const PLUGIN_SERIAL_TASK_WINDOW_BYTES = 64 * 1024;
export type PluginSerialTaskSource =
  | { kind: 'bytes'; totalBytes: number }
  | { kind: 'file'; sessionId: string; handleId: string };
export interface PluginSerialTaskIdentity {
  pluginId: string;
  expectedGeneration: string;
  portId: string;
  taskId: string;
}
export interface PluginSerialTaskBegun {
  totalBytes: number;
  connected: boolean;
  windowBytes: number;
}
export interface PluginSerialTaskStep {
  outcome: 'written' | 'cancelled' | 'disconnected' | 'failed';
  bytesWritten: number;
  message?: string;
}

export const pluginSerialTaskService = {
  begin(identity: PluginSerialTaskIdentity, connectionGeneration: number, source: PluginSerialTaskSource): Promise<PluginSerialTaskBegun> {
    return invoke('plugin_serial_task_begin', { ...identity, connectionGeneration, source });
  },
  step(identity: PluginSerialTaskIdentity, offset: number, bytes?: Uint8Array): Promise<PluginSerialTaskStep> {
    // Only one bounded window crosses this IPC, byte-for-byte. The selected
    // file path supplies its bytes natively and never crosses the bridge.
    return invoke('plugin_serial_task_step', { ...identity, offset, bytes: bytes ? Array.from(bytes) : null });
  },
  close(identity: PluginSerialTaskIdentity): Promise<void> {
    return invoke('plugin_serial_task_close', { ...identity });
  },
};
