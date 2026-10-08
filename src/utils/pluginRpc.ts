/**
 * 插件 RPC 契约 + 权限过滤（issue #17，评审 v2 D3/P7）
 *
 * 纯函数层（无 DOM/worker 依赖，vitest 可测）：
 * - worker → 宿主 API 请求 `{seq, op, args}` + 响应 `{seq, ok, result|error}`。
 * - `filterAllowedOps`：按「插件当前已授予权限」过滤宿主 API 调用——
 *   **调用时校验**（评审 v2 P7：撤销即时生效，worker 内旧引用不因注入时点残留权限）。
 *
 * 权限语义：manifest `permissions` 是「可授予上限」（安装时校验子集）；
 * 本层是执行点——每次 RPC 按当前 grantedPermissions 决定放行/拒绝。
 */


/** 权限点定义：op → 所需权限。无权限要求的 op 用 null（放行）。 */
export interface PermissionMap {
  [op: string]: string | null;
}

/** 宿主 API op → 权限映射（v1 全集；权限粒度见评审 D3）。 */
export const OP_PERMISSIONS: PermissionMap = {
  // 只读端口信息（无需敏感权限——端口列表/状态是 UI 可见信息）
  'ports.list': null,
  'ports.status': null,
  // RX 观察
  // Worker subscriptions use plugin.rx.onLine/onBytes(callback). These RPC names reject callbacks.
  'rx.onLine': 'terminal:read',
  'rx.onBytes': 'rx:bytes',
  // 终端写（旁注行）
  'terminal.append': 'terminal:write',
  // 串口发送（敏感）
  'serial.send': 'serial:send',
  // 资产读写
  'fs.read': 'fs:assets',
  'fs.write': 'fs:storage',
  // 用户经系统对话框显式选择的任意文件读取（死机日志 map 等；对话框即信任边界）。
  // 单列 fs:open——与「仅读自身资产」的 fs:assets 语义分离，避免资产授权隐式升级。
  'fs.openDialog': 'fs:open',
  // 出站（敏感，唯一合法通道）
  'http.request': 'http:request',
  // shell
  'shell.openExternal': 'shell:open',
  // 剪贴板
  'clipboard.readText': 'clipboard',
  'clipboard.writeText': 'clipboard',
  // 通知
  notify: 'notify',
  // 插件私有 KV
  'storage.get': 'storage',
  'storage.set': 'storage',
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
export function checkOpAllowed(op: string, grantedPermissions: string[], args?: unknown): string | null {
  if (!Object.prototype.hasOwnProperty.call(OP_PERMISSIONS, op)) return `未知 API: ${op}`;
  if (op === 'fs.read') {
    // data/ is private storage; other package files require fs:assets.
    // Malformed paths must fail before checking either grant.
    const rel = args && typeof args === 'object' && !Array.isArray(args) && 'rel' in args
      ? args.rel : undefined;
    if (typeof rel !== 'string' || !rel) return '插件资产路径无效';
    const segments = rel.replace(/\\/g, '/').split('/').filter((part) => part && part !== '.');
    if (segments.includes('..')) return '插件资产路径无效';
    const required = segments[0] === 'data' ? 'fs:storage' : 'fs:assets';
    return grantedPermissions.includes(required) ? null : `插件未授予 ${required} 权限`;
  }
  const required = OP_PERMISSIONS[op];
  if (required === null) return null;
  return grantedPermissions.includes(required)
    ? null
    : `插件未授予 ${required} 权限（当前授予: ${grantedPermissions.join(', ') || '无'}）`;
}

/** 敏感权限集（设计 D3：首次启用时确认框列出并说明风险）。 */
export const SENSITIVE_PERMISSIONS: readonly string[] = [
  'serial:send',
  'http:request',
  'shell:open',
];

/**
 * serial.send 的 per-port 作用域校验（评审 v2 P10，manifest `serial.portWhitelist`）。
 * 语义与后端 HttpScope 一致：声明且非空 → 仅白名单端口；声明为空数组 → 全拒；
 * 未声明 → 不做端口作用域（`serial:send` 授权与 sendGuard 守卫仍然生效）。
 *
 * **执行点在桥侧 `serial.send` 调用路径上、`sendToPort` 之前**——插件触达串口的
 * 唯一通道就是 RPC 桥（worker 零特权，无 invoke），宿主内部的 TX 回显/触发回复
 * 不经过本函数也不需要（宿主是可信方）。
 */
export function checkPortScope(
  manifest: { serial?: { portWhitelist: string[] } } | null | undefined,
  portId: string,
): string | null {
  if (!manifest) return '插件 manifest 不可用，端口作用域无法验证';
  const whitelist = manifest.serial?.portWhitelist;
  if (whitelist === undefined) return null;
  if (!Array.isArray(whitelist)) return 'serial.portWhitelist 无效';
  if (whitelist.length === 0) return 'serial.portWhitelist 为空数组，全部端口拒绝';
  if (!whitelist.includes(portId)) {
    return `端口 ${portId} 不在插件 serial.portWhitelist 内（${whitelist.join(', ')}）`;
  }
  return null;
}
