import { useEffect, useCallback } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { serialService } from '../services/tauri';
import type { AvailablePortInfo } from '../services/tauri';
import type { SerialPort, PortStatus } from '../types';

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
  const existingMap = new Map(existing.map(p => [p.id, p]));
  const merged = incoming.map(p => {
    const prev = existingMap.get(p.id);
    if (prev) {
      // Preserve runtime state: status, alias, hidden, group, connection
      // params, and the protocol-template binding (TerminalView sets
      // protocolTemplateId via updatePort; the 3s poll must not wipe it).
      return {
        ...p,
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
      };
    }
    return p;
  });
  // Union back any live port that transiently vanished from the enumeration
  // (USB glitch / sleep-resume). Dropping a connected/connecting port while
  // its tab/terminal still reference it causes store/backend drift; it would
  // reappear later as 'disconnected'.
  const incomingIds = new Set(incoming.map(p => p.id));
  for (const prev of existing) {
    if (!incomingIds.has(prev.id) && (prev.status === 'connected' || prev.status === 'connecting')) {
      merged.push(prev);
    }
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
    } catch (err) {
      console.warn('[useSerialPorts] Failed to list ports:', err);
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
