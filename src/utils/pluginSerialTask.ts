import {
  PLUGIN_SERIAL_TASK_WINDOW_BYTES, pluginSerialTaskService,
  type PluginSerialTaskIdentity, type PluginSerialTaskSource, type PluginSerialTaskStep,
} from '../services/pluginSerialTask';
import { useAppStore } from '../stores/useAppStore';
import type { PluginManifestView } from '../types';
import { reserveSerialTask } from './flowRuntime';
import { checkPortScope } from './pluginRpc';
import { isSendablePort } from './sendGuard';
import { trafficStats, type PortTrafficLease } from './trafficStats';

const TASK_IDLE_MS = 60_000;
const MAX_RECENT_TASKS = 64;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type PluginSerialTaskStatus = 'starting' | 'running' | 'cancelling' | 'completed' | 'cancelled' | 'disconnected' | 'failed' | 'unknown';
export interface PluginSerialTaskProgress {
  taskId: string;
  portId: string;
  connectionGeneration: number;
  status: PluginSerialTaskStatus;
  /** Confirmed minimum. When status is unknown, an unreplied window may also have been sent. */
  bytesWritten: number;
  totalBytes: number;
  /** Window chosen by the host; may be smaller on a slow serial link. */
  windowBytes?: number;
  message?: string;
}
export type PluginSerialTaskReadSource = (handleId: unknown) => { handleId: string; sessionId: string; size: number };
export type PluginSerialTaskOp = 'serial.beginSend' | 'serial.sendStep' | 'serial.cancelSend';

interface TaskRecord {
  readonly identity: PluginSerialTaskIdentity;
  readonly source: PluginSerialTaskSource;
  readonly release: () => void;
  readonly trafficLease: PortTrafficLease;
  progress: PluginSerialTaskProgress;
  starting: boolean;
  stepping: boolean;
  submittedBegin: boolean;
  cancelled: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
  closing?: Promise<void>;
  finishing?: Promise<PluginSerialTaskProgress>;
}

