import { useSyncExternalStore } from 'react';

/** Runtime status for an enhanced command flow. Kept outside React stores so
 * the executor and all windows can publish a small, read-only status surface
 * without coupling flow execution to OperationStore. */
export type FlowPhase =
  | 'starting'
  | 'initializing'
  | 'running'
  | 'waiting'
  | 'applyingParams'
  | 'stopping'
  | 'completed'
  | 'stopped'
  | 'failed';

export interface FlowRuntimeStatus {
  portId: string;
  runId: string;
  name?: string;
  phase: FlowPhase;
  round?: number;
  totalRounds?: number;
  step?: number;
  totalSteps?: number;
  detail?: string;
  error?: unknown;
  /** Enhanced flows own sends and parameter changes on this port. */
  exclusive: boolean;
}

const statuses = new Map<string, FlowRuntimeStatus>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Publish or replace the current status for a target port. */
export function setFlowStatus(status: FlowRuntimeStatus): void {
  statuses.set(status.portId, status);
  notify();
}

/** Remove a flow status when its run has fully settled. */
export function clearFlowStatus(portId: string, runId?: string): void {
  const current = statuses.get(portId);
  if (!current || (runId !== undefined && current.runId !== runId)) return;
  statuses.delete(portId);
  notify();
}

export function getFlowStatus(portId: string | null | undefined): FlowRuntimeStatus | null {
  return portId ? statuses.get(portId) ?? null : null;
}

/** True only while a flow may still issue an exclusive operation. */
export function isFlowRunning(portId: string | null | undefined): boolean {
  const status = getFlowStatus(portId);
  return !!status && status.exclusive && (
    status.phase === 'starting' ||
    status.phase === 'initializing' ||
    status.phase === 'running' ||
    status.phase === 'waiting' ||
    status.phase === 'applyingParams' ||
    status.phase === 'stopping'
  );
}

export function subscribeFlowRuntime(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React helper for components that need a status for one port. */
export function useFlowStatus(portId: string | null | undefined): FlowRuntimeStatus | null {
  return useSyncExternalStore(
    subscribeFlowRuntime,
    () => getFlowStatus(portId),
    () => null,
  );
}

/** Human-facing phase text can remain in the UI/i18n layer. */
export function flowIsActive(status: FlowRuntimeStatus | null): boolean {
  return !!status && isFlowRunning(status.portId);
}

/** Test cleanup and app teardown helper. */
export function resetFlowRuntime(): void {
  if (statuses.size === 0) return;
  statuses.clear();
  notify();
}

export function getFlowRuntimeSnapshot(): ReadonlyMap<string, FlowRuntimeStatus> {
  return statuses;
}
