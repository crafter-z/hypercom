/** Shared port metadata survives until its last serial/view consumer retires. */
import { trafficStats } from '../utils/trafficStats';
import { useTerminalStore } from './useTerminalStore';
import { releaseSendHistory } from '../hooks/useSerialSend';
import { hasPortDisplayConsumers, hasPortLineConsumers } from '../utils/pluginViewInput';
import { getRxPipeline } from '../utils/rxPipeline';

export function releaseUnusedPortState(portId: string): boolean {
  if (!hasPortLineConsumers(portId)) getRxPipeline().releasePort(portId);
  if (hasPortDisplayConsumers(portId) || hasPortLineConsumers(portId)) return false;
  useTerminalStore.getState().releaseTerminal(portId);
  // 必须经聚合器的 release（而非直接 clearTrafficStats）：它同时丢弃该端口尚未
  // flush 的本地累计，否则下一次 flush 会把刚清掉的幽灵条目写回来。
  trafficStats.release(portId);
  releaseSendHistory(portId);
  return true;
}

export function releaseTerminalState(portId: string): void {
  releaseUnusedPortState(portId);
}
