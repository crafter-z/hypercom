import { useEffect, useCallback } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { serialService } from '../services/tauri';
import type { AvailablePortInfo } from '../services/tauri';
import type { SerialPort, PortStatus } from '../types';

/** 上一次端口列表刷新是否失败（用于连续失败时降级日志级别，避免 3s 轮询刷屏）。 */
let lastListFailed = false;

/**
 * 将后端 PortInfo 映射为前端 SerialPort
 * 后端的 port_type 是 "real"|"virtual"，前端 PortStatus 需要从后端获取或默认 disconnected
 */
export function mapPortInfo(info: AvailablePortInfo): SerialPort {
  const type = info.port_type === 'sim' ? 'sim' : info.port_type === 'real' ? 'real' : 'virtual';
  return {
    id: info.id,
    name: info.name,
    alias: undefined,
    status: 'disconnected' as PortStatus,
    type: type as SerialPort['type'],
    isHidden: false,
    groupId: undefined,
  };
}

export function mergePorts(incoming: SerialPort[], existing: SerialPort[]): SerialPort[] {
  const incomingMap = new Map(incoming.map(p => [p.id, p]));
  const merged: SerialPort[] = [];
  const seen = new Set<string>();
  // 1) Iterate EXISTING first so the previously established order survives the
  //    poll (issue #2-5): manual «sort by port», drag reordering and group
  //    membership would otherwise be reset to raw enumeration order every 3s.
  //    Runtime state must still be preserved per port: status, alias, hidden,
  //    group, connection params, tool flag, and the protocol-template binding
  //    (TerminalView sets protocolTemplateId via updatePort; the poll must not
  //    wipe it).
  for (const prev of existing) {
    const fresh = incomingMap.get(prev.id);
    if (fresh) {
      merged.push({
        ...fresh,
        status: prev.status,
        alias: prev.alias,
        isHidden: prev.isHidden,
        groupId: prev.groupId,
        baudRate: prev.baudRate,
        dataBits: prev.dataBits,
        parity: prev.parity,
        stopBits: prev.stopBits,
        handshake: prev.handshake,
        protocolTemplateId: prev.protocolTemplateId,
        toolRunning: prev.toolRunning,
      });
      seen.add(prev.id);
    } else if (prev.status === 'connected' || prev.status === 'connecting') {
      // Union back any live port that transiently vanished from the enumeration
      // (USB glitch / sleep-resume). Dropping a connected/connecting port while
      // its tab/terminal still reference it causes store/backend drift; it
      // would reappear later as 'disconnected'.
      merged.push(prev);
      seen.add(prev.id);
    }
  }
  // 2) Genuinely new ports append at the end in enumeration order.
  for (const p of incoming) {
    if (!seen.has(p.id)) merged.push(p);
  }
  return merged;
}

/**
 * Hook: 自动刷新串口列表
 */
export function useSerialPorts(pollIntervalMs: number = 3000) {
  const setPorts = useAppStore((s) => s.setPorts);

  const refreshPorts = useCallback(async () => {
    try {
      const list = await serialService.listAvailablePorts();
      const merged = mergePorts(list.map(mapPortInfo), useAppStore.getState().ports);
      setPorts(merged);
      lastListFailed = false;
    } catch (err) {
      // 轮询每 3s 一次：连续失败时只在首次告警，后续降为 debug，避免刷屏。
      if (!lastListFailed) {
        console.warn('[useSerialPorts] Failed to list ports:', err);
      } else {
        console.debug('[useSerialPorts] Port listing still failing:', err);
      }
      lastListFailed = true;
    }
  }, [setPorts]);

  useEffect(() => {
    refreshPorts();
    if (pollIntervalMs > 0) {
      const timer = setInterval(refreshPorts, pollIntervalMs);
      return () => clearInterval(timer);
    }
  }, [refreshPorts, pollIntervalMs]);

  return { refreshPorts };
}
