import { useSyncExternalStore } from 'react';

/**
 * Non-exclusive runtime visibility for plain (send-only) cyclic command loops.
 *
 * Kept separate from `flowRuntime.ts` so plain command sets NEVER publish
 * `exclusive: true` or populate `getFlowStatus(portId)` (preserving the
 * transmission.md invariant that plain loops do not lock manual sends).
 */
export interface CyclicRunStatus {
  portId: string;
  runId: string;
  name: string;
  round: number;
  totalRounds?: number;
  step: number;
  totalSteps: number;
  waitingReconnect: boolean;
}

const statuses = new Map<string, CyclicRunStatus>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function setCyclicStatus(status: CyclicRunStatus): void {
  statuses.set(status.portId, status);
  notify();
}

export function clearCyclicStatus(portId: string, runId?: string): void {
  const current = statuses.get(portId);
  if (!current || (runId !== undefined && current.runId !== runId)) return;
  statuses.delete(portId);
  notify();
}

export function getCyclicStatus(portId: string | null | undefined): CyclicRunStatus | null {
  return portId ? statuses.get(portId) ?? null : null;
}

export function subscribeCyclicRuntime(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useCyclicStatus(portId: string | null | undefined): CyclicRunStatus | null {
  return useSyncExternalStore(
    subscribeCyclicRuntime,
    () => getCyclicStatus(portId),
    () => null,
  );
}

export function resetCyclicRuntime(): void {
  if (statuses.size === 0) return;
  statuses.clear();
  notify();
}
