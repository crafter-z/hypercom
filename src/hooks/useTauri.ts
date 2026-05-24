import { useEffect, useCallback, useRef } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { serialService, configService, systemService, eventService, logService } from '../services/tauri';
import type { AvailablePortInfo, SerialDataEvent, SerialStatusEvent } from '../services/tauri';
import type { SerialPort, AppConfig } from '../types';

/**
 * 将后端 PortInfo 映射为前端 SerialPort
 * 后端的 port_type 是 "real"|"virtual"，前端 PortStatus 需要从后端获取或默认 disconnected
 */
function mapPortInfo(info: AvailablePortInfo): SerialPort {
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

function mergePorts(incoming: SerialPort[], existing: SerialPort[]): SerialPort[] {
  const existingMap = new Map(existing.map(p => [p.id, p]));
  return incoming.map(p => {
    const prev = existingMap.get(p.id);
    if (prev) {
      // Preserve runtime state: status, alias, hidden, group, connection params
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
      };
    }
    return p;
  });
}

import type { PortStatus } from '../types';

/**
 * Hook: 自动刷新串口列表
 * 在组件挂载时获取一次串口列表，并可选地定时刷新
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

/**
 * Hook: 串口连接/断开操作
 */
export function useSerialConnection() {
  const updatePort = useAppStore((s) => s.updatePort);
  const ports = useAppStore((s) => s.ports);

  const openPort = useCallback(async (portId: string, _baudRate: number = 115200) => {
    try {
      const store = useAppStore.getState();
      updatePort(portId, { status: 'connecting' });
      await serialService.openSerialPort({
        port_id: portId,
        baud_rate: store.opBaudRate,
        data_bits: store.opDataBits,
        parity: store.opParity,
        stop_bits: store.opStopBits,
        handshake: store.opHandshake,
        dtr: store.opDtr,
        rts: store.opRts,
      });
      const currentState = useAppStore.getState();
      updatePort(portId, {
        status: 'connected',
        baudRate: currentState.opBaudRate,
        dataBits: currentState.opDataBits,
        parity: currentState.opParity,
        stopBits: currentState.opStopBits,
        handshake: currentState.opHandshake,
      });
      // Auto-start logging if enabled
      if (store.config.autoSaveLog) {
        logService.startLogging(portId).catch(() => {});
      }
    } catch (err) {
      console.error('[useSerialConnection] Failed to open port:', err);
      updatePort(portId, { status: 'error' });
    }
  }, [updatePort]);

  const closePort = useCallback(async (portId: string) => {
    try {
      await serialService.closeSerialPort(portId);
      updatePort(portId, { status: 'disconnected' });
      // Auto-stop logging
      logService.stopLogging(portId).catch(() => {});
    } catch (err) {
      console.error('[useSerialConnection] Failed to close port:', err);
      updatePort(portId, { status: 'error' });
    }
  }, [updatePort]);

  const toggleConnection = useCallback(async (portId: string) => {
    const port = ports.find((p) => p.id === portId);
    if (!port) return;
    if (port.status === 'connected') {
      await closePort(portId);
    } else {
      await openPort(portId, port.baudRate || 115200);
    }
  }, [ports, openPort, closePort]);

  return { openPort, closePort, toggleConnection };
}

/**
 * Hook: 串口数据发送/接收
 * 监听 Tauri 事件，将接收到的数据写入终端
 */
