import type { PluginViewBinding, PluginViewInput } from '../types/pluginViews';
import { useAppStore } from '../stores/useAppStore';
import { useTerminalStore } from '../stores/useTerminalStore';
import { useRuleStore } from '../stores/useRuleStore';
import { releaseUnusedPortState } from '../stores/releaseTerminalState';
import { getRxPipeline } from './rxPipeline';
import { addPluginRxObserver, discardPluginLinePortInput, hasPluginRxObservers, type ObservedRxLine } from './pluginObserver';
import { addPluginBytesObserver, discardPluginBytesPortInput, type ObservedRxBytes } from './pluginBytesObserver';

export interface PluginViewInputCallbacks {
  onInput: (batch: Array<ObservedRxBytes | ObservedRxLine>, streamEpoch: number, gapBefore: boolean) => boolean | void;
  onDiscontinuity: (reason: string, streamEpoch: number) => void;
  onStatus: (status: string, streamEpoch: number) => void;
}

interface InputLease {
  portId: string;
  input: PluginViewInput;
  epoch: number;
  gapPending: boolean;
  callbacks: PluginViewInputCallbacks;
  retired: boolean;
}

const leases = new Set<InputLease>();
const consumerListeners = new Set<() => void>();
const observedPorts = new Map<string, { status: string; mode: string }>();
let unsubscribeStore: (() => void) | null = null;

export function getPluginLineConsumerCount(portId: string): number {
  let count = 0;
  for (const lease of leases) if (lease.portId === portId && lease.input === 'lines') count++;
  return count;
}

/** Shared port metadata/history belongs to all bound views, including input:none. */
export function hasPortDisplayConsumers(portId: string): boolean {
  if (useAppStore.getState().tabs.some(tab => tab.kind === 'serial' ? tab.portId === portId : tab.boundPortId === portId)) return true;
  for (const lease of leases) if (lease.portId === portId) return true;
  return false;
}

/** Legacy all-port line observers also keep the common parser alive. */
export function hasPortLineConsumers(portId: string): boolean {
  return getPluginLineConsumerCount(portId) > 0 || hasPluginRxObservers(portId) ||
    useAppStore.getState().tabs.some(tab => tab.kind === 'serial' && tab.portId === portId) ||
    useRuleStore.getState().triggerRules.some(rule => rule.isEnabled && (!rule.portId || rule.portId === portId));
}

export function subscribePortInputConsumersChanged(callback: () => void): () => void {
  consumerListeners.add(callback);
  return () => { consumerListeners.delete(callback); };
}

function consumersChanged(): void {
  for (const callback of consumerListeners) callback();
}

function safeNotify(callback: () => void): void {
  try { callback(); } catch (error) { console.error('[pluginViewInput] callback failed:', error); }
}

function discontinuity(lease: InputLease, reason: string): void {
  if (lease.retired) return;
  lease.epoch++;
  lease.gapPending = true;
  safeNotify(() => lease.callbacks.onDiscontinuity(reason, lease.epoch));
}

function clearQueuedInput(portId: string): void {
  discardPluginLinePortInput(portId);
  discardPluginBytesPortInput(portId);
}

/** Called for physical serial status events, never for a view/tab retirement. */
export function notifyPluginViewPortStatus(portId: string, status: string): void {
  const previous = observedPorts.get(portId);
  if (!previous) return;
  const mode = useAppStore.getState().ports.find(port => port.id === portId)?.mode ?? 'trx';
  observedPorts.set(portId, { status, mode });
  if (previous?.status === status) return;
  getRxPipeline().releasePort(portId);
  clearQueuedInput(portId);
  for (const lease of leases) {
    if (lease.portId !== portId) continue;
    discontinuity(lease, status === 'connected' ? 'port-connected' : `port-${status}`);
    safeNotify(() => lease.callbacks.onStatus(status, lease.epoch));
  }
}

function checkPorts(): void {
  for (const [portId, previous] of observedPorts) {
    const port = useAppStore.getState().ports.find(item => item.id === portId);
    const status = port?.status ?? 'disconnected';
    const mode = port?.mode ?? 'trx';
    if (previous.status !== status) notifyPluginViewPortStatus(portId, status);
    if (previous.mode !== mode) {
      clearQueuedInput(portId);
      getRxPipeline().flushBeforeSend(portId);
      getRxPipeline().releasePort(portId);
      for (const lease of leases) {
        if (lease.portId === portId) discontinuity(lease, `mode-${mode}`);
      }
    }
    observedPorts.set(portId, { status, mode });
  }
}

export function subscribePluginViewInput(
  binding: PluginViewBinding, input: PluginViewInput, callbacks: PluginViewInputCallbacks,
): () => void {
  const portId = binding.boundPortId;
  if (portId === null) return () => {};
  getRxPipeline().setLineConsumerQuery(hasPortLineConsumers);
  const lease: InputLease = { portId, input, epoch: binding.streamEpoch, gapPending: false, callbacks, retired: false };
  leases.add(lease);
  // Preserve the chosen decoding label without creating a viewport/history buffer.
  useTerminalStore.getState().ensureTerminal(portId);
  const port = useAppStore.getState().ports.find(item => item.id === portId);
  if (!observedPorts.has(portId)) observedPorts.set(portId, { status: port?.status ?? 'disconnected', mode: port?.mode ?? 'trx' });
  if (!unsubscribeStore) unsubscribeStore = useAppStore.subscribe(checkPorts);

  const deliver = (batch: Array<ObservedRxBytes | ObservedRxLine>, busGap = false): void => {
    if (lease.retired) return;
    if (busGap) discontinuity(lease, 'queue-overflow');
    const gap = lease.gapPending;
    const epoch = lease.epoch;
    let accepted = false;
    try { accepted = callbacks.onInput(batch, epoch, gap) !== false; }
    catch (error) { console.error('[pluginViewInput] input delivery failed:', error); }
    if (accepted && lease.epoch === epoch) lease.gapPending = false;
    else if (!accepted) discontinuity(lease, 'delivery-failed');
  };
  const removeObserver = input === 'bytes'
    ? addPluginBytesObserver({ portId, onRxBytes: deliver })
    : input === 'lines'
      ? addPluginRxObserver({ portId, onRxLines: deliver, onRxDetached: () => {} })
      : () => {};
  consumersChanged();
  safeNotify(() => callbacks.onStatus(port?.status ?? 'disconnected', lease.epoch));

  return () => {
    if (lease.retired) return;
    lease.retired = true;
    leases.delete(lease);
    removeObserver();
    let portLeased = false;
    for (const item of leases) if (item.portId === portId) { portLeased = true; break; }
    if (!portLeased) observedPorts.delete(portId);
    if (leases.size === 0) {
      unsubscribeStore?.();
      unsubscribeStore = null;
      observedPorts.clear();
    }
    consumersChanged();
    if (!hasPortLineConsumers(portId)) getRxPipeline().releasePort(portId);
    releaseUnusedPortState(portId);
  };
}
