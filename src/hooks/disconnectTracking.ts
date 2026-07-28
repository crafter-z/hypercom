// ==================== Module-level disconnect tracking ====================
// Tracks portIds that the user is explicitly closing via closePort(). The
// `useSerialReceive` status handler reads this to suppress the "port lost"
// toast (and the `lostPortIds` mark that drives DisconnectBanner) for
// user-initiated disconnects.
//
// Entries are removed 3s after closePort resolves to tolerate late
// `serial:status` events that arrive after the backend close response.
export const userClosingPortIds = new Set<string>();

/** Returns true if the given portId is currently being closed by the user. */
export function isUserClosingPort(portId: string): boolean {
  return userClosingPortIds.has(portId);
}

// Tracks portIds that were CONNECTED this session and then dropped
// unexpectedly (USB unplug, device reset). Session-restored tabs were never
// connected this session, so they must never appear here — that is what
// prevents the DisconnectBanner false-alarm on app startup. Cleared on
// openPort / closePort / successful reconnect.
export const lostPortIds = new Set<string>();

/** True if the port was connected this session and dropped unexpectedly. */
export function isPortLost(portId: string): boolean {
  return lostPortIds.has(portId);
}
