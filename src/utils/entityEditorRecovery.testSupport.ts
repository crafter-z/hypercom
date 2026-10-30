import { vi } from 'vitest';

/** Node 26 exposes an experimental localStorage getter that can be undefined even
 * in a jsdom test. Install the exact Storage object used by recovery code instead
 * of changing production fail-safe behavior or relying on host getter ordering. */
export function installRecoveryTestStorage(): Storage {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() { return values.size; },
    clear() { values.clear(); },
    getItem(key: string) { return values.get(String(key)) ?? null; },
    setItem(key: string, value: string) { values.set(String(key), String(value)); },
    removeItem(key: string) { values.delete(String(key)); },
    key(index: number) { return [...values.keys()][index] ?? null; },
  };
  vi.stubGlobal('localStorage', storage);
  return storage;
}