function asObject(args: unknown): Record<string, unknown> {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid serial task arguments');
  return args as Record<string, unknown>;
}
function only(args: Record<string, unknown>, fields: readonly string[]): void {
  if (Object.keys(args).some(key => !fields.includes(key))) throw new Error('Unexpected serial task arguments');
}
function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid serial task ${label}`);
  return value;
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function trim<K, V>(map: Map<K, V>): void {
  while (map.size > MAX_RECENT_TASKS) map.delete(map.keys().next().value!);
}

/** Own one root Worker epoch. Only this host context can resolve file grants or
 * advance the exact next native window; Worker messages never name a native session. */
export class PluginSerialTaskContext {
  private alive = true;
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly recent = new Map<string, PluginSerialTaskProgress>();
  private readonly preCancelled = new Map<string, true>();
  private readonly unsubscribeConfig: () => void;

  constructor(readonly pluginId: string, readonly installGeneration: string, readonly workerEpoch: number) {
    this.unsubscribeConfig = useAppStore.subscribe((state, previous) => {
      if (state.config.pluginConfigs === previous.config.pluginConfigs || !this.alive || this.tasks.size === 0) return;
      const current = state.config.pluginConfigs?.find(plugin => plugin.id === this.pluginId);
      const serialAllowed = current?.enabled && current.installGeneration === this.installGeneration &&
        current.grantedPermissions.includes('serial:send');
      for (const task of this.tasks.values()) {
        if (!serialAllowed || (task.source.kind === 'file' && !current.grantedPermissions.includes('fs:open'))) {
          void this.cancel(task.identity.taskId);
        }
      }
    });
  }

  execute(
    op: PluginSerialTaskOp, args: unknown, manifest: PluginManifestView | null,
    beforeSend: (() => void) | undefined, readSource?: PluginSerialTaskReadSource,
  ): Promise<PluginSerialTaskProgress | null> {
    const a = asObject(args);
    if (typeof a.taskId !== 'string' || !UUID.test(a.taskId)) throw new Error('Invalid serial task ID');
    if (op === 'serial.cancelSend') {
      only(a, ['taskId']);
      return this.cancel(a.taskId);
    }
    if (!this.alive) throw new Error('Plugin serial task context retired');
    if (op === 'serial.beginSend') return this.begin(a.taskId, a, manifest, beforeSend, readSource);
    only(a, ['taskId', 'bytes']);
    return this.step(a.taskId, a.bytes, manifest, beforeSend);
  }

  private assertAuthority(portId: string, manifest: PluginManifestView | null, beforeSend?: () => void): void {
    beforeSend?.();
    const entry = useAppStore.getState().config.pluginConfigs?.find(plugin => plugin.id === this.pluginId);
    if (!this.alive || !entry?.enabled || entry.installGeneration !== this.installGeneration ||
      !entry.grantedPermissions.includes('serial:send')) throw new Error('Plugin serial send authority retired');
    const denied = checkPortScope(manifest, portId);
    if (denied) throw new Error(denied);
  }

  private connectionMatches(progress: PluginSerialTaskProgress): boolean {
    const port = useAppStore.getState().ports.find(port => port.id === progress.portId);
    return isSendablePort(port) && port.connectionGeneration === progress.connectionGeneration;
  }

  private remember(progress: PluginSerialTaskProgress): PluginSerialTaskProgress {
    this.recent.set(progress.taskId, progress);
    trim(this.recent);
    return { ...progress };
  }

  private async begin(taskId: string, args: Record<string, unknown>, manifest: PluginManifestView | null,
    beforeSend?: () => void, readSource?: PluginSerialTaskReadSource,
  ): Promise<PluginSerialTaskProgress> {
    if (this.tasks.has(taskId) || this.recent.has(taskId)) throw new Error('Serial task ID already used');
    if (typeof args.portId !== 'string' || !args.portId.trim() || args.portId.includes('\0') || args.portId.length > 512) {
      throw new Error('Invalid serial task port ID');
    }
    const portId = args.portId;
    const connectionGeneration = integer(args.expectedConnectionGeneration, 'connection generation');
    this.assertAuthority(portId, manifest, beforeSend);
    let source: PluginSerialTaskSource;
    let totalBytes: number;
    if (args.kind === 'bytes') {
      only(args, ['taskId', 'portId', 'expectedConnectionGeneration', 'kind', 'totalBytes']);
      totalBytes = integer(args.totalBytes, 'length');
      source = { kind: 'bytes', totalBytes };
    } else if (args.kind === 'file' && readSource) {
      only(args, ['taskId', 'portId', 'expectedConnectionGeneration', 'kind', 'handleId']);
      const current = useAppStore.getState().config.pluginConfigs.find(plugin => plugin.id === this.pluginId);
      if (!current?.grantedPermissions.includes('fs:open')) throw new Error('Selected text/file handle authority retired');
      const file = readSource(args.handleId);
      totalBytes = integer(file.size, 'file length');
      source = { kind: 'file', sessionId: file.sessionId, handleId: file.handleId };
    } else {
      throw new Error('Invalid or unavailable serial task source');
    }
    const progress: PluginSerialTaskProgress = { taskId, portId, connectionGeneration, status: 'starting', bytesWritten: 0, totalBytes };
    if (this.preCancelled.delete(taskId)) return this.remember({ ...progress, status: 'cancelled' });
    if (!this.connectionMatches(progress)) return this.remember({ ...progress, status: 'disconnected' });
    const release = reserveSerialTask(portId);
    if (!release) return this.remember({ ...progress, status: 'failed', message: 'Port is occupied by an enhanced flow or another send task' });
    const task: TaskRecord = {
      identity: { pluginId: this.pluginId, expectedGeneration: this.installGeneration, portId, taskId },
      source, release, trafficLease: trafficStats.capture(portId), progress,
      starting: true, stepping: false, submittedBegin: false, cancelled: false,
    };
    this.tasks.set(taskId, task);
    try {
      task.submittedBegin = true;
      const result = await pluginSerialTaskService.begin(task.identity, connectionGeneration, source);
      if (result.totalBytes !== totalBytes || typeof result.connected !== 'boolean') {
        return await this.finish(task, 'failed', 'Serial task source size changed');
      }
      if (!Number.isSafeInteger(result.windowBytes) || result.windowBytes < 1 || result.windowBytes > PLUGIN_SERIAL_TASK_WINDOW_BYTES) {
        return await this.finish(task, 'failed', 'Invalid native serial task window');
      }
      task.progress.windowBytes = result.windowBytes;
      if (task.cancelled || !this.alive) return await this.finish(task, 'cancelled');
      this.assertAuthority(portId, manifest, beforeSend);
      if (!result.connected || !this.connectionMatches(progress)) return await this.finish(task, 'disconnected');
      if (totalBytes === 0) return await this.finish(task, 'completed');
      task.progress.status = 'running';
      this.armIdle(task);
      return { ...task.progress };
    } catch (error) {
      return await this.finish(task, task.cancelled || !this.alive ? 'cancelled' : 'failed', message(error));
    } finally {
      task.starting = false;
    }
  }

  private async step(taskId: string, rawBytes: unknown, manifest: PluginManifestView | null,
    beforeSend?: () => void,
  ): Promise<PluginSerialTaskProgress> {
    const task = this.tasks.get(taskId);
    if (!task) {
      const result = this.recent.get(taskId);
      if (result) return { ...result };
      throw new Error('Serial task is not active');
    }
    if (task.finishing) return task.finishing;
    if (task.starting || task.stepping) throw new Error('Serial task already has an active operation');
    if (task.cancelled) return this.finish(task, 'cancelled');
    try { this.assertAuthority(task.identity.portId, manifest, beforeSend); }
    catch (error) { return this.finish(task, 'cancelled', message(error)); }
    if (!this.connectionMatches(task.progress)) return this.finish(task, 'disconnected');
    const offset = task.progress.bytesWritten;
    const length = Math.min(task.progress.windowBytes ?? PLUGIN_SERIAL_TASK_WINDOW_BYTES, task.progress.totalBytes - offset);
    let bytes: Uint8Array | undefined;
    if (task.source.kind === 'bytes') {
      if (!(rawBytes instanceof Uint8Array) || rawBytes.byteLength !== length) {
        return this.finish(task, 'failed', 'Invalid serial byte window');
      }
      bytes = rawBytes;
    } else if (rawBytes !== undefined) return this.finish(task, 'failed', 'File tasks must use the selected source');
    clearTimeout(task.idleTimer);
    task.stepping = true;
    let result: PluginSerialTaskStep;
    try {
      result = await pluginSerialTaskService.step(task.identity, offset, bytes);
      if (!['written', 'cancelled', 'disconnected', 'failed'].includes(result.outcome) ||
        integer(result.bytesWritten, 'write count') > length || (result.outcome === 'written' && result.bytesWritten !== length)) {
        throw new Error('Invalid serial task step result');
      }
    } catch (error) {
      // Once the IPC is attempted, a failed reply cannot exclude a write. Do
      // not retry the step; preserve only previously confirmed bytes.
      return this.finish(task, 'unknown', message(error));
    } finally {
      task.stepping = false;
    }
    task.progress.bytesWritten += result.bytesWritten;
    if (this.connectionMatches(task.progress)) trafficStats.addTx(task.identity.portId, result.bytesWritten, task.trafficLease);
    if (result.outcome !== 'written') return this.finish(task, result.outcome, result.message);
    if (!this.connectionMatches(task.progress)) return this.finish(task, 'disconnected');
    if (task.progress.bytesWritten === task.progress.totalBytes) return this.finish(task, 'completed');
    if (task.cancelled || !this.alive) return this.finish(task, 'cancelled');
    this.armIdle(task);
    return { ...task.progress };
  }

  private armIdle(task: TaskRecord): void {
    clearTimeout(task.idleTimer);
    // No execution deadline. Only reclaim an abandoned task between steps.
    task.idleTimer = setTimeout(() => { void this.finish(task, 'cancelled', 'Serial send task was idle'); }, TASK_IDLE_MS);
  }

  private closeNative(task: TaskRecord): Promise<void> {
    task.closing ??= pluginSerialTaskService.close(task.identity).catch(() => pluginSerialTaskService.close(task.identity)).catch(error => {
      console.warn('Serial task native cleanup failed:', message(error));
    });
    return task.closing;
  }

  private finish(task: TaskRecord, status: PluginSerialTaskStatus, reason?: string): Promise<PluginSerialTaskProgress> {
    if (task.finishing) return task.finishing;
    clearTimeout(task.idleTimer);
    task.progress.status = status;
    if (reason) task.progress.message = reason;
    task.finishing = (async () => {
      if (task.submittedBegin) await this.closeNative(task);
      task.release();
      if (this.tasks.get(task.identity.taskId) === task) this.tasks.delete(task.identity.taskId);
      return this.remember(task.progress);
    })();
    return task.finishing;
  }

  private async cancel(taskId: string): Promise<PluginSerialTaskProgress | null> {
    const task = this.tasks.get(taskId);
    if (!task) {
      const result = this.recent.get(taskId);
      if (result) return { ...result };
      if (this.alive) { this.preCancelled.set(taskId, true); trim(this.preCancelled); }
      return null;
    }
    if (task.finishing) return task.finishing;
    task.cancelled = true;
    task.progress.status = 'cancelling';
    // A close arriving before native begin cannot cancel the future reservation;
    // begin observes this flag immediately on settlement and closes its lease.
    if (task.starting) return { ...task.progress };
    if (!task.stepping) return this.finish(task, 'cancelled');
    await this.closeNative(task);
    return { ...task.progress };
  }

  stop(): void {
    if (!this.alive) return;
    this.alive = false;
    this.unsubscribeConfig();
    this.preCancelled.clear();
    for (const taskId of this.tasks.keys()) void this.cancel(taskId);
  }
}
