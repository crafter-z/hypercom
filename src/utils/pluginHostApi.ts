/**
 * 宿主 API 实现层（issue #17，评审 v2 D5/§5 Host API v1）
 *
 * worker 侧 `plugin.api.<op>(args)` → 宿主收到 `{seq, op, args}` → 本层执行
 * 真实宿主能力（Tauri invoke / store 读取 / RX 观察接入）。权限校验发生在
 * 更外层（PluginSession 的调用时过滤）——本层只实现「有权限后做什么」。
 *
 * 实现原则：
 * - 每个 op 一个 async 函数，输入 args（插件传入），输出结构化克隆结果；
 *   二进制文件用 Uint8Array，RPC 回复转移其底层缓冲区。
 * - 不信任插件参数：形状校验/边界钳制在此层（宿主侧最后防线）。
 * - 串口 RX 行经 pluginObserver 旁路总线接入（`rx.onLine` 订阅注册在
 *   pluginObserver 装配层，不在此层重复实现）。
 */
import { pluginService, fileService, serialService } from '../services/tauri';
import { readText as clipboardReadText, writeText as clipboardWriteText } from '@tauri-apps/plugin-clipboard-manager';
import { sendToPort } from '../hooks/useSerialSend';
import { useAppStore } from '../stores/useAppStore';
import { useToastStore } from '../stores/useToastStore';
import { addPluginRxObserver } from './pluginObserver';
import type { RxDetachedEvent } from './pluginObserver';
import { appendTerminalLine } from './terminal/viewportManager';
import { pluginKv } from './pluginKv';
import { appendPluginPanel, clearPluginPanel, getPluginPanelSnapshot } from './pluginPanelRegistry';
import { addPluginBytesObserver } from './pluginBytesObserver';
import { checkOpAllowed, checkPortScope, OP_PERMISSIONS } from './pluginRpc';
import { PluginLogQuota } from './pluginLogQuota';
import type { PluginManifestView } from '../types';
import { exportPluginPanel } from './pluginPanelExport';
import { executePluginViewApi } from './pluginViewRuntime';
import { executePluginHttp } from './pluginHttp';
import { executePluginShell } from './pluginShell';
import { executePluginSerialOpen, executePluginSerialClose } from './serialPlugin';
import { acquirePluginDialog } from './pluginDialogBudget';
import { decodeBytes } from './lineText';
import type { PluginFsContext } from './pluginFs';
import { requirePluginFsPath } from './pluginFsPath';
import { MAX_PLUGIN_FS_BATCH_BYTES, MAX_PLUGIN_FS_RANGE_BYTES, MAX_PLUGIN_FS_RANGES } from '../services/pluginFs';
import type { PluginFsPriority, PluginFsRange } from '../services/pluginFs';

/** 插件可见的端口摘要（避免把内部字段全量暴露给插件）。 */
export interface PluginPortView {
  id: string;
  name: string;
  status: string;
  type: string;
  mode?: string;
  baudRate?: number;
  /** Authoritative native generation; close uses this as a CAS, not as port identity. */
  connectionGeneration: number;
}

function portView(port: {
  id: string;
  name: string;
  status: string;
  type: string;
  mode?: string;
  baudRate?: number;
  /** Authoritative native generation; close uses this as a CAS, not as port identity. */
  connectionGeneration: number;
}): PluginPortView {
  return {
    id: port.id,
    name: port.name,
    status: port.status,
    type: port.type,
    // Display mode is host UI metadata; native remains authoritative for status/CAS.
    mode: useAppStore.getState().ports.find(item => item.id === port.id)?.mode ?? port.mode,
    baudRate: port.baudRate,
    connectionGeneration: port.connectionGeneration,
  };
}

/** notify 的 level → toast severity 映射（设计 §5 notify({level})）。 */
function notifySeverity(level: unknown): 'info' | 'warning' | 'error' {
  if (level === 'warn' || level === 'warning') return 'warning';
  if (level === 'error') return 'error';
  return 'info';
}

/** 每插件日志配额实例（P13：令牌桶，见 pluginLogQuota.ts）。 */
const logQuotas = new Map<string, PluginLogQuota>();

/** Host-side payload bounds: Tauri deserializes arguments in Rust before the
 *  backend's own checks, so a granted plugin must not be able to push an
 *  unbounded string through the worker→host IPC bridge. */
