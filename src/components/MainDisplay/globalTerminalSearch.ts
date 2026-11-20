import type { SearchHit, SearchSource, SearchSpec } from '../../utils/terminal/search/searchTypes';

/** The minimum manager surface needed by the global search registry.
 * TerminalViewportManager implements this by delegating to its terminal source.
 */
export interface GlobalSearchManager {
  createSearchSource(id?: string): SearchSource;
  previewSearchHit(hit: SearchHit, spec?: SearchSpec): string;
  isSearchHitValid(hit: SearchHit): boolean;
}

export interface TerminalSearchRegistration {
  /** Stable identity for a mounted TerminalView/ReplayView. */
  id: string;
  tabId?: string;
  portId?: string;
  manager: GlobalSearchManager;
  /** Called only after the user explicitly selects a hit. */
  onReveal: (hit: SearchHit, spec?: SearchSpec) => void;
}

type RegistryListener = () => void;
const registrations = new Map<string, TerminalSearchRegistration>();
let registrationSnapshot: readonly TerminalSearchRegistration[] = [];
const listeners = new Set<RegistryListener>();

function notify(): void {
  registrationSnapshot = Array.from(registrations.values());
  listeners.forEach(listener => listener());
}

/** Register a searchable TRX/replay source. Returns an idempotent cleanup. */
export function registerGlobalTerminalSearch(registration: TerminalSearchRegistration): () => void {
  const previous = registrations.get(registration.id);
  registrations.set(registration.id, registration);
  if (previous !== registration) notify();
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    if (registrations.get(registration.id) === registration) {
      registrations.delete(registration.id);
      notify();
    }
  };
}

export function unregisterGlobalTerminalSearch(id: string): void {
  if (registrations.delete(id)) notify();
}

/** Snapshot in registration order; callers must not mutate the returned array. */
export function getGlobalTerminalSearchSources(): readonly TerminalSearchRegistration[] {
  return registrationSnapshot;
}

/** React-friendly subscription used to handle tab/source mount changes. */
export function subscribeGlobalTerminalSearch(listener: RegistryListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Resolve a live SearchSource at session creation time, never retain row data. */
export function createGlobalSearchSources(
  entries: readonly TerminalSearchRegistration[] = getGlobalTerminalSearchSources(),
): SearchSource[] {
  return entries.map(entry => entry.manager.createSearchSource(entry.id));
}

/** Registry lifecycle is intentionally memory-only and has no persisted state. */
export function clearGlobalTerminalSearchRegistryForTests(): void {
  registrations.clear();
  registrationSnapshot = [];
  listeners.clear();
}

export type GlobalTerminalSearchHit = SearchHit;
