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


import { isPluginFsPath } from './pluginFsPath';
import type { PluginSerialTaskOp } from './pluginSerialTask';

export const PLUGIN_SERIAL_TASK_OPS = ['serial.beginSend', 'serial.sendStep', 'serial.cancelSend'] as const satisfies readonly PluginSerialTaskOp[];
export function isPluginSerialTaskOp(op: string): op is PluginSerialTaskOp {
  return (PLUGIN_SERIAL_TASK_OPS as readonly string[]).includes(op);
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
  // 只读宿主能力描述（可选 API 探测）：不访问设备/文件/网络，旧宿主拒绝该 op。
  'host.info': null,
  // RX 观察
  // Worker subscriptions use plugin.rx.onLine/onBytes(callback). These RPC names reject callbacks.
  'rx.onLine': 'terminal:read',
  'rx.onBytes': 'rx:bytes',
  // 终端写（旁注行）
  'terminal.append': 'terminal:write',
  // 串口控制与发送分开授权（敏感）；发送权限不隐式允许打开或关闭。
  'serial.open': 'serial:control',
  'serial.close': 'serial:control',
  'serial.loan.acquire': 'serial:control',
  'serial.loan.heartbeat': 'serial:control',
  'serial.loan.release': 'serial:control',
  'serial.send': 'serial:send',
  'serial.beginSend': 'serial:send',
  'serial.sendStep': 'serial:send',
  'serial.cancelSend': null, // only closes a task owned by this Worker epoch
  // 资产读写
  'fs.read': 'fs:assets',
  'fs.write': 'fs:storage',
  // Range batches are authorized per entry before any entry is read.
  'fs.readRange': null,
  'fs.readRanges': null,
  'fs.listDirectoryPage': 'fs:open-dir',
  // Cleanup must remain reachable even after file permissions are revoked.
  'fs.cancel': null,
  // 用户经系统对话框显式选择的任意文件读取（死机日志 map 等；对话框即信任边界）。
  // 单列 fs:open——与「仅读自身资产」的 fs:assets 语义分离，避免资产授权隐式升级。
  'fs.openDialog': 'fs:open',
  'fs.openFile': 'fs:open',
  'fs.readFileWindow': 'fs:open',
  'fs.createFile': 'fs:save',
  'fs.writeFileChunk': 'fs:save',
  'fs.commitFile': 'fs:save',
  'fs.closeFile': null,
  'fs.cancelFileRequest': null,
  // 最小保存权限：export 仅写入用户选择的目录；save 每次均需原生 Save As。
  'fs.exportFile': 'fs:export-dir',
  'fs.saveFile': 'fs:save',
  // 用户经系统对话框显式选择的目录授权：列表/读取/stat 都限定在该次选择内。
  // 与 fs:open（仅文件）分离——目录授权不得复用任意文件读取权限，反之亦然。
  // openDirectoryDialog 是**唯一**能取得目录根的入口，读/写/最小导出任一目录权限
  // 都可打开选择器（checkOpAllowed 特判）；具体操作另按各自权限校验。
  'fs.openDirectoryDialog': 'fs:open-dir',
  'fs.listDirectory': 'fs:open-dir',
  'fs.readDirectoryFile': 'fs:open-dir',
  'fs.statDirectoryEntry': 'fs:open-dir',
  // 兼容的完整目录修改 API 仍要求 fs:write-dir，不隐式接受只读或最小导出权限。
  'fs.writeDirectoryFile': 'fs:write-dir',
  'fs.createDirectory': 'fs:write-dir',
  'fs.removeDirectoryEntry': 'fs:write-dir',
  'fs.renameDirectoryEntry': 'fs:write-dir',
  // 释放授权是清理动作，不返回任何文件内容 → 无需权限；调用方启用/安装身份
  // 仍由 PluginSession 的 beforeSend 约束。
  'fs.releaseDirectory': null,
  // 出站（敏感，唯一合法通道）。open/read/cancel 是同一请求的拉取原语。
  'http.request': 'http:request',
  'http.open': 'http:request',
  'http.read': 'http:request',
  'http.cancel': 'http:request',
  // shell
  'shell.openExternal': 'shell:open',
  'shell.execute': 'shell:execute',
  'shell.start': 'shell:execute',
  'shell.read': 'shell:execute',
  'shell.status': 'shell:execute',
  'shell.cancel': 'shell:execute',
  'shell.release': 'shell:execute',
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
  'view.publish': 'ui:view',
  'view.sendSerial': 'ui:view',
  'view.sendBinary': 'ui:view',
  'view.pickClientArtifact': 'ui:view',
  'control.jobEvent': null,
  'tabs.open': 'ui:tabs',
  'tabs.activate': 'ui:tabs',
  'tabs.close': 'ui:tabs',
  'tabs.setTitle': 'ui:tabs',
  'tabs.list': 'ui:tabs',
};