const MAX_TERMINAL_APPEND_CHARS = 64 * 1024;
const MAX_SERIAL_SEND_CHARS = 1024 * 1024;
const MAX_LOG_MESSAGE_CHARS = 64 * 1024;
const MAX_PANEL_APPEND_CHARS = 64 * 1024;
/** Structural IPC bounds for native file-dialog options (not file quotas). */
export const MAX_PLUGIN_DIALOG_FILTERS = 32;
export const MAX_PLUGIN_DIALOG_FILTER_NAME_CHARS = 128;
export const MAX_PLUGIN_DIALOG_EXTENSIONS = 64;
export const MAX_PLUGIN_DIALOG_EXTENSION_CHARS = 128;
export const MAX_PLUGIN_DIALOG_TITLE_CHARS = 256;
export const MAX_PLUGIN_ENCODING_CHARS = 64;
export const MAX_PLUGIN_GRANT_ID_CHARS = 128;
const MAX_PLUGIN_REL_CHARS = 4096;
const PLUGIN_LINE_ENDINGS = new Set(['None', '\\r', '\\n', '\\r\\n']);

function requireMaxChars(value: string, field: string, max: number): string {
  if (value.length > max) throw new Error(`参数 ${field} 超过 ${max} 字符上限`);
  return value;
}

/** 目录授权句柄（宿主签发，插件只能原样带回）。 */
function requireGrantId(args: unknown): string {
  return requireMaxChars(requireString(args, 'grantId'), 'grantId', MAX_PLUGIN_GRANT_ID_CHARS);
}

/** 文本解码编码；缺省 utf-8，与 fs.openDialog 的编码规则一致。 */
function pluginEncoding(args: Record<string, unknown>): string {
  return typeof args.encoding === 'string' && args.encoding !== ''
    ? requireMaxChars(args.encoding, 'encoding', MAX_PLUGIN_ENCODING_CHARS)
    : 'utf-8';
}

/**
 * Single sanitizer for text that ends up in host logs/diagnostics: control
 * characters and newlines are replaced so a plugin cannot forge extra log lines,
 * then the result is truncated to a bounded length.
 */
export function cleanHostText(value: string, maximum = 500): string {
  return value.replace(/[\r\n\u0000-\u001f]/g, ' ').slice(0, maximum);
}

function binaryFileFormat(args: Record<string, unknown>): boolean {
  if (args.format === undefined || args.format === 'text') return false;
  if (args.format === 'binary') return true;
  throw new Error('文件 format 必须为 text 或 binary');
}

/** 可选布尔参数：未提供保持 undefined（Rust 侧落默认值）；提供则必须是布尔。 */
function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`参数 ${field} 必须为布尔值`);
  return value;
}

/** 目录写入 mode 白名单（缺省由 Rust 侧落 overwrite）。 */
function directoryWriteMode(value: unknown): 'overwrite' | 'append' | undefined {
  if (value === undefined) return undefined;
  if (value === 'overwrite' || value === 'append') return value;
  throw new Error('目录写入 mode 必须为 overwrite 或 append');
}

type PluginDialogFilter = { name: string; extensions: string[] };

function dialogFilters(value: unknown): PluginDialogFilter[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('文件 filters 必须为数组');
  if (value.length > MAX_PLUGIN_DIALOG_FILTERS) {
    throw new Error(`文件 filters 数量超过 ${MAX_PLUGIN_DIALOG_FILTERS} 上限`);
  }
  return value.map((item, index) => {
    const filter = requireObject(item);
    const name = requireMaxChars(requireString(filter, 'name'), `filters[${index}].name`, MAX_PLUGIN_DIALOG_FILTER_NAME_CHARS);
    const extensions = filter.extensions;
    if (!Array.isArray(extensions) || extensions.length > MAX_PLUGIN_DIALOG_EXTENSIONS) {
      throw new Error(`文件 filters[${index}].extensions 数量非法`);
    }
    return {
      name,
      extensions: extensions.map((extension, extensionIndex) => {
        if (typeof extension !== 'string' || extension.length === 0 || extension.length > MAX_PLUGIN_DIALOG_EXTENSION_CHARS) {
          throw new Error(`文件 filters[${index}].extensions[${extensionIndex}] 长度非法`);
        }
        return extension;
      }),
    };
  });
}

function fileBytes(base64: string): Uint8Array {
  const decoded = atob(base64);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index++) bytes[index] = decoded.charCodeAt(index);
  return bytes;
}

