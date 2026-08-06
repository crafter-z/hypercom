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
 */
export function isSendablePort(
  port: { id: string; status?: PortStatus } | undefined
): boolean {
  return portClosedReason(port) === null;
}
