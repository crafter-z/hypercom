/** Worker shell.execute driver. The user grants this capability, not a program sandbox. */
import { pluginService } from '../services/tauri';
import { useAppStore } from '../stores/useAppStore';
import type { PluginShellRequest, PluginShellResult } from '../types';

function shellString(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.includes('\0')) {
    throw new Error(`shell.execute ${name} 必须为${allowEmpty ? '' : '非空'}字符串且不含 NUL`);
  }
  return value;
}

/** Validate wire types and OS string representation only; do not impose business quotas. */
export function parsePluginShellRequest(args: unknown): PluginShellRequest {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('shell.execute 参数必须是对象');
  }
  const a = args as Record<string, unknown>;
  for (const key of Object.keys(a)) {
    if (!['program', 'args', 'cwd', 'env', 'stdin', 'timeoutMs'].includes(key)) {
      throw new Error(`shell.execute 不支持参数 ${key}`);
    }
  }
  const request: PluginShellRequest = { program: shellString(a.program, 'program') };
  if (a.args !== undefined) {
    if (!Array.isArray(a.args)) throw new Error('shell.execute args 必须为字符串数组');
    request.args = Array.from(a.args, (arg, index) => shellString(arg, `args[${index}]`, true));
  }
  if (a.cwd !== undefined) request.cwd = shellString(a.cwd, 'cwd');
  if (a.env !== undefined) {
    if (a.env === null || typeof a.env !== 'object' || Array.isArray(a.env)) {
      throw new Error('shell.execute env 必须为字符串键值对象');
    }
    request.env = Object.fromEntries(Object.entries(a.env).map(([name, value]) => {
      if (!name || name.includes('=') || name.includes('\0')) {
        throw new Error('shell.execute env 名称不得为空或包含 = / NUL');
      }
      return [name, shellString(value, `env.${name}`, true)];
    }));
  }
  if (a.stdin !== undefined) {
    // stdin is data, not an OS argument: NUL is a valid UTF-8 input byte.
    if (typeof a.stdin !== 'string') throw new Error('shell.execute stdin 必须为字符串');
    request.stdin = a.stdin;
  }
  if (a.timeoutMs !== undefined) {
    if (typeof a.timeoutMs !== 'number' || !Number.isSafeInteger(a.timeoutMs) || a.timeoutMs < 0) {
      throw new Error('shell.execute timeoutMs 必须为非负安全整数毫秒');
    }
    request.timeoutMs = a.timeoutMs;
  }
  return request;
}

export async function executePluginShell(
  pluginId: string,
  args: unknown,
  beforeSend?: () => void,
): Promise<PluginShellResult> {
  const request = parsePluginShellRequest(args);
  beforeSend?.();
  const entry = useAppStore.getState().config.pluginConfigs?.find(item => item.id === pluginId);
  if (!entry?.enabled || !entry.installGeneration || !entry.grantedPermissions.includes('shell:execute')) {
    throw new Error('插件未启用或未授予 shell:execute');
  }
  const generation = entry.installGeneration;
  const result = await pluginService.pluginShellExecute(pluginId, generation, request);
  beforeSend?.();
  const current = useAppStore.getState().config.pluginConfigs?.find(item => item.id === pluginId);
  if (!current?.enabled || current.installGeneration !== generation ||
    !current.grantedPermissions.includes('shell:execute')) {
    throw new Error('插件执行权限或安装代次已变化');
  }
  return result;
}
