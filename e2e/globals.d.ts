/** Node-like globals used only by Playwright's test runner process. */
declare const process: { env: Record<string, string | undefined> };

declare module 'node:fs/promises' {
  export function writeFile(path: string, data: string): Promise<void>;
}

/** Browser-only test seam installed before application scripts by the IPC mocks. */
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