/**
 * 执行一次宿主 API 调用。返回结构化克隆结果（文件二进制为 Uint8Array）。
 * PluginSession 调用前/交付前过滤权限；等待中的副作用通过 beforeSend/live facade 复核。
 * `manifest` 是该插件启动时的 wire 视图，串口作用域在本层消费并于控制入 lane 时复核；
 * 缺少 manifest 时不能验证串口作用域，按拒绝处理。原生层仍执行权威授权和路径/CAS 检查。
 */
export async function executeHostApi(
  pluginId: string,
  op: string,
  args: unknown,
  manifest: PluginManifestView | null = null,
  beforeSend?: () => void,
  fsContext?: PluginFsContext,
): Promise<unknown> {
  switch (op) {
    case 'fs.readRange':
    case 'fs.readRanges':
    case 'fs.listDirectoryPage':
    case 'fs.cancel': {
      const a = requireObject(args);
      const requestId = requireString(a, 'requestId');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
        throw new Error('plugin FS requestId 无效');
      }
      if (!fsContext || fsContext.pluginId !== pluginId) throw new Error('plugin FS context unavailable');
      if (op === 'fs.cancel') return fsContext.cancel(requestId);
      const priority = pluginFsPriority(a.priority);
      const assertAuthority = (): void => {
        beforeSend?.();
        const config = useAppStore.getState().config.pluginConfigs?.find(entry => entry.id === pluginId);
        if (!config?.enabled || config.installGeneration !== fsContext.installGeneration) throw new Error('plugin disabled');
        const denied = checkOpAllowed(op, config.grantedPermissions, a);
        if (denied) throw new Error(denied);
      };
      if (op === 'fs.listDirectoryPage') {
        const grantId = requireGrantId(a);
        const relPath = a.rel === undefined ? undefined : requirePluginFsPath(requireText(a, 'rel'), true);
        const recursive = optionalBoolean(a.recursive, 'recursive');
        const cursor = a.cursor === undefined ? undefined : requireMaxChars(requireString(a, 'cursor'), 'cursor', 4096);
        const limit = a.limit === undefined ? undefined : requireSafeInteger(a.limit, 'limit', 1, 1000);
        return fsContext.listDirectoryPage(requestId, { grantId, relPath, recursive, cursor, limit, priority }, assertAuthority);
      }
      const ranges = op === 'fs.readRange' ? [pluginFsRange(a)] : pluginFsRanges(a.ranges);
      // Validate every range and authorize the entire batch before opening a native session.
      assertAuthority();
      return op === 'fs.readRange'
        ? fsContext.readRange(requestId, ranges[0], priority, assertAuthority)
        : fsContext.readRanges(requestId, ranges, priority, assertAuthority);
    }
    case 'view.publish':
    case 'view.sendSerial':
    case 'view.sendBinary':
    case 'tabs.open':
    case 'tabs.activate':
    case 'tabs.close':
    case 'tabs.setTitle':
    case 'tabs.list':
      return executePluginViewApi(pluginId, op, args, manifest, beforeSend);
    case 'ports.list':
    case 'ports.status': {
      const entry = useAppStore.getState().config.pluginConfigs?.find(item => item.id === pluginId);
      if (!entry?.enabled || !entry.installGeneration) throw new Error('plugin disabled');
      const generation = entry.installGeneration;
      const assertAuthority = (): void => {
        beforeSend?.();
        const current = useAppStore.getState().config.pluginConfigs?.find(item => item.id === pluginId);
        if (!current?.enabled || current.installGeneration !== generation) throw new Error('plugin disabled');
      };
      assertAuthority();
      if (op === 'ports.list') {
        const ports = await serialService.pluginSerialList(pluginId, generation);
        assertAuthority();
        return ports.map(portView);
      }
      const portId = requireString(args, 'portId');
      const port = await serialService.pluginSerialStatus(pluginId, generation, portId);
      assertAuthority();
      return port ? portView(port) : null;
    }
    case 'terminal.append': {
      const a = requireObject(args);
      const portId = requireString(a, 'portId');
      const text = requireMaxChars(requireString(a, 'text'), 'text', MAX_TERMINAL_APPEND_CHARS);
      appendTerminalLine(portId, {
        timestamp: Date.now(),
        direction: 'NOTE', // 旁注行（非 TX——不进流量统计/发送历史，评审 v2 P9）
        content: text,
        isHex: false,
      });
      return null;
    }
    case 'serial.open':
    case 'serial.close': {
      const portId = requireString(args, 'portId');
      const assertAuthority = (): void => {
        beforeSend?.();
        const denied = checkPortScope(manifest, portId);
        if (denied) throw new Error(denied);
      };
      assertAuthority();
      return op === 'serial.open'
        ? executePluginSerialOpen(pluginId, args, assertAuthority)
        : executePluginSerialClose(pluginId, args, assertAuthority);
    }
    case 'serial.send': {
      const a = requireObject(args);
      const portId = requireString(a, 'portId');
      // per-port 作用域（评审 v2 P10）：manifest `serial.portWhitelist` 调用时
      // 校验——在 sendToPort **之前**拒绝；插件触达串口的唯一通道就是本桥
      // （worker 零特权无 invoke），宿主内部 TX 路径不经此、无需校验。
      const scopeDenied = checkPortScope(manifest, portId);
      if (scopeDenied) throw new Error(scopeDenied);
      const data = requireMaxChars(requireString(a, 'data'), 'data', MAX_SERIAL_SEND_CHARS);
      if (a.isHex !== undefined && typeof a.isHex !== 'boolean') {
        throw new Error('参数 isHex 必须为布尔值');
      }
      const isHex = a.isHex === true;
      const lineEnding = a.lineEnding === undefined ? 'None' : a.lineEnding;
      if (typeof lineEnding !== 'string' || !PLUGIN_LINE_ENDINGS.has(lineEnding)) {
        throw new Error(`不支持的 lineEnding: ${String(a.lineEnding)}`);
      }
      const bytes = await sendToPort(portId, data, isHex, lineEnding, true, beforeSend); // silent: 插件发送不弹守卫 toast
      return { bytesWritten: bytes };
    }
    case 'fs.openDialog': {
      const a = requireObject(args);
      const binary = binaryFileFormat(a);
      const encoding = pluginEncoding(a);
      const filters = dialogFilters(a.filters);
      if (a.multiple !== undefined && typeof a.multiple !== 'boolean') {
        throw new Error('文件 multiple 必须为布尔值');
      }
      const multiple = a.multiple === true;
      const title = a.title === undefined
        ? undefined
        : requireMaxChars(requireString(a, 'title'), 'title', MAX_PLUGIN_DIALOG_TITLE_CHARS);
      const releaseDialog = acquirePluginDialog(pluginId);
      try {
        const selected = await fileService.pickPluginFiles(pluginId, {
          multiple, filters, title,
        });
        beforeSend?.();
        return {
          files: selected.files.map(({ path, base64 }: { path: string; base64: string }) => {
            const bytes = fileBytes(base64);
            return binary ? { path, bytes } : { path, content: decodeBytes(bytes, encoding) };
          }),
        };
      } finally {
        releaseDialog();
      }
    }
    case 'fs.exportFile': {
      const a = requireObject(args);
      requireOnlyFields(a, ['grantId', 'rel', 'content', 'bytes'], op);
      const grantId = requireGrantId(a);
      const rel = requirePluginFsPath(requireString(a, 'rel'));
      const normalized = rel.replace(/\\/g, '/');
      const parts = normalized.split('/').filter(part => part && part !== '.');
      if (!parts.length || normalized.startsWith('/') || /^[a-z]:/i.test(normalized) || parts.includes('..') || rel.includes('\0')) {
        throw new Error('导出 rel 必须为授权目录内的相对路径');
      }
      const { content, base64 } = pluginFilePayload(a, op);
      beforeSend?.();
      const result = await fileService.exportPluginFile(pluginId, grantId, rel, content, base64);
      beforeSend?.();
      return { path: result.path, bytesWritten: result.bytesWritten };
    }
    case 'fs.saveFile': {
      const a = requireObject(args);
      requireOnlyFields(a, ['content', 'bytes', 'options'], op);
      const { content, base64 } = pluginFilePayload(a, op);
      const options = requireObject(a.options ?? {});
      requireOnlyFields(options, ['title', 'defaultFileName', 'filters'], 'fs.saveFile options');
      const title = options.title === undefined ? undefined
        : requireMaxChars(requireString(options, 'title'), 'title', MAX_PLUGIN_DIALOG_TITLE_CHARS);
      const defaultFileName = options.defaultFileName === undefined ? undefined
        : requireMaxChars(requireString(options, 'defaultFileName'), 'defaultFileName', 255);
      if (defaultFileName !== undefined && (defaultFileName === '.' || defaultFileName === '..' || /[\\/:\u0000-\u001f\u007f]/.test(defaultFileName))) {
        throw new Error('defaultFileName 必须为文件名，不能包含目录路径');
      }
      const filters = dialogFilters(options.filters);
      if (title !== undefined && /[\u0000-\u001f\u007f]/.test(title)) throw new Error('Save As title 不能包含控制字符');
      if (filters?.some(filter => filter.extensions.some(extension => /[\\/:\u0000-\u001f\u007f]/.test(extension)))) {
        throw new Error('Save As filters 扩展名不能包含路径或控制字符');
      }
      const releaseDialog = acquirePluginDialog(pluginId);
      try {
        beforeSend?.();
        const result = await fileService.savePluginFile(pluginId, content, base64, { title, defaultFileName, filters });
        beforeSend?.();
        return result === null ? null : { path: result.path, bytesWritten: result.bytesWritten };
      } finally {
        releaseDialog();
      }
    }
    case 'fs.openDirectoryDialog': {
      const a = requireObject(args ?? {});
      const multiple = optionalBoolean(a.multiple, 'multiple') === true;
      const title = a.title === undefined
        ? undefined
        : requireMaxChars(requireString(a, 'title'), 'title', MAX_PLUGIN_DIALOG_TITLE_CHARS);
      const releaseDialog = acquirePluginDialog(pluginId);
      try {
        const picked = await fileService.pickPluginDirectory(pluginId, { title, multiple });
        // Same post-native revalidation as fs.openDialog: a grant revoked while
        // the user was choosing must not yield the selected directory.
        beforeSend?.();
        // The native command already returns an array (empty on cancel).
        return { directories: picked };
      } finally {
        releaseDialog();
      }
    }
    case 'fs.listDirectory': {
      const a = requireObject(args);
      const grantId = requireGrantId(a);
      let rel: string | undefined;
      if (a.rel !== undefined) {
        if (typeof a.rel !== 'string') throw new Error('参数 rel 必须为字符串');
        rel = requireMaxChars(a.rel, 'rel', MAX_PLUGIN_REL_CHARS);
      }
      const recursive = optionalBoolean(a.recursive, 'recursive');
      const entries = await fileService.listPluginDirectory(pluginId, grantId, rel, recursive);
      // Re-check authority after the native listing, before entries cross the RPC.
      beforeSend?.();
      return {
        entries: entries.map((entry) => ({
          name: entry.name,
          rel: entry.rel,
          kind: entry.kind,
          size: entry.size,
          modifiedMs: entry.modifiedMs,
        })),
      };
    }
    case 'fs.readDirectoryFile': {
      const a = requireObject(args);
      const grantId = requireGrantId(a);
      const rel = requireMaxChars(requireString(a, 'rel'), 'rel', MAX_PLUGIN_REL_CHARS);
      const binary = binaryFileFormat(a);
      const encoding = pluginEncoding(a);
      const { path, bytes } = await fileService.readPluginDirectoryBytes(pluginId, grantId, rel);
      // Re-check authority after the native read, before content crosses the RPC.
      beforeSend?.();
      return binary ? { path, bytes } : { path, content: decodeBytes(bytes, encoding) };
    }
    case 'fs.statDirectoryEntry': {
      const a = requireObject(args);
      const grantId = requireGrantId(a);
      const rel = requireMaxChars(requireString(a, 'rel'), 'rel', MAX_PLUGIN_REL_CHARS);
      const entry = await fileService.statPluginDirectoryEntry(pluginId, grantId, rel);
      // Re-check authority after the native stat, before metadata crosses the RPC.
      beforeSend?.();
      return {
        name: entry.name,
        rel: entry.rel,
        kind: entry.kind,
        size: entry.size,
        modifiedMs: entry.modifiedMs,
      };
    }
    case 'fs.writeDirectoryFile': {
      const a = requireObject(args);
      const grantId = requireGrantId(a);
      const rel = requireMaxChars(requireString(a, 'rel'), 'rel', MAX_PLUGIN_REL_CHARS);
      const content = a.content;
      const bytes = a.bytes;
      if (content !== undefined && bytes !== undefined) {
        throw new Error('fs.writeDirectoryFile 的 content 与 bytes 互斥');
      }
      let text: string | undefined;
      let base64: string | undefined;
      if (typeof content === 'string') {
        text = content;
      } else if (content === undefined && bytes !== undefined) {
        base64 = bytesToBase64(bytes);
      } else {
        throw new Error('fs.writeDirectoryFile 需要 content 字符串或 bytes 二进制');
      }
      const mode = directoryWriteMode(a.mode);
      const createParents = optionalBoolean(a.createParents, 'createParents');
      const result = await fileService.writePluginDirectoryFile(
        pluginId, grantId, rel, text, base64, mode, createParents,
      );
      // Re-check authority after the native write, before the result crosses the RPC.
      beforeSend?.();
      return { path: result.path, bytesWritten: result.bytesWritten };
    }
    case 'fs.createDirectory': {
      const a = requireObject(args);
      const grantId = requireGrantId(a);
      const rel = requireMaxChars(requireString(a, 'rel'), 'rel', MAX_PLUGIN_REL_CHARS);
      const recursive = optionalBoolean(a.recursive, 'recursive');
      await fileService.createPluginDirectory(pluginId, grantId, rel, recursive);
      // Re-check authority after the native mkdir, before reporting success.
      beforeSend?.();
      return null;
    }
    case 'fs.removeDirectoryEntry': {
      const a = requireObject(args);
      const grantId = requireGrantId(a);
      const rel = requireMaxChars(requireString(a, 'rel'), 'rel', MAX_PLUGIN_REL_CHARS);
      const recursive = optionalBoolean(a.recursive, 'recursive');
      await fileService.removePluginDirectoryEntry(pluginId, grantId, rel, recursive);
      // Re-check authority after the native removal, before reporting success.
      beforeSend?.();
      return null;
    }
    case 'fs.renameDirectoryEntry': {
      const a = requireObject(args);
      const grantId = requireGrantId(a);
      const fromRel = requireMaxChars(requireString(a, 'fromRel'), 'fromRel', MAX_PLUGIN_REL_CHARS);
      const toRel = requireMaxChars(requireString(a, 'toRel'), 'toRel', MAX_PLUGIN_REL_CHARS);
      await fileService.renamePluginDirectoryEntry(pluginId, grantId, fromRel, toRel);
      // Re-check authority after the native rename, before reporting success.
      beforeSend?.();
      return null;
    }
    case 'fs.releaseDirectory': {
      const a = requireObject(args);
      const grantId = requireGrantId(a);
      await fileService.releasePluginDirectory(pluginId, grantId);
      return null;
    }
    case 'fs.read': {
      const a = requireObject(args);
      const binary = binaryFileFormat(a);
      const rel = requireMaxChars(requireString(a, 'rel'), 'rel', 4096);
      const granted = useAppStore.getState().config.pluginConfigs?.find((p) => p.id === pluginId);
      if (!granted?.enabled) throw new Error('plugin disabled');
      const segments = rel.replace(/\\/g, '/').split('/').filter((part) => part && part !== '.');
      if (segments.includes('..')) throw new Error('非法插件路径');
      const isData = segments[0] === 'data';
      if (isData && !granted.grantedPermissions.includes('fs:storage')) {
        throw new Error('插件未授予 fs:storage 权限');
      }
      if (!isData && !granted.grantedPermissions.includes('fs:assets')) {
        throw new Error('插件未授予 fs:assets 权限');
      }
      const content = binary
        ? await pluginService.readPluginAssetBytes(pluginId, rel, granted.installGeneration)
        : await pluginService.readPluginAsset(pluginId, rel);
      beforeSend?.();
      if (content === null) throw new Error('plugin file not found');
      return content;
    }
    case 'fs.write': {
      const a = requireObject(args);
      const rel = requireMaxChars(requireString(a, 'rel'), 'rel', 4096);
      const content = a.content;
      const bytes = a.bytes;
      if (content !== undefined && bytes !== undefined) {
        throw new Error('fs.write 的 content 与 bytes 互斥');
      }
      if (typeof content === 'string') {
        await pluginService.writePluginAsset(pluginId, rel, content);
      } else if (content === undefined && bytes !== undefined) {
        await pluginService.writePluginAsset(pluginId, rel, undefined, bytesToBase64(bytes));
      } else {
        throw new Error('fs.write 需要 content 字符串或 bytes 二进制');
      }
      return null;
    }
    case 'http.request':
    case 'http.open':
    case 'http.read':
    case 'http.cancel':
      return executePluginHttp(pluginId, op, args, beforeSend);
    case 'shell.execute':
      return executePluginShell(pluginId, args, beforeSend);
    case 'shell.openExternal': {
      const url = requireString(args, 'url');
      await pluginService.pluginOpenExternal(pluginId, url);
      return null;
    }
    case 'notify': {
      const a = requireObject(args);
      useToastStore.getState().pushPlugin(pluginId, {
        severity: notifySeverity(a.level),
        message: typeof a.body === 'string' ? a.body : typeof a.title === 'string' ? a.title : '',
        title: typeof a.title === 'string' ? a.title : pluginId,
        durationMs: typeof a.durationMs === 'number' ? a.durationMs : undefined,
      });
      return null;
    }
    case 'log': {
      const a = requireObject(args);
      const level = typeof a.level === 'string' ? a.level : 'info';
      const msg = cleanHostText(
        requireMaxChars(typeof a.msg === 'string' ? a.msg : String(a.msg ?? ''), 'msg', MAX_LOG_MESSAGE_CHARS),
        MAX_LOG_MESSAGE_CHARS,
      );
      // P13 配额：令牌桶限流（突发 20 条 / 回填 4 条每秒），坏插件不再把
      // diaglog 512KB 轮转窗口刷掉；超限丢弃，每 5s 窗口首次丢弃告警一次。
      let quota = logQuotas.get(pluginId);
      if (!quota) {
        quota = new PluginLogQuota();
        logQuotas.set(pluginId, quota);
      }
      const verdict = quota.tryConsume(Date.now());
      if (!verdict.allowed) {
        if (verdict.warn) {
          console.warn(
            `[pluginHost] ${pluginId} log 配额超限，已累计丢弃 ${verdict.droppedTotal} 条`,
          );
        }
        return null;
      }
      // 插件日志进宿主 console（经 setupDiagLogCapture 落 diaglog）；前缀插件 id。
      // eslint-disable-next-line no-console
      console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](
        `[plugin:${pluginId}] ${msg}`,
      );
      return null;
    }
    case 'clipboard.readText': {
      return clipboardReadText();
    }
    case 'clipboard.writeText': {
      await clipboardWriteText(requireText(args, 'text'));
      return null;
    }
    case 'storage.get': {
      return pluginKv.get(pluginId, requireString(args, 'key'));
    }
    case 'storage.set': {
      const a = requireObject(args);
      await pluginKv.set(pluginId, requireString(a, 'key'), a.value, beforeSend);
      return null;
    }
    case 'ui.panel.append': {
      const a = requireObject(args);
      const text = requireMaxChars(typeof a.text === 'string' ? a.text : String(a.text ?? ''), 'text', MAX_PANEL_APPEND_CHARS);
      appendPluginPanel(pluginId, text);
      return null;
    }
    case 'ui.panel.clear': {
      clearPluginPanel(pluginId);
      return null;
    }
    case 'ui.panel.export': {
      await exportPluginPanel(pluginId, getPluginPanelSnapshot()[pluginId]?.buffer ?? '', beforeSend);
      return null;
    }
    case 'rx.onLine':
    case 'rx.onBytes':
      throw new Error('请使用 plugin.rx.onLine/onBytes(callback) 订阅事件');
    default:
      if (Object.prototype.hasOwnProperty.call(OP_PERMISSIONS, op)) {
        throw new Error(`宿主 API 不支持: ${op}`);
      }
      throw new Error(`未知宿主 API: ${op}`);
  }
}

