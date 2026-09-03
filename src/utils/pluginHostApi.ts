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
import { pluginService } from '../services/tauri';
import { readText as clipboardReadText, writeText as clipboardWriteText } from '@tauri-apps/plugin-clipboard-manager';
import { sendToPort } from '../hooks/useSerialSend';
import { useAppStore } from '../stores/useAppStore';
import { useToastStore } from '../stores/useToastStore';
import { addPluginRxObserver } from './pluginObserver';
import type { RxDetachedEvent } from './pluginObserver';
import { appendTerminalLine } from './terminal/viewportManager';
import { pluginKv } from './pluginKv';

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

/**
 * 执行一次宿主 API 调用。返回结果（JSON 可序列化）。
 * 权限已在调用前过滤（本层不做权限判断——由 PluginSession 负责，评审 v2 P7）。
 */
export async function executeHostApi(pluginId: string, op: string, args: unknown): Promise<unknown> {
  switch (op) {
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
      const data = requireString(a, 'data');
      const isHex = Boolean(a.isHex);
      const lineEnding = typeof a.lineEnding === 'string' ? a.lineEnding : 'None';
      const bytes = await sendToPort(portId, data, isHex, lineEnding, true); // silent: 插件发送不弹守卫 toast
      return { bytesWritten: bytes };
    }
    case 'fs.read': {
      const rel = requireString(args, 'rel');
      return pluginService.readPluginAsset(pluginId, rel);
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
      await pluginService.pluginOpenExternal(url);
      return null;
    }
    case 'notify': {
      const a = requireObject(args);
      useToastStore.getState().push({
        severity: 'info',
        message: typeof a.body === 'string' ? a.body : String(a.title ?? ''),
        title: typeof a.title === 'string' ? a.title : pluginId,
        durationMs: typeof a.durationMs === 'number' ? a.durationMs : 4000,
      });
      return null;
    }
    case 'log': {
      const a = requireObject(args);
      const level = typeof a.level === 'string' ? a.level : 'info';
      const msg = typeof a.msg === 'string' ? a.msg : String(a.msg ?? '');
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
    case 'rx.onLine':
    case 'ui.panel.append':
    case 'ui.panel.clear':
    case 'ui.panel.export':
      // 这些 op 由宿主装配层经事件通道实现（worker 内无法传回调/直接画 UI），
      // 不经 RPC——防御性拒绝（见装配层 attachRxObserver / usePlugins）。
      throw new Error(`${op} 由宿主装配层提供，不经 RPC`);
    default:
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
    onRxDetached: (e) => {
      session.post({ type: 'rx.detached', payload: e });
      onDetached?.(e);
    },
  });
  return unsubObserver;
}
