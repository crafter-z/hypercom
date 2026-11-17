import { useEffect } from 'react';
import { notifyError } from '../stores/useToastStore';
import {
  acquireSerialConnectionRuntime,
  closeSerialConnection,
  openSerialConnection,
  toggleSerialConnection,
  type SerialCloseResult,
  type SerialOpenResult,
} from '../utils/serialConnectionRuntime';

// Keep the historical import path for consumers; the state machine has no React owner.
export { acceptSerialStatus } from '../utils/serialConnectionRuntime';

export type SerialConnectionActionResult =
  | ({ ok: true } & (SerialOpenResult | SerialCloseResult))
  | { ok: false; error: unknown };

/** Event handlers intentionally fire-and-forget. Notify, but return a visible failure
 * rather than either swallowing it as success or creating an unhandled rejection.
 * Non-UI/plugin callers use the strict runtime, whose failures always reject. */
async function reportConnectionResult(action: () => Promise<SerialOpenResult | SerialCloseResult>): Promise<SerialConnectionActionResult> {
  try {
    return { ok: true, ...await action() };
  } catch (error) {
    notifyError(error);
    return { ok: false, error };
  }
}

const openPort = (portId: string) => reportConnectionResult(() => openSerialConnection(portId));
const closePort = (portId: string) => reportConnectionResult(() => closeSerialConnection(portId));
const toggleConnection = (portId: string) => reportConnectionResult(() => toggleSerialConnection(portId));

export interface SerialConnectionActions {
  openPort: (portId: string) => Promise<SerialConnectionActionResult>;
  closePort: (portId: string) => Promise<SerialConnectionActionResult>;
  toggleConnection: (portId: string) => Promise<SerialConnectionActionResult>;
}

/** Only the listener lease belongs to React; UI and plugins share the runtime lane. */
export function useSerialConnection(): SerialConnectionActions {
  useEffect(() => acquireSerialConnectionRuntime(), []);
  return { openPort, closePort, toggleConnection };
}
