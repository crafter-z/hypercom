/**
 * pluginHttp — 插件 HTTP 宿主侧驱动（open/read/cancel 拉取式，无总大小/总时限）。
 *
 * Worker 侧 `plugin.api['http.request']` 由本模块把完整请求拆成原生
 * open → read* → done 的拉取循环，并累积**完整**响应；`plugin.http.stream`
 * 在桥内直接用 `http.open/read/cancel` 暴露 AsyncIterable<Uint8Array>。
 *
 * 契约要点：
 * - 无任意总响应大小上限、无宿主 RPC 截止时间；`timeout` 由调用方显式给出
 *   （缺省/0 = 无总 deadline），原生侧执行。
 * - 请求 ID 由 Worker 在 open 之前生成（UUID），因此连接尚未建立时 abort
 *   也能命中；宿主侧为每个 ID 绑定 plugin + 安装代次。
 * - `cancelPluginHttp(pluginId)` 只取消该插件当前登记的请求；旧代次的
 *   取消不会命中换代后新生成的 ID。
 * - 二进制请求体编码为 bodyBase64，响应按块解码成 Uint8Array（可转移）。
 */
import { pluginService } from '../services/tauri';
import { useAppStore } from '../stores/useAppStore';
import { decodeBytes } from './lineText';
import type {
  PluginHttpHead,
  PluginHttpRedirect,
  PluginHttpRequest,
  PluginHttpResponse,
} from '../types';

/** Concurrent native requests per plugin — protects runtime resources, not content. */
const MAX_ACTIVE_REQUESTS_PER_PLUGIN = 64;
/** Cancel-before-open tombstones retained per plugin (bounded, FIFO). */
const MAX_CANCEL_TOMBSTONES = 64;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const REDIRECTS: readonly PluginHttpRedirect[] = ['follow', 'manual', 'error'];

interface ActiveRequest {
  pluginId: string;
  generation: string;
  requestId: string;
  cancelled: boolean;
}

const activeRequests = new Map<string, ActiveRequest>();
/** requestId cancelled before/without a registered request, keyed plugin+id. */
const cancelledBeforeOpen = new Map<string, true>();

function requestKey(pluginId: string, requestId: string): string {
  return `${pluginId}\u0000${requestId}`;
}

function abortError(): Error {
  const error = new Error('plugin HTTP request aborted');
  error.name = 'AbortError';
  return error;
}

function normalizeRequestId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !REQUEST_ID_PATTERN.test(value)) {
    throw new Error('plugin HTTP requestId 无效');
  }
  return value;
}

function generationFor(pluginId: string, beforeSend?: () => void): string {
  // Admission authority (enabled + install generation + permission) lives in the host.
  beforeSend?.();
  const config = useAppStore.getState().config.pluginConfigs?.find((entry) => entry.id === pluginId);
  if (!config?.enabled) throw new Error('plugin disabled');
  return config.installGeneration;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  // Chunked to keep String.fromCharCode argument counts bounded.
  const chunkSize = 0x8000;
  let binary = '';
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function toUint8Array(value: unknown, field: string): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new Error(`plugin HTTP ${field} 必须是 Uint8Array 或 ArrayBuffer`);
}

interface ParsedOptions {
  requestId?: string;
  responseType: 'text' | 'binary';
  wire: PluginHttpRequest;
}