// ==================== 参数校验辅助（宿主侧最后防线） ====================

function requireOnlyFields(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`${field} 含不支持的参数`);
}

/** Whole-file data only: no new content-size quota or implicit text conversion. */
function pluginFilePayload(args: Record<string, unknown>, op: string): { content: string | undefined; base64: string | undefined } {
  if (args.content !== undefined && args.bytes !== undefined) throw new Error(`${op} 的 content 与 bytes 互斥`);
  if (typeof args.content === 'string') return { content: args.content, base64: undefined };
  if (args.content === undefined && args.bytes !== undefined) return { content: undefined, base64: bytesToBase64(args.bytes) };
  throw new Error(`${op} 需要 content 字符串或 bytes 二进制`);
}

function requireSafeInteger(value: unknown, field: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`参数 ${field} 必须为 ${min}..${max} 的安全整数`);
  }
  return value;
}
function pluginFsPriority(value: unknown): PluginFsPriority {
  if (value === undefined) return 'background';
  if (value === 'interactive' || value === 'background') return value;
  throw new Error('参数 priority 必须为 interactive 或 background');
}
function pluginFsRange(value: unknown): PluginFsRange {
  const a = requireObject(value);
  const rel = requirePluginFsPath(requireString(a, 'rel'));
  const grantId = a.grantId === undefined ? undefined : requireGrantId(a);
  const offset = requireSafeInteger(a.offset, 'offset', 0);
  const length = requireSafeInteger(a.length, 'length', 0, MAX_PLUGIN_FS_RANGE_BYTES);
  if (!Number.isSafeInteger(offset + length)) throw new Error('参数 offset + length 超出安全整数范围');
  return { rel, offset, length, ...(grantId === undefined ? {} : { grantId }) };
}
function pluginFsRanges(value: unknown): PluginFsRange[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PLUGIN_FS_RANGES) {
    throw new Error(`参数 ranges 必须为 1..${MAX_PLUGIN_FS_RANGES} 项数组`);
  }
  const ranges = value.map(pluginFsRange);
  if (ranges.reduce((sum, range) => sum + range.length, 0) > MAX_PLUGIN_FS_BATCH_BYTES) {
    throw new Error('参数 ranges 总长度超过 8 MiB');
  }
  return ranges;
}

