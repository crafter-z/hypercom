import { useAppStore } from '../stores/useAppStore';
import { configService } from '../services/tauri';

// ==================== Session snapshot persistence (F.3) ====================

/**
 * Build the session snapshot JSON from the current app state.
 * Returns null when session restore is disabled.
 */
export function buildSessionSnapshot(state: ReturnType<typeof useAppStore.getState>): string | null {
  if (!state.config.restoreSession) return null;
  return JSON.stringify({
    paneTree: state.paneTree,
    tabs: state.tabs.map((t) => ({ id: t.id, title: t.title, splitPaneId: t.splitPaneId, isPinned: t.isPinned })),
    portConfigs: Object.fromEntries(
      state.tabs.map((t) => {
        const port = state.ports.find((p) => p.id === t.id);
        return [t.id, {
          baudRate: port?.baudRate ?? 115200,
          dataBits: port?.dataBits ?? 8,
          parity: port?.parity ?? 'None',
          stopBits: port?.stopBits ?? 'One',
          handshake: port?.handshake ?? 'None',
        }];
      })
    ),
  });
}

/**
 * Best-effort, fire-and-forget persistence of the session snapshot.
 * Failures are only logged — this must never throw (used from beforeunload).
 */
export function saveSessionSnapshot(): void {
  try {
    const state = useAppStore.getState();
    const snapshot = buildSessionSnapshot(state);
    if (snapshot === null) return;
    const config = { ...state.config, sessionSnapshot: snapshot };
    configService.setConfig(config).catch((e) => {
      console.debug('[App] Failed to save session snapshot:', e);
    });
  } catch (e) {
    console.debug('[App] Failed to build session snapshot:', e);
  }
}
