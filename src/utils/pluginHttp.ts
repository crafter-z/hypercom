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
/** Native cancel is a reserved path, but unknown-id floods remain bounded. */
export const MAX_PENDING_CANCELS_PER_PLUGIN = 32;
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const REDIRECTS: readonly PluginHttpRedirect[] = ['follow', 'manual', 'error'];
/**
 * Channel-level guardrails (not content quotas): an unbounded URL/header list
 * would otherwise be copied through the Worker→host IPC bridge before any native
 * validation can reject it.
 */
export const MAX_HTTP_URL_CHARS = 8 * 1024;
export const MAX_HTTP_HEADERS = 64;
export const MAX_HTTP_HEADER_NAME_CHARS = 256;
export const MAX_HTTP_HEADER_VALUE_CHARS = 8 * 1024;
/**
 * Streams are pulled by the Worker; an abandoned `http.open` (never read nor
 * cancelled) would otherwise hold one of the 64 concurrency slots forever.
 */
export const STREAM_IDLE_TIMEOUT_MS = 60_000;
const MAX_EXPIRED_STREAMS = 64;

interface ActiveRequest {
  pluginId: string;
  generation: string;
  requestId: string;
  cancelled: boolean;
  /** Pending native pulls are active consumption, even when the network is quiet. */
  pendingReads: number;
  /** Pending idle reaper for a streaming (pull-mode) request. */
  idleTimer: ReturnType<typeof setTimeout> | null;
}

