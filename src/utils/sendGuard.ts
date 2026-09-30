/**
 * Closed-port send guard (issue #5-4-7).
 *
 * Pure, DOM-free helpers deciding whether a `sendToPort` call may proceed.
 * `sendToPort` uses them so every entry point (manual send, pop-out bridge,
 * cyclic send, trigger auto-respond) shares one guard: sends are allowed ONLY
 * when a port exists AND its status is 'connected'.
 */
import type { PortStatus } from '../types';

/**
 * Return the reason a port cannot receive data, or null when it can.
 * - `'missing'`       — no port with that id (never listed / not found)
 * - `'not-connected'` — port exists but is not in the 'connected' state
 * - `null`            — port exists AND `status === 'connected'`
 */
export function portClosedReason(
  port: { id: string; status?: PortStatus } | undefined
): 'missing' | 'not-connected' | null {
  if (!port) return 'missing';
  if (port.status !== 'connected') return 'not-connected';
  return null;
}

/**
 * True only when the port exists AND its status is exactly 'connected'.
 * `undefined` / `'disconnected'` / `'connecting'` / `'error'` all block sends.
 *
 * 声明为类型谓词（而不是返回 boolean）：调用方在守卫之后就要读该端口的字段
 * （模式、id），否则每个调用点都得再写一次 `!` 断言或空值分支。
 */
export function isSendablePort<P extends { id: string; status?: PortStatus }>(
  port: P | undefined
): port is P {
  return port !== undefined && port.status === 'connected';
}