/** Validate Worker options and split Worker-only fields from the native wire. */
function parseOptions(args: unknown, allowResponseType: boolean): ParsedOptions {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('plugin HTTP 参数必须是对象');
  }
  const a = args as Record<string, unknown>;
  if (typeof a.url !== 'string' || a.url.length === 0) throw new Error('plugin HTTP url 必须是非空字符串');
  if (a.method !== undefined && typeof a.method !== 'string') throw new Error('plugin HTTP method 必须是字符串');
  let headers: Record<string, string> | undefined;
  if (a.headers !== undefined) {
    if (a.headers === null || typeof a.headers !== 'object' || Array.isArray(a.headers)) {
      throw new Error('plugin HTTP headers 必须是对象');
    }
    headers = {};
    for (const [name, value] of Object.entries(a.headers)) {
      if (typeof value !== 'string') throw new Error('plugin HTTP header 值必须是字符串');
      headers[name] = value;
    }
  }
  let body: string | undefined;
  let bodyBase64: string | undefined;
  if (a.body !== undefined) {
    if (typeof a.body === 'string') {
      body = a.body;
    } else {
      bodyBase64 = bytesToBase64(toUint8Array(a.body, 'body'));
    }
  }
  if (a.bodyBase64 !== undefined) {
    if (body !== undefined || bodyBase64 !== undefined) throw new Error('plugin HTTP body 与 bodyBase64 互斥');
    if (typeof a.bodyBase64 !== 'string') throw new Error('plugin HTTP bodyBase64 必须是字符串');
    bodyBase64 = a.bodyBase64;
  }
  if (a.body !== undefined && a.bodyBase64 !== undefined) {
    throw new Error('plugin HTTP body 与 bodyBase64 互斥');
  }
  let timeout: number | undefined;
  if (a.timeout !== undefined && a.timeout !== null) {
    if (typeof a.timeout !== 'number' || !Number.isFinite(a.timeout) || a.timeout < 0) {
      throw new Error('plugin HTTP timeout 必须是非负有限秒数');
    }
    timeout = a.timeout;
  }
  let redirect: PluginHttpRedirect | undefined;
  if (a.redirect !== undefined) {
    if (typeof a.redirect !== 'string' || !REDIRECTS.includes(a.redirect as PluginHttpRedirect)) {
      throw new Error("plugin HTTP redirect 必须是 'follow' | 'manual' | 'error'");
    }
    redirect = a.redirect as PluginHttpRedirect;
  }
  let responseType: 'text' | 'binary' = 'text';
  if (allowResponseType && a.responseType !== undefined) {
    if (a.responseType !== 'text' && a.responseType !== 'binary') {
      throw new Error("plugin HTTP responseType 必须是 'text' | 'binary'");
    }
    responseType = a.responseType;
  }
  const wire: PluginHttpRequest = { url: a.url };
  if (typeof a.method === 'string') wire.method = a.method;
  if (headers) wire.headers = headers;
  if (body !== undefined) wire.body = body;
  if (bodyBase64 !== undefined) wire.bodyBase64 = bodyBase64;
  if (timeout !== undefined) wire.timeout = timeout;
  if (redirect) wire.redirect = redirect;
  return { requestId: normalizeRequestId(a.requestId), responseType, wire };
}

function activeCount(pluginId: string): number {
  let count = 0;
  for (const request of activeRequests.values()) if (request.pluginId === pluginId) count++;
  return count;
}

function rememberCancelled(pluginId: string, requestId: string): void {
  const key = requestKey(pluginId, requestId);
  cancelledBeforeOpen.delete(key);
  cancelledBeforeOpen.set(key, true);
  while (cancelledBeforeOpen.size > MAX_CANCEL_TOMBSTONES) {
    const oldest = cancelledBeforeOpen.keys().next().value;
    if (oldest === undefined) break;
    cancelledBeforeOpen.delete(oldest);
  }
}

function takeCancelled(pluginId: string, requestId: string): boolean {
  const key = requestKey(pluginId, requestId);
  const found = cancelledBeforeOpen.has(key);
  if (found) cancelledBeforeOpen.delete(key);
  return found;
}

async function cancelNative(pluginId: string, generation: string, requestId: string): Promise<void> {
  try {
    await pluginService.pluginHttpCancel(pluginId, generation, requestId);
  } catch {
    // Cancellation is idempotent/unknown-tolerant by contract; a missing native
    // request must not mask the abort reason reported to the Worker.
  }
}

async function accumulate(
  pluginId: string,
  generation: string,
  requestId: string,
  head: PluginHttpHead,
  record: ActiveRequest,
  responseType: 'text' | 'binary',
  beforeSend?: () => void,
): Promise<PluginHttpResponse> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    if (record.cancelled) throw abortError();
    // Native rechecks generation at read; mirror it before each pull so revoke
    // wakes a blocked stream without waiting for the next network chunk.
    beforeSend?.();
    const chunk = await pluginService.pluginHttpRead(pluginId, generation, requestId);
    if (record.cancelled) throw abortError();
    // Also recheck after the final read: the loop may exit without another pull.
    beforeSend?.();
    const bytes = chunk.base64 ? base64ToBytes(chunk.base64) : new Uint8Array(0);
    if (bytes.byteLength > 0) {
      chunks.push(bytes);
      total += bytes.byteLength;
    }
    if (chunk.done) break;
  }
  if (responseType === 'binary') {
    const body = new Uint8Array(total);
    let offset = 0;
    for (const bytes of chunks) {
      body.set(bytes, offset);
      offset += bytes.byteLength;
    }
    return { status: head.status, headers: head.headers, url: head.url, body };
  }
  return {
    status: head.status,
    headers: head.headers,
    url: head.url,
    body: decodeBytes(concat(chunks, total), 'utf-8'),
  };
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