/**
 * 按已授予权限过滤一次 op 调用。
 * @returns 错误串（拒绝原因）或 null（放行）。
 */
export function checkOpAllowed(op: string, grantedPermissions: string[], args?: unknown): string | null {
  if (!Object.prototype.hasOwnProperty.call(OP_PERMISSIONS, op)) return `未知 API: ${op}`;
  if (op === 'fs.readRange' || op === 'fs.readRanges') {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return '插件文件参数无效';
    const ranges = op === 'fs.readRange' ? [args] : ('ranges' in args ? args.ranges : undefined);
    if (!Array.isArray(ranges) || ranges.length === 0 || ranges.length > 64) return '插件文件 ranges 无效';
    for (const range of ranges) {
      if (!range || typeof range !== 'object' || Array.isArray(range) || !('rel' in range) ||
        !isPluginFsPath(range.rel)) return '插件文件路径无效';
      const rel: string = range.rel.replace(/\\/g, '/');
      const segments = rel.split('/').filter(part => part && part !== '.');
      if (!segments.length || rel.startsWith('/') || /^[a-z]:/i.test(rel) || segments.includes('..')) return '插件文件路径无效';
      let required: string;
      if ('grantId' in range && range.grantId !== undefined) {
        if (typeof range.grantId !== 'string' || !range.grantId || range.grantId.length > 128) return '插件目录 grantId 无效';
        required = 'fs:open-dir';
      } else required = segments[0] === 'data' ? 'fs:storage' : 'fs:assets';
      if (!grantedPermissions.includes(required)) return `插件未授予 ${required} 权限`;
    }
    return null;
  }
  if (op === 'fs.listDirectoryPage') {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return '插件文件参数无效';
    const rel = 'rel' in args ? args.rel : undefined;
    if (rel !== undefined && !isPluginFsPath(rel, true)) return '插件文件路径无效';
  }
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
  if (op === 'fs.openDirectoryDialog') {
    // The picker is the only way to obtain a directory root. Read, legacy-write,
    // and minimal export grants can each choose a root, never inherit each other.
    if (['fs:open-dir', 'fs:write-dir', 'fs:export-dir'].some(permission => grantedPermissions.includes(permission))) {
      return null;
    }
    return `插件未授予 fs:open-dir、fs:write-dir 或 fs:export-dir 权限（当前授予: ${grantedPermissions.join(', ') || '无'}）`;
  }
  const required = OP_PERMISSIONS[op];
  if (required === null) return null;
  if (!grantedPermissions.includes(required)) return `插件未授予 ${required} 权限（当前授予: ${grantedPermissions.join(', ') || '无'}）`;
  if (op === 'serial.beginSend' && args && typeof args === 'object' && 'kind' in args && args.kind === 'file'
    && !grantedPermissions.includes('fs:open')) return '插件未授予 fs:open 权限';
  return null;
}

/** 敏感权限集（设计 D3：首次启用时确认框列出并说明风险）。 */
export const SENSITIVE_PERMISSIONS: readonly string[] = [
  'serial:control',
  'serial:send',
  'http:request',
  'shell:open',
  'shell:execute',
  'fs:export-dir',
  'fs:save',
  'fs:write-dir',
];

/**
 * serial.open/close/send 的 per-port 作用域校验（manifest `serial.portWhitelist`）。
 * 语义与后端 HttpScope 一致：声明且非空 → 仅白名单端口；声明为空数组 → 全拒；
 * 未声明 → 不做端口作用域（控制/发送的独立授权及 runtime/sendGuard 仍然生效）。
 *
 * 执行点在桥侧 serial.open/close/send 路径、真实副作用之前；控制在入 lane 时复核。
 * Worker 零特权无 invoke，宿主可信的内部 TX/连接路径不需要本插件 manifest 守卫。
 */
export function checkPortScope(
  manifest: { serial?: { portWhitelist: string[] } | null } | null | undefined,
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
