/**
 * 插件 RPC 契约 + 权限过滤（issue #17，评审 v2 D3/P7）
 *
 * 纯函数层（无 DOM/worker 依赖，vitest 可测）：
 * - RPC 消息类型（宿主 ↔ worker 双向 `{seq, op, args}` + 响应 `{seq, ok, result|error}`）
 * - `filterAllowedOps`：按「插件当前已授予权限」过滤宿主 API 调用——
 *   **调用时校验**（评审 v2 P7：撤销即时生效，worker 内旧引用不因注入时点残留权限）。
 *
 * 权限语义：manifest `permissions` 是「可授予上限」（安装时校验子集）；
 * 本层是执行点——每次 RPC 按当前 grantedPermissions 决定放行/拒绝。
 */

/** 宿主 → worker 的 API 调用请求。 */
export interface HostRequest {
  seq: number;
  op: string;
  args?: unknown;
}

/** worker → 宿主 的响应。 */
export interface HostResponse {
  seq: number;
  ok: boolean;
  /** ok=true 时的结果。 */
  result?: unknown;
  /** ok=false 时的错误串（进 diaglog / 插件 reject）。 */
  error?: string;
}

/** worker → 宿主的异步事件/请求（插件主动发起：事件订阅等）。 */
export interface PluginEvent {
  type: string;
  payload?: unknown;
}

/** 权限点定义：op → 所需权限。无权限要求的 op 用 null（放行）。 */
export interface PermissionMap {
  [op: string]: string | null;
}

/** 宿主 API op → 权限映射（v1 全集；权限粒度见评审 D3）。 */
export const OP_PERMISSIONS: PermissionMap = {
  // 只读端口信息（无需敏感权限——端口列表/状态是 UI 可见信息）
  'ports.list': null,
  'ports.status': null,
  'ports.onChange': null,
  // RX 观察
  'rx.onLine': 'terminal:read',
  'rx.getBuffer': 'terminal:read',
  // 终端写（旁注行）
  'terminal.append': 'terminal:write',
  // 串口发送（敏感）
  'serial.send': 'serial:send',
  // 资产读写
  'fs.read': 'fs:assets',
  'fs.list': 'fs:assets',
  'fs.write': 'fs:storage',
  // 出站（敏感，唯一合法通道）
  'http.request': 'http:request',
  // shell
  'shell.openExternal': 'shell:open',
  'shell.execute': 'shell:execute',
  // 剪贴板
  'clipboard.readText': 'clipboard',
  'clipboard.writeText': 'clipboard',
  // 通知
  notify: 'notify',
  // 插件私有 KV
  'storage.get': 'storage',
  'storage.set': 'storage',
  // 事件
  'events.on': 'events',
  'events.emit': 'events',
  // 日志（放行——diaglog 自带配额）
  log: null,
  // UI（放行——面板是插件自己的输出区，权限模型核心是「零 DOM」，面板写不越权）
  'ui.panel.append': null,
  'ui.panel.clear': null,
  'ui.panel.export': null,
};

/**
 * 按已授予权限过滤一次 op 调用。
 * @returns 错误串（拒绝原因）或 null（放行）。
 */
export function checkOpAllowed(op: string, grantedPermissions: string[]): string | null {
  const required = OP_PERMISSIONS[op];
  if (required === undefined) {
    return `未知 API: ${op}`;
  }
  if (required === null) {
    return null; // 无权限要求
  }
  return grantedPermissions.includes(required)
    ? null
    : `插件未授予 ${required} 权限（当前授予: ${grantedPermissions.join(', ') || '无'}）`;
}

/** 权限过滤矩阵（测试用）：给定授予集，断言哪些 op 放行/拒绝。 */
export function filterAllowedOps(
  ops: string[],
  grantedPermissions: string[],
): { allowed: string[]; denied: string[] } {
  const allowed: string[] = [];
  const denied: string[] = [];
  for (const op of ops) {
    if (checkOpAllowed(op, grantedPermissions) === null) {
      allowed.push(op);
    } else {
      denied.push(op);
    }
  }
  return { allowed, denied };
}