export function useSerialData() {
  const appendTerminalLine = useAppStore((s) => s.appendTerminalLine);
  const setupPromiseRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const cleanups: Array<() => void> = [];

    const setup = async () => {
      const unlistenData = await eventService.onSerialData((event: SerialDataEvent) => {
        if (cancelled) return;
        const text = new TextDecoder().decode(new Uint8Array(event.data));
        if (useAppStore.getState().opIgnoreEmptyChars && !text.trim()) return;
        appendTerminalLine(event.port_id, {
          id: `line-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          timestamp: event.timestamp,
          direction: event.direction as 'RX' | 'TX',
          content: text,
          rawData: event.data,
          isHex: event.is_hex,
        });
        useAppStore.getState().setTrafficStats(event.port_id, {
          rxTotal: (useAppStore.getState().trafficStats[event.port_id]?.rxTotal || 0) + event.data.length,
        });
      });

      const unlistenStatus = await eventService.onSerialStatus((event: SerialStatusEvent) => {
        if (cancelled) return;
        const statusMap: Record<string, PortStatus> = {
          connected: 'connected',
          disconnected: 'disconnected',
          error: 'error',
        };
        useAppStore.getState().updatePort(event.port_id, {
          status: statusMap[event.status] || 'disconnected',
        });
      });

      if (cancelled) {
        unlistenData();
        unlistenStatus();
        return;
      }

      cleanups.push(unlistenData, unlistenStatus);
    };

    setupPromiseRef.current = setup();

    return () => {
      cancelled = true;
      cleanups.forEach((fn) => fn());
    };
  }, [appendTerminalLine]);

  const sendData = useCallback(async (portId: string, data: string, isHex: boolean, lineEnding: string) => {
    try {
      const bytesWritten = await serialService.sendSerialData({
        port_id: portId,
        data,
        is_hex: isHex,
        append_line_ending: lineEnding,
      });

      // Also show sent data in terminal
      const { sendPrefix } = useAppStore.getState().config;
      const prefix = sendPrefix ? `${sendPrefix} ` : '';
      const displayText = `${prefix}${data}`;
      useAppStore.getState().appendTerminalLine(portId, {
        id: `line-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: Date.now(),
        direction: 'TX',
        content: displayText,
        rawData: isHex ? undefined : Array.from(new TextEncoder().encode(displayText)),
        isHex: isHex,
      });

      // Track TX bytes
      const currentTx = useAppStore.getState().trafficStats[portId]?.txTotal || 0;
      useAppStore.getState().setTrafficStats(portId, { txTotal: currentTx + bytesWritten });

      return bytesWritten;
    } catch (err) {
      console.error('[useSerialData] Failed to send data:', err);
      return 0;
    }
  }, []);

  return { sendData };
}

/**
 * Hook: 配置持久化
 * 从后端加载配置、保存配置到后端
 */
export function useConfigPersistence() {
  const setConfig = useAppStore((s) => s.setConfig);
  const resetConfig = useAppStore((s) => s.resetConfig);

  const loadConfig = useCallback(async () => {
    try {
      const config = await configService.getConfig();
      setConfig(config);
    } catch (err) {
      console.warn('[useConfigPersistence] Failed to load config, using defaults:', err);
    }
  }, [setConfig]);

  const saveConfig = useCallback(async (config: AppConfig) => {
    try {
      await configService.setConfig(config);
    } catch (err) {
      console.error('[useConfigPersistence] Failed to save config:', err);
    }
  }, []);

  const resetAndReload = useCallback(async () => {
    try {
      const defaultConfig = await configService.resetConfig();
      resetConfig();
      setConfig(defaultConfig);
    } catch (err) {
      console.error('[useConfigPersistence] Failed to reset config:', err);
    }
  }, [resetConfig, setConfig]);

  return { loadConfig, saveConfig, resetAndReload };
}

/**
 * Hook: 系统状态轮询
 */
export function useSystemStatus(pollIntervalMs: number = 5000) {
  const setSystemStatus = useAppStore((s) => s.setSystemStatus);

  useEffect(() => {
    const poll = async () => {
      try {
        const status = await systemService.getSystemStatus();
        setSystemStatus({
          status: status.status,
          memoryUsedMB: status.memory_used_mb,
          memoryLimitMb: status.memory_limit_mb,
          cpuUsage: status.cpu_usage,
        });
      } catch (err) {
        // Backend may not be fully ready yet, silently ignore
      }
    };

    poll();
    const timer = setInterval(poll, pollIntervalMs);
    return () => clearInterval(timer);
  }, [setSystemStatus, pollIntervalMs]);
}

/**
 * Hook: 应用初始化
 * 在 App 挂载时调用，加载配置、刷新串口列表等
 */
export function useAppInit() {
  const { loadConfig } = useConfigPersistence();
  const { refreshPorts } = useSerialPorts(0);

  useEffect(() => {
    const init = async () => {
      await loadConfig();
      await refreshPorts();
    };
    init();
  }, [loadConfig, refreshPorts]);
}

/**
 * Hook: 模拟串口模式
 * 开启后串口列表会出现 SIM:Loopback 虚拟串口
 * 发送数据后会回显 "Received: xxx"，每5秒发送心跳
 */
export function useSimulation() {
  const simulationMode = useAppStore((s) => s.simulationMode);
  const setSimulationMode = useAppStore((s) => s.setSimulationMode);

  const toggleSimulation = useCallback(async () => {
    try {
      if (simulationMode) {
        await serialService.disableSimulation();
        setSimulationMode(false);
      } else {
        await serialService.enableSimulation();
        setSimulationMode(true);
      }
      // 刷新串口列表以显示/隐藏模拟串口
      const list = await serialService.listAvailablePorts();
      const merged = mergePorts(list.map(mapPortInfo), useAppStore.getState().ports);
      useAppStore.getState().setPorts(merged);
    } catch (err) {
      console.error('[useSimulation] Failed to toggle simulation:', err);
    }
  }, [simulationMode, setSimulationMode]);

  return { simulationMode, toggleSimulation };
}