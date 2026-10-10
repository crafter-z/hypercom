/**
 * 宿主 API 实现层（issue #17，评审 v2 D5/§5 Host API v1）
 *
 * worker 侧 `plugin.api.<op>(args)` → 宿主收到 `{seq, op, args}` → 本层执行
 * 真实宿主能力（Tauri invoke / store 读取 / RX 观察接入）。权限校验发生在
 * 更外层（PluginSession 的调用时过滤）——本层只实现「有权限后做什么」。
 *
 * 实现原则：
 * - 每个 op 一个 async 函数，输入 args（插件传入），输出 JSON 可序列化结果
 *   （postMessage 结构化克隆）。
 * - 不信任插件参数：形状校验/边界钳制在此层（宿主侧最后防线）。
 * - 串口 RX 行经 pluginObserver 旁路总线接入（`rx.onLine` 订阅注册在
 *   pluginObserver 装配层，不在此层重复实现）。
 */
import { pluginService, fileService } from '../services/tauri';
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
import { checkPortScope, OP_PERMISSIONS } from './pluginRpc';
import { PluginLogQuota } from './pluginLogQuota';
import type { PluginManifestView } from '../types';
import { exportPluginPanel } from './pluginPanelExport';
import { executePluginViewApi } from './pluginViewRuntime';

/** 插件可见的端口摘要（避免把内部字段全量暴露给插件）。 */
export interface PluginPortView {
  id: string;
  name: string;
  status: string;
  type: string;
  mode?: string;
  baudRate?: number;
}

function portView(port: {
  id: string;
  name: string;
  status: string;
  type: string;
  mode?: string;
  baudRate?: number;
}): PluginPortView {
  return {
    id: port.id,
    name: port.name,
    status: port.status,
    type: port.type,
    mode: port.mode,
    baudRate: port.baudRate,
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

/**
 * 执行一次宿主 API 调用。返回结果（JSON 可序列化）。
 * 权限已在调用前过滤（本层不做权限判断——由 PluginSession 负责，评审 v2 P7）。
 * `manifest` 是该插件的 wire 视图（PluginSession 启动时缓存）——port/URL 作用域
 * 校验（P10）在此消费；manifest 不可得时按 null 处理（作用域声明不存在 = 不限制）。
 */
export async function executeHostApi(
  pluginId: string,
  op: string,
  args: unknown,
  manifest: PluginManifestView | null = null,
): Promise<unknown> {
  switch (op) {
    case 'view.publish':
    case 'view.sendSerial':
    case 'tabs.open':
    case 'tabs.activate':
    case 'tabs.close':
    case 'tabs.setTitle':
    case 'tabs.list':
      return executePluginViewApi(pluginId, op, args, manifest);
    case 'ports.list': {
      const ports = useAppStore.getState().ports;
      return ports.map(portView);
    }
    case 'ports.status': {
      const id = requireString(args, 'portId');
      const port = useAppStore.getState().ports.find((p) => p.id === id);
      return port ? portView(port) : null;
    }
    case 'terminal.append': {
      const a = requireObject(args);
      const portId = requireString(a, 'portId');
      const text = requireString(a, 'text');
      appendTerminalLine(portId, {
        timestamp: Date.now(),
        direction: 'NOTE', // 旁注行（非 TX——不进流量统计/发送历史，评审 v2 P9）
        content: text,
        isHex: false,
      });
      return null;
    }
    case 'serial.send': {
      const a = requireObject(args);
      const portId = requireString(a, 'portId');
      // per-port 作用域（评审 v2 P10）：manifest `serial.portWhitelist` 调用时
      // 校验——在 sendToPort **之前**拒绝；插件触达串口的唯一通道就是本桥
      // （worker 零特权无 invoke），宿主内部 TX 路径不经此、无需校验。
      const scopeDenied = checkPortScope(manifest, portId);
      if (scopeDenied) throw new Error(scopeDenied);
      const data = requireString(a, 'data');
      const isHex = Boolean(a.isHex);
      const lineEnding = typeof a.lineEnding === 'string' ? a.lineEnding : 'None';
      const bytes = await sendToPort(portId, data, isHex, lineEnding, true); // silent: 插件发送不弹守卫 toast
      return { bytesWritten: bytes };
    }
    case 'fs.openDialog': {
      const a = requireObject(args);
      const encoding = typeof a.encoding === 'string' && a.encoding !== '' ? a.encoding : 'utf-8';
      const filters = Array.isArray(a.filters) ? (a.filters as { name: string; extensions: string[] }[]) : undefined;
      const multiple = Boolean(a.multiple);
      const selected = await fileService.pickPluginFiles(pluginId, {
        multiple, filters, title: typeof a.title === 'string' ? a.title : undefined,
      });
      return {
        files: selected.files.map(({ path, base64 }: { path: string; base64: string }) => {
          const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
          return { path, content: new TextDecoder(encoding).decode(bytes) };
        }),
      };
    }
    case 'fs.read': {
      const rel = requireString(args, 'rel');
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
      const content = await pluginService.readPluginAsset(pluginId, rel);
      if (content === null) throw new Error('plugin file not found');
      return content;
    }
    case 'fs.write': {
      const a = requireObject(args);
      const rel = requireString(a, 'rel');
      const content = requireString(a, 'content');
      await pluginService.writePluginAsset(pluginId, rel, content);
      return null;
    }
    case 'http.request': {
      const a = requireObject(args);
      const method = requireString(a, 'method');
      const url = requireString(a, 'url');
      const headers =
        typeof a.headers === 'object' && a.headers !== null
          ? (a.headers as Record<string, string>)
          : {};
      const body = typeof a.body === 'string' ? a.body : undefined;
      const timeout = typeof a.timeout === 'number' ? a.timeout : undefined;
      return pluginService.pluginHttp(pluginId, { method, url, headers, body, timeout });
    }
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
      const msg = typeof a.msg === 'string' ? a.msg : String(a.msg ?? '');
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
      await clipboardWriteText(requireString(args, 'text'));
      return null;
    }
    case 'storage.get': {
      return pluginKv.get(pluginId, requireString(args, 'key'));
    }
    case 'storage.set': {
      const a = requireObject(args);
      await pluginKv.set(pluginId, requireString(a, 'key'), a.value);
      return null;
    }
    case 'ui.panel.append': {
      const a = requireObject(args);
      const text = typeof a.text === 'string' ? a.text : String(a.text ?? '');
      appendPluginPanel(pluginId, text);
      return null;
    }
    case 'ui.panel.clear': {
      clearPluginPanel(pluginId);
      return null;
    }
    case 'ui.panel.export': {
      await exportPluginPanel(pluginId, getPluginPanelSnapshot()[pluginId]?.buffer ?? '');
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
