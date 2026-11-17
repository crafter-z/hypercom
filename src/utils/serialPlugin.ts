/** Strict Worker serial lifecycle facade. Authorization mapping stays in pluginRpc. */
import { serialService } from '../services/tauri';
import type {
  PluginSerialCloseRequest,
  PluginSerialCloseResult,
  PluginSerialOpenResult,
  PluginSerialPort,
} from '../services/serial';
import type { SerialPort } from '../types';
import { useAppStore } from '../stores/useAppStore';
import {
  closeSerialConnection,
  openSerialConnection,
  type SerialConnectionParams,
} from './serialConnectionRuntime';

export type { PluginSerialCloseRequest, PluginSerialCloseResult, PluginSerialOpenResult, PluginSerialPort } from '../services/serial';
export interface PluginSerialOpenRequest {
  portId: string;
  params?: Partial<SerialConnectionParams>;
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} 必须为对象`);
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${name} 不支持参数 ${key}`);
}

function portId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error('serial portId 必须为非空且不含 NUL 的字符串');
  return value;
}

function integer(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} 必须为 ${minimum}..${maximum} 的安全整数`);
  return value;
}

function enumeration<T extends string | number>(value: unknown, name: string, allowed: readonly T[]): T {
  if (!allowed.includes(value as T)) throw new Error(`${name} 取值无效`);
  return value as T;
}

/** Validate shape/enums/native numeric representation; never clamp plugin input. */
export function parsePluginSerialOpenRequest(args: unknown): PluginSerialOpenRequest {
  const a = object(args, 'serial.open');
  keys(a, ['portId', 'params'], 'serial.open');
  const request: PluginSerialOpenRequest = { portId: portId(a.portId) };
  if (a.params === undefined) return request;
  const p = object(a.params, 'serial.open params');
  keys(p, ['baudRate', 'dataBits', 'parity', 'stopBits', 'handshake', 'dtr', 'rts', 'cols', 'rows'], 'serial.open params');
  const params: Partial<SerialConnectionParams> = {};
  if (p.baudRate !== undefined) params.baudRate = integer(p.baudRate, 'baudRate', 1, 0xffff_ffff);
  if (p.dataBits !== undefined) params.dataBits = enumeration(p.dataBits, 'dataBits', [5, 6, 7, 8] as const);
  if (p.parity !== undefined) params.parity = enumeration(p.parity, 'parity', ['None', 'Even', 'Odd'] as const);
  if (p.stopBits !== undefined) params.stopBits = enumeration(p.stopBits, 'stopBits', ['One', 'Two'] as const);
  if (p.handshake !== undefined) params.handshake = enumeration(p.handshake, 'handshake', ['None', 'XonXoff', 'RequestToSend', 'RequestToSendXonXoff'] as const);
  for (const field of ['dtr', 'rts'] as const) {
    if (p[field] !== undefined) {
      if (typeof p[field] !== 'boolean') throw new Error(`${field} 必须为布尔值`);
      params[field] = p[field];
    }
  }
  if (p.cols !== undefined) params.cols = integer(p.cols, 'cols', 1, 0xffff);
  if (p.rows !== undefined) params.rows = integer(p.rows, 'rows', 1, 0xffff);
  request.params = params;
  return request;
}

export function parsePluginSerialCloseRequest(args: unknown): PluginSerialCloseRequest {
  const a = object(args, 'serial.close');
  keys(a, ['portId', 'expectedConnectionGeneration'], 'serial.close');
  return {
    portId: portId(a.portId),
    expectedConnectionGeneration: integer(a.expectedConnectionGeneration, 'expectedConnectionGeneration', 0, Number.MAX_SAFE_INTEGER),
  };
}

/** Anchor the request to its original install, not whichever plugin exists later. */
function pluginAuthority(pluginId: string, beforeSend?: () => void): { generation: string; assert: () => void } {
  beforeSend?.();
  const entry = useAppStore.getState().config.pluginConfigs?.find(item => item.id === pluginId);
  if (!entry?.enabled || !entry.installGeneration || !entry.grantedPermissions.includes('serial:control')) throw new Error('插件未启用或未授予 serial:control');
  const generation = entry.installGeneration;
  const assert = () => {
    beforeSend?.();
    const current = useAppStore.getState().config.pluginConfigs?.find(item => item.id === pluginId);
    if (!current?.enabled || current.installGeneration !== generation || !current.grantedPermissions.includes('serial:control')) throw new Error('插件串口权限或安装代次已变化');
  };
  return { generation, assert };
}

/** Native discovery may complete before the three-second frontend port poll. */
function pluginPort(port: PluginSerialPort): PluginSerialPort {
  const mode = useAppStore.getState().ports.find(item => item.id === port.id)?.mode;
  return mode ? { ...port, mode } : port;
}

function runtimePort(port: PluginSerialPort): SerialPort {
  return {
    id: port.id, name: port.name, isHidden: false,
    status: port.status === 'connected' || port.status === 'connecting' || port.status === 'error' ? port.status : 'disconnected',
    type: port.type === 'sim' || port.type === 'virtual' ? port.type : 'real',
    mode: port.mode === 'tty' ? 'tty' : 'trx',
    baudRate: port.baudRate,
    connectionGeneration: port.status === 'connected' ? port.connectionGeneration : undefined,
  };
}

export async function executePluginSerialOpen(pluginId: string, args: unknown, beforeSend?: () => void): Promise<PluginSerialOpenResult> {
  const request = parsePluginSerialOpenRequest(args);
  const authority = pluginAuthority(pluginId, beforeSend);
  const completed = await openSerialConnection<PluginSerialOpenResult>(request.portId, {
    allowUnknownPort: true,
    readPort: value => runtimePort(value.port),
    background: true,
    invokeWhenConnected: true,
    params: request.params,
    assertAuthority: authority.assert,
    perform: (params) => {
      const { portId: id, ...connectionParams } = params;
      return serialService.pluginSerialOpen(pluginId, authority.generation, { portId: id, params: connectionParams });
    },
    readResult: value => ({ result: value.result, connectionGeneration: value.connectionGeneration, baudRate: value.port.baudRate }),
  });
  if (completed.value === undefined) throw new Error('插件串口打开未返回结果');
  return { ...completed.value, port: pluginPort(completed.value.port) };
}

export async function executePluginSerialClose(pluginId: string, args: unknown, beforeSend?: () => void): Promise<PluginSerialCloseResult> {
  const request = parsePluginSerialCloseRequest(args);
  const authority = pluginAuthority(pluginId, beforeSend);
  const completed = await closeSerialConnection<PluginSerialCloseResult>(request.portId, {
    allowUnknownPort: true,
    readPort: value => runtimePort(value.port),
    assertAuthority: authority.assert,
    perform: () => serialService.pluginSerialClose(pluginId, authority.generation, request),
    readResult: value => value.result,
  });
  if (completed.value === undefined) throw new Error('插件串口关闭未返回结果');
  return { ...completed.value, port: pluginPort(completed.value.port) };
}
