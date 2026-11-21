import { pluginProcessService } from '../services/pluginProcess';
import type { PluginProcessOptions, PluginProcessSession, PluginProcessStream, PluginProcessTask } from '../services/pluginProcess';
import { useAppStore } from '../stores/useAppStore';
import type { PluginShellRequest } from '../types';
import { parsePluginShellRequest } from './pluginShell';

export const PLUGIN_PROCESS_OPS = ['shell.start', 'shell.read', 'shell.status', 'shell.cancel', 'shell.release'] as const;
export type PluginProcessOp = typeof PLUGIN_PROCESS_OPS[number];
export function isPluginProcessOp(op: string): op is PluginProcessOp {
  return (PLUGIN_PROCESS_OPS as readonly string[]).includes(op);
}
export function isPluginProcessCleanupOp(op: string): boolean {
  return op === 'shell.cancel' || op === 'shell.release';
}

const INACTIVE = 'PLUGIN_SHELL_SESSION_INACTIVE:';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function requestObject(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) {
    throw new Error('shell 流请求格式无效');
  }
  return value as Record<string, unknown>;
}
function parseOptions(value: unknown): PluginProcessOptions {
  if (value === undefined) return {};
  const args = requestObject(value, ['stdout', 'stderr']);
  const options: PluginProcessOptions = {};
  for (const key of ['stdout', 'stderr'] as const) {
    const mode = args[key];
    if (mode === undefined) continue;
    if (mode !== 'pipe' && mode !== 'discard') throw new Error(`shell ${key} 须为 pipe 或 discard`);
    options[key] = mode;
  }
  return options;
}

/** One per PluginSession worker epoch. Never adopt another worker's native session. */
export class PluginProcessContext {
  private stopped = false;
  private session: PluginProcessSession | null = null;
  private opening: Promise<PluginProcessSession> | null = null;
  private readonly tasks = new Map<string, 'active' | 'releasing'>();

  constructor(private readonly pluginId: string, private readonly installGeneration: string) {}

  private check(beforeSend?: () => void): void {
    beforeSend?.();
    if (this.stopped) throw new Error('shell 流会话已停止');
    const entry = useAppStore.getState().config.pluginConfigs.find(item => item.id === this.pluginId);
    if (!entry?.enabled || entry.installGeneration !== this.installGeneration || !entry.grantedPermissions.includes('shell:execute')) {
      throw new Error('插件执行权限或安装代次已变化');
    }
  }

  private async getSession(): Promise<PluginProcessSession> {
    if (this.session) return this.session;
    if (!this.opening) {
      const owner = { pluginId: this.pluginId, expectedGeneration: this.installGeneration };
      this.opening = pluginProcessService.openSession(owner).then(sessionId => {
        const session = { ...owner, sessionId };
        try { this.check(); }
        catch (error) {
          void pluginProcessService.closeSession(session).catch(() => {});
          throw error;
        }
        this.session = session;
        return session;
      }).finally(() => { this.opening = null; });
    }
    return this.opening;
  }

  private checkSession(session: PluginProcessSession, beforeSend?: () => void): void {
    this.check(beforeSend);
    if (this.session !== session) throw new Error('shell 流会话已失效');
  }

  private async request<T>(session: PluginProcessSession, send: () => Promise<T>): Promise<T> {
    try { return await send(); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.session === session && message.startsWith(INACTIVE)) {
        // Invalidation must not replay a possibly side-effecting start. Only
        // a future explicit start may lazily obtain a new session.
        this.session = null;
        this.tasks.clear();
      }
      throw error;
    }
  }

  async start(request: PluginShellRequest, options: PluginProcessOptions, beforeSend?: () => void): Promise<{ taskId: string }> {
    this.check(beforeSend);
    const session = await this.getSession();
    this.checkSession(session, beforeSend);
    const taskId = await this.request(session, () => pluginProcessService.start(session, request, options));
    try { this.checkSession(session, beforeSend); }
    catch (error) {
      // Spawn succeeded but this request/epoch retired before delivery.
      void pluginProcessService.release({ ...session, taskId }).catch(() => {});
      throw error;
    }
    this.tasks.set(taskId, 'active');
    return { taskId };
  }

  async taskOperation(op: Exclude<PluginProcessOp, 'shell.start'>, taskId: string, options: { stream?: PluginProcessStream; wait?: boolean }, beforeSend?: () => void): Promise<unknown> {
    this.check(beforeSend);
    const session = this.session;
    if (!session || this.tasks.get(taskId) !== 'active') throw new Error('shell 流任务已失效');
    const task: PluginProcessTask = { ...session, taskId };
    if (op === 'shell.release') {
      this.tasks.set(taskId, 'releasing');
      try { await this.request(session, () => pluginProcessService.release(task)); }
      catch (error) {
        if (this.session === session) this.tasks.set(taskId, 'active');
        throw error;
      }
      if (this.session === session) this.tasks.delete(taskId);
      this.checkSession(session, beforeSend);
      return;
    }
    const result = await this.request<unknown>(session, () => {
      if (op === 'shell.read') return pluginProcessService.read(task, options.stream!);
      if (op === 'shell.status') return pluginProcessService.status(task, options.wait === true);
      return pluginProcessService.cancel(task);
    });
    this.checkSession(session, beforeSend);
    if (this.tasks.get(taskId) !== 'active') throw new Error('shell 流任务已失效');
    return result;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    const session = this.session;
    this.session = null;
    this.tasks.clear();
    if (session) void pluginProcessService.closeSession(session).catch(() => {});
    // A still-opening session is reclaimed by its own completion handler.
  }
}

export async function executePluginProcessApi(context: PluginProcessContext, op: PluginProcessOp, args: unknown, beforeSend?: () => void): Promise<unknown> {
  if (op === 'shell.start') {
    const values = requestObject(args, ['request', 'options']);
    return context.start(parsePluginShellRequest(values.request), parseOptions(values.options), beforeSend);
  }
  const values = requestObject(args, ['taskId', ...(op === 'shell.read' ? ['stream'] : op === 'shell.status' ? ['wait'] : [])]);
  if (typeof values.taskId !== 'string' || !UUID.test(values.taskId)) throw new Error('shell 流任务标识无效');
  const options: { stream?: PluginProcessStream; wait?: boolean } = {};
  if (op === 'shell.read') {
    if (values.stream !== 'stdout' && values.stream !== 'stderr') throw new Error('shell 流名称无效');
    options.stream = values.stream;
  }
  if (op === 'shell.status') {
    if (values.wait !== undefined && typeof values.wait !== 'boolean') throw new Error('shell 任务 wait 须为布尔值');
    options.wait = values.wait === true;
  }
  return context.taskOperation(op, values.taskId, options, beforeSend);
}