async function startRequest(
  pluginId: string,
  args: unknown,
  beforeSend: (() => void) | undefined,
  accumulateBody: boolean,
): Promise<unknown> {
  const options = parseOptions(args, accumulateBody);
  const generation = generationFor(pluginId, beforeSend);
  const requestId = options.requestId ?? globalThis.crypto.randomUUID();
  const key = requestKey(pluginId, requestId);
  if (takeCancelled(pluginId, requestId)) throw abortError();
  if (activeRequests.has(key)) throw new Error('plugin HTTP requestId 已被占用');
  if (activeCount(pluginId) >= MAX_ACTIVE_REQUESTS_PER_PLUGIN) {
    throw new Error('plugin HTTP 并发请求数超限');
  }
  const record: ActiveRequest = { pluginId, generation, requestId, cancelled: false };
  activeRequests.set(key, record);
  let head: PluginHttpHead;
  try {
    head = await pluginService.pluginHttpOpen(pluginId, generation, requestId, options.wire);
  } catch (error) {
    activeRequests.delete(key);
    await cancelNative(pluginId, generation, requestId);
    throw error;
  }
  if (record.cancelled || takeCancelled(pluginId, requestId)) {
    activeRequests.delete(key);
    await cancelNative(pluginId, generation, requestId);
    throw abortError();
  }
  if (!accumulateBody) {
    // Streaming: the registry entry lives until read(done)/cancel/error.
    return {
      requestId,
      status: head.status,
      headers: head.headers,
      url: head.url,
    };
  }
  try {
    return await accumulate(pluginId, generation, requestId, head, record, options.responseType, beforeSend);
  } catch (error) {
    await cancelNative(pluginId, generation, requestId);
    throw error;
  } finally {
    activeRequests.delete(key);
  }
}

async function readRequest(
  pluginId: string,
  args: unknown,
  beforeSend?: () => void,
): Promise<{ bytes: Uint8Array; done: boolean }> {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('plugin HTTP 参数必须是对象');
  }
  const requestId = normalizeRequestId((args as Record<string, unknown>).requestId);
  if (!requestId) throw new Error('plugin HTTP read 需要 requestId');
  const key = requestKey(pluginId, requestId);
  const record = activeRequests.get(key);
  if (!record) throw new Error('plugin HTTP 请求不存在或已结束');
  if (record.cancelled) throw abortError();
  try {
    beforeSend?.();
    const chunk = await pluginService.pluginHttpRead(pluginId, record.generation, requestId);
    if (record.cancelled) throw abortError();
    // Authority may have been revoked while the native read was in flight.
    beforeSend?.();
    if (chunk.done) activeRequests.delete(key);
    return { bytes: chunk.base64 ? base64ToBytes(chunk.base64) : new Uint8Array(0), done: chunk.done };
  } catch (error) {
    if (activeRequests.get(key) === record) {
      record.cancelled = true;
      activeRequests.delete(key);
      await cancelNative(pluginId, record.generation, requestId);
    }
    throw error;
  }
}

async function cancelRequest(
  pluginId: string,
  args: unknown,
  beforeSend?: () => void,
): Promise<null> {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('plugin HTTP 参数必须是对象');
  }
  const requestId = normalizeRequestId((args as Record<string, unknown>).requestId);
  if (!requestId) throw new Error('plugin HTTP cancel 需要 requestId');
  const key = requestKey(pluginId, requestId);
  const record = activeRequests.get(key);
  if (record) {
    record.cancelled = true;
    activeRequests.delete(key);
    await cancelNative(pluginId, record.generation, requestId);
    return null;
  }
  // Cancelled before the open reached the registry: remember so a racing open is
  // refused, and still ask native (idempotent) in case it registered first.
  rememberCancelled(pluginId, requestId);
  let generation = '';
  try {
    generation = generationFor(pluginId, beforeSend);
  } catch {
    // Disabled/revoked: native already cancels owned requests on that transition.
    return null;
  }
  await cancelNative(pluginId, generation, requestId);
  return null;
}

/**
 * Execute one host-side HTTP op.
 * `http.request` accumulates the complete body (text or binary);
 * `http.open`/`http.read`/`http.cancel` are the pull primitives used by
 * Worker-side streaming. No host-side deadline or content cap is applied.
 */
export async function executePluginHttp(
  pluginId: string,
  op: string,
  args: unknown,
  beforeSend?: () => void,
): Promise<unknown> {
  switch (op) {
    case 'http.request':
      return startRequest(pluginId, args, beforeSend, true);
    case 'http.open':
      return startRequest(pluginId, args, beforeSend, false);
    case 'http.read':
      return readRequest(pluginId, args, beforeSend);
    case 'http.cancel':
      return cancelRequest(pluginId, args, beforeSend);
    default:
      throw new Error(`未知 HTTP API: ${op}`);
  }
}

/**
 * Session-stop cancellation: retire every request owned by this plugin and wake
 * native open/read. Requests registered later (new generation) have fresh IDs and
 * are not affected.
 */
export function cancelPluginHttp(pluginId: string): void {
  for (const [key, record] of [...activeRequests]) {
    if (record.pluginId !== pluginId) continue;
    record.cancelled = true;
    activeRequests.delete(key);
    void pluginService.pluginHttpCancel(pluginId, record.generation, record.requestId).catch(() => undefined);
  }
  const prefix = `${pluginId}\u0000`;
  for (const key of [...cancelledBeforeOpen.keys()]) {
    if (key.startsWith(prefix)) cancelledBeforeOpen.delete(key);
  }
}
