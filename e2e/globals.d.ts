export {};

/** Browser-only test seam installed before application scripts by the IPC mocks. */
declare global {
  interface Window {
    __TAURI_INTERNALS__: {
      invoke(command: string, args?: unknown): Promise<unknown>;
      dispatchEvent(event: string, payload: unknown): void;
    };
    __PLUGIN_E2E_SEED__: { granted: string[] };
    __PLUGIN_E2E__: { granted: string[]; reloads: number };
    __E2E_UNKNOWN_COMMANDS__: string[];
    __REPLAY_CALLS__: { cmd: string; args?: unknown }[];
  }
}
