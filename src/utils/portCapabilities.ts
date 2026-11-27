import type { RemoteRole, SerialPort } from '../types';

export interface PortCapabilities {
  isRemote: boolean;
  canWrite: boolean;
  canControl: boolean;
  canLoan: boolean;
  canLocalTool: boolean;
  canLocalFileSend: boolean;
  isLoaned: boolean;
}

export function isRemotePortId(portId: string | null | undefined): boolean {
  return typeof portId === 'string' && portId.startsWith('remote::');
}

export function isRemotePort(port: Pick<SerialPort, 'id' | 'type'> | null | undefined): boolean {
  return !!port && (port.type === 'remote' || isRemotePortId(port.id));
}

export function parseRemotePortId(portId: string | null | undefined): { hostId: string; remotePortId: string } | null {
  if (!isRemotePortId(portId)) return null;
  const rest = (portId as string).slice('remote::'.length);
  const sepIdx = rest.indexOf('::');
  if (sepIdx <= 0) return null;
  const hostId = rest.slice(0, sepIdx).trim();
  const remotePortId = rest.slice(sepIdx + 2).trim();
  if (!hostId || !remotePortId) return null;
  return { hostId, remotePortId };
}

export function formatSerialTabTitle(
  port: Pick<SerialPort, 'id' | 'name' | 'alias' | 'type' | 'hostId' | 'hostLabel' | 'remotePortId'> | undefined,
  fallbackPortId: string,
): string {
  if (!port) {
    const parsed = parseRemotePortId(fallbackPortId);
    return parsed ? `${parsed.hostId} / ${parsed.remotePortId}` : fallbackPortId;
  }
  if (isRemotePort(port)) {
    const host = (port.hostLabel || port.hostId || '').trim();
    const target = (port.remotePortId || port.name || port.id).trim();
    const base = host ? `${host} / ${target}` : target;
    return port.alias ? `${base} ${port.alias}`.trim() : base;
  }
  return `${port.id} ${port.alias || ''}`.trim();
}

export function normalizeRemoteRole(role: string | undefined): RemoteRole | undefined {
  if (role === 'observe' || role === 'write' || role === 'control') return role;
  return undefined;
}

export function getPortCapabilities(port: SerialPort | null | undefined): PortCapabilities {
  if (!port) {
    return {
      isRemote: false,
      canWrite: false,
      canControl: false,
      canLoan: false,
      canLocalTool: false,
      canLocalFileSend: false,
      isLoaned: false,
    };
  }
  const isLoaned = !!(port.loan || port.pluginToolRunning || port.toolRunning);
  if (!isRemotePort(port)) {
    return {
      isRemote: false,
      canWrite: true,
      canControl: true,
      canLoan: true,
      canLocalTool: true,
      canLocalFileSend: true,
      isLoaned,
    };
  }
  const role: RemoteRole = port.remoteRole ?? 'observe';
  const canWrite = role === 'write' || role === 'control';
  const canControl = role === 'control';
  const canLoan = !!port.remoteAllowLoan && role === 'control';
  return {
    isRemote: true,
    canWrite,
    canControl,
    canLoan,
    canLocalTool: false,
    canLocalFileSend: false,
    isLoaned,
  };
}