function requireObject(args: unknown): Record<string, unknown> {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('参数必须是对象');
  }
  return args as Record<string, unknown>;
}

function requireString(args: unknown, field: string): string {
  const obj = requireObject(args);
  const v = obj[field];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`参数 ${field} 必须是非空字符串`);
  }
  return v;
}

/** 字符串字段，允许空串（clipboard.writeText 等空内容写入）。 */
function requireText(args: unknown, field: string): string {
  const obj = requireObject(args);
  const v = obj[field];
  if (typeof v !== 'string') throw new Error(`参数 ${field} 必须为字符串`);
  return v;
}

/** 二进制写入接受 Uint8Array 或 ArrayBuffer（结构化克隆后仍是二者之一）。 */
function bytesToBase64(value: unknown): string {
  let bytes: Uint8Array;
  if (value instanceof Uint8Array) {
    bytes = value;
  } else if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value);
  } else {
    throw new Error('参数 bytes 必须为 Uint8Array 或 ArrayBuffer');
  }
  let binary = '';
  // 分块避免大数组触发 String.fromCharCode 参数上限。
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

/** session.post 签名（transfer 支持 ArrayBuffer 零拷贝）。 */
export type HostPost = (
  m: { type: string; payload?: unknown },
  transfer?: Transferable[],
) => void;

