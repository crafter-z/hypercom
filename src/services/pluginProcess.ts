import { invoke } from '@tauri-apps/api/core';
import type { PluginShellRequest } from '../types';

export type PluginProcessStream = 'stdout' | 'stderr';
export interface PluginProcessOptions {
  stdout?: 'pipe' | 'discard';
  stderr?: 'pipe' | 'discard';
}
export interface PluginProcessStatus {
  state: 'running' | 'cancelling' | 'exited' | 'cancelled' | 'timed-out' | 'failed';
  exitCode: number | null;
  error: string | null;
}
export interface PluginProcessOwner {
  pluginId: string;
  expectedGeneration: string;
}
export interface PluginProcessSession extends PluginProcessOwner { sessionId: string }
export interface PluginProcessTask extends PluginProcessSession { taskId: string }
export type PluginProcessRead = { kind: 'chunk'; bytes: Uint8Array } | { kind: 'eof' };

type OutputWire = { kind: 'chunk'; base64: string } | { kind: 'eof' };
const MAX_CHUNK_BYTES = 16 * 1024;
function decodeOutput(wire: OutputWire): PluginProcessRead {
  if (wire?.kind === 'eof') return { kind: 'eof' };
  if (wire?.kind !== 'chunk' || typeof wire.base64 !== 'string' || !wire.base64
    || wire.base64.length > Math.ceil(MAX_CHUNK_BYTES / 3) * 4) throw new Error('shell 输出块格式无效');
  const binary = atob(wire.base64);
  if (!binary.length || binary.length > MAX_CHUNK_BYTES) throw new Error('shell 输出块长度无效');
  return { kind: 'chunk', bytes: Uint8Array.from(binary, character => character.charCodeAt(0)) };
}

/** Host-only IPC. Even discarded streams return their own EOF. */
export const pluginProcessService = {
  openSession: (owner: PluginProcessOwner): Promise<string> => invoke('plugin_shell_open_session', { ...owner }),
  start: (session: PluginProcessSession, request: PluginShellRequest, options: PluginProcessOptions): Promise<string> =>
    invoke('plugin_shell_start', { ...session, request, options }),
  async read(task: PluginProcessTask, stream: PluginProcessStream): Promise<PluginProcessRead> {
    return decodeOutput(await invoke<OutputWire>('plugin_shell_read', { ...task, stream }));
  },
  status: (task: PluginProcessTask, wait: boolean): Promise<PluginProcessStatus> => invoke('plugin_shell_status', { ...task, wait }),
  cancel: (task: PluginProcessTask): Promise<PluginProcessStatus> => invoke('plugin_shell_cancel', { ...task }),
  release: (task: PluginProcessTask): Promise<void> => invoke('plugin_shell_release', { ...task }),
  closeSession: (session: PluginProcessSession): Promise<void> => invoke('plugin_shell_close_session', { ...session }),
};