const activeRequests = new Map<string, ActiveRequest>();
/** requestId cancelled before/without a registered request, keyed plugin+id. */
const cancelledBeforeOpen = new Map<string, true>();
/** Recently idle-reaped streams; lets the next read report a precise reason. */
const expiredStreams = new Map<string, string>();
/** Deduplicate concurrent native cancels by plugin + request id. */
const pendingCancels = new Map<string, Promise<void>>();

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
  if (a.url.length > MAX_HTTP_URL_CHARS) throw new Error(`plugin HTTP url 超过 ${MAX_HTTP_URL_CHARS} 字符上限`);
  if (a.method !== undefined && typeof a.method !== 'string') throw new Error('plugin HTTP method 必须是字符串');
  let headers: Record<string, string> | undefined;
  if (a.headers !== undefined) {
    if (a.headers === null || typeof a.headers !== 'object' || Array.isArray(a.headers)) {
      throw new Error('plugin HTTP headers 必须是对象');
    }
    const entries = Object.entries(a.headers);
    if (entries.length > MAX_HTTP_HEADERS) {
      throw new Error(`plugin HTTP headers 数量超过 ${MAX_HTTP_HEADERS} 上限`);
    }
    headers = {};
    for (const [name, value] of entries) {
      if (typeof value !== 'string') throw new Error('plugin HTTP header 值必须是字符串');
      if (name.length === 0 || name.length > MAX_HTTP_HEADER_NAME_CHARS) {
        throw new Error(`plugin HTTP header 名长度超过 ${MAX_HTTP_HEADER_NAME_CHARS} 上限`);
      }
      if (value.length > MAX_HTTP_HEADER_VALUE_CHARS) {
        throw new Error(`plugin HTTP header 值长度超过 ${MAX_HTTP_HEADER_VALUE_CHARS} 上限`);
      }
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
  // `null` is not a valid timeout: omit the field (or use 0) for "no deadline".
  if (a.timeout !== undefined) {
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

async function cancelNative(
  pluginId: string,
  generation: string,
  requestId: string,
  boundedUnknown = false,
): Promise<void> {
  const key = requestKey(pluginId, requestId);
  const pending = pendingCancels.get(key);
  if (pending) {
    await pending;
    return;
  }
  if (boundedUnknown) {
    let pendingForPlugin = 0;
    for (const pendingKey of pendingCancels.keys()) {
      if (pendingKey.startsWith(`${pluginId}\u0000`)) pendingForPlugin++;
    }
    if (pendingForPlugin >= MAX_PENDING_CANCELS_PER_PLUGIN) return;
  }
  const operation = (async () => {
    try {
      await pluginService.pluginHttpCancel(pluginId, generation, requestId);
    } catch {
      // Cancellation is idempotent/unknown-tolerant by contract; a missing native
      // request must not mask the abort reason reported to the Worker.
    }
  })();
  pendingCancels.set(key, operation);
  try {
    await operation;
  } finally {
    if (pendingCancels.get(key) === operation) pendingCancels.delete(key);
  }
}

function clearIdle(record: ActiveRequest): void {
  if (record.idleTimer !== null) {
    clearTimeout(record.idleTimer);
    record.idleTimer = null;
  }
}

function rememberExpired(key: string, reason: string): void {
  expiredStreams.delete(key);
  expiredStreams.set(key, reason);
  while (expiredStreams.size > MAX_EXPIRED_STREAMS) {
    const oldest = expiredStreams.keys().next().value;
    if (oldest === undefined) break;
    expiredStreams.delete(oldest);
  }
}

/**
 * Reap a pulled stream that nobody reads or cancels within STREAM_IDLE_TIMEOUT_MS.
 * The entry exits the concurrency ledger and the native request is cancelled;
 * the next `http.read` reports the precise reason instead of "not found".
 */
function armStreamIdle(pluginId: string, record: ActiveRequest): void {
  clearIdle(record);
  const key = requestKey(pluginId, record.requestId);
  record.idleTimer = setTimeout(() => {
    record.idleTimer = null;
    if (record.cancelled || activeRequests.get(key) !== record) return;
    record.cancelled = true;
    activeRequests.delete(key);
    rememberExpired(key, `plugin HTTP stream idle for ${STREAM_IDLE_TIMEOUT_MS}ms and was reclaimed`);
    void cancelNative(pluginId, record.generation, record.requestId);
  }, STREAM_IDLE_TIMEOUT_MS);
}

function deleteActiveRequest(key: string, record: ActiveRequest): void {
  clearIdle(record);
  if (activeRequests.get(key) === record) activeRequests.delete(key);
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
  const record: ActiveRequest = { pluginId, generation, requestId, cancelled: false, pendingReads: 0, idleTimer: null };
  activeRequests.set(key, record);
  let head: PluginHttpHead;
  try {
    head = await pluginService.pluginHttpOpen(pluginId, generation, requestId, options.wire);
  } catch (error) {
    deleteActiveRequest(key, record);
    await cancelNative(pluginId, generation, requestId);
    throw error;
  }
  if (record.cancelled || takeCancelled(pluginId, requestId)) {
    deleteActiveRequest(key, record);
    await cancelNative(pluginId, generation, requestId);
    throw abortError();
  }
  if (!accumulateBody) {
    // Streaming: the registry entry lives until read(done)/cancel/error or idle reap.
    armStreamIdle(pluginId, record);
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
    deleteActiveRequest(key, record);
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
  if (!record) {
    const expired = expiredStreams.get(key);
    if (expired) {
      expiredStreams.delete(key);
      throw new Error(expired);
    }
    throw new Error('plugin HTTP 请求不存在或已结束');
  }
  if (record.cancelled) throw abortError();
  let reading = false;
  try {
    beforeSend?.();
    record.pendingReads++;
    reading = true;
    // Waiting for a caller-requested native read is active consumption, not an
    // abandoned stream. SSE/long polling may legitimately wait indefinitely;
    // only the caller's explicit timeout may terminate that wait.
    clearIdle(record);
    const chunk = await pluginService.pluginHttpRead(pluginId, record.generation, requestId);
    if (record.cancelled) throw abortError();
    // Authority may have been revoked while the native read was in flight.
    beforeSend?.();
    if (chunk.done) deleteActiveRequest(key, record);
    return { bytes: chunk.base64 ? base64ToBytes(chunk.base64) : new Uint8Array(0), done: chunk.done };
  } catch (error) {
    if (activeRequests.get(key) === record) {
      record.cancelled = true;
      deleteActiveRequest(key, record);
      await cancelNative(pluginId, record.generation, requestId);
    }
    throw error;
  } finally {
    if (reading) record.pendingReads--;
    if (record.pendingReads === 0 && !record.cancelled && activeRequests.get(key) === record) {
      armStreamIdle(pluginId, record);
    }
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
    deleteActiveRequest(key, record);
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
  // Unknown-id cancellation uses the reserved bounded budget; active request
  // cancellation above remains unbounded so it always wakes a live stream.
  await cancelNative(pluginId, generation, requestId, true);
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
    deleteActiveRequest(key, record);
    void pluginService.pluginHttpCancel(pluginId, record.generation, record.requestId).catch(() => undefined);
  }
  const prefix = `${pluginId}\u0000`;
  for (const key of [...cancelledBeforeOpen.keys()]) {
    if (key.startsWith(prefix)) cancelledBeforeOpen.delete(key);
  }
  for (const key of [...expiredStreams.keys()]) {
    if (key.startsWith(prefix)) expiredStreams.delete(key);
  }
}