export function attachRxObserver(
  session: {
    post: HostPost;
  },
  onDetached?: (e: RxDetachedEvent) => void,
): () => void {
  const unsubObserver = addPluginRxObserver({
    onRxLines: (lines) => {
      // 批转发给 worker：**结构化克隆**（不带 transfer）。
      //
      // 不能 transfer rawData.buffer：该 Uint8Array 与 rxPipeline 终端路径共享
      // 同一实例——行既进 terminal 队列/TerminalBuffer（渲染时惰性解码），
      // 又被 pluginObserver 原样转发；transfer 会永久 detach 缓冲，使终端所有
      // RX 行渲染为空、同一批的第二个观察者拿到空数据（评审 P12 曾想零拷贝，
      // 但零拷贝必须先 slice 出副本再 transfer——v1 保正确性用结构化克隆，
      // 复制成本在交付路径本就存在；实测高频卡顿再优化）。
      session.post({ type: 'rx.line', payload: lines });
    },
    onRxDropped: (event) => {
      session.post({ type: 'rx.dropped', payload: event });
    },
    onRxDetached: (e) => {
      session.post({ type: 'rx.detached', payload: e });
      onDetached?.(e);
    },
  });
  return unsubObserver;
}

/**
 * 把 pluginBytesObserver 的 RX 原始字节批转发到某插件 worker 事件通道
 * （rx.bytes）。与 attachRxObserver 同构：惰性查会话、字节批投递。
 * 权限（rx:bytes）由装配资格（rxBytesEligiblePluginIds）把关，事件通道按
 * 权限关闸（worker 内代码可重挂 self.onmessage 截获，未授权插件不得收到）。
 *
 * **结构化克隆**（不带 transfer）：字节块 Uint8Array 与新装的 worker 事件通道
 * 独享，但后续插件可能存引用/派生——v1 保正确性，零拷贝留二进制优化。
 */
export function attachBytesObserver(session: { post: HostPost }): () => void {
  return addPluginBytesObserver({
    onRxBytes: (batch) => {
      session.post({ type: 'rx.bytes', payload: batch });
    },
    onRxDropped: (event) => {
      session.post({ type: 'rx.dropped', payload: event });
    },
    onRxDetached: (event) => {
      session.post({ type: 'rx.detached', payload: event });
    },
  });
}
