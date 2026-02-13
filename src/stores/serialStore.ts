import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { SerialConfig, SerialStatus, PortInfo, DataPacket } from '../types';
import { DEFAULT_SERIAL_CONFIG } from '../types';

interface SerialState {
  status: SerialStatus;
  ports: PortInfo[];
  config: SerialConfig;
  receivedData: DataPacket[];
  error: string | null;
  
  // Actions
  refreshPorts: () => Promise<void>;
  connect: (config: SerialConfig) => Promise<void>;
  disconnect: () => Promise<void>;
  sendData: (data: string, format: 'hex' | 'ascii') => Promise<void>;
  clearData: () => void;
  setConfig: (config: Partial<SerialConfig>) => void;
  setError: (error: string | null) => void;
}

export const useSerialStore = create<SerialState>((set, get) => ({
  status: 'closed',
  ports: [],
  config: DEFAULT_SERIAL_CONFIG,
  receivedData: [],
  error: null,

  refreshPorts: async () => {
    try {
      const ports = await invoke<PortInfo[]>('list_ports');
      set({ ports });
    } catch (error) {
      set({ error: String(error) });
    }
  },

  connect: async (config: SerialConfig) => {
    try {
      set({ error: null });
      await invoke('open_port', { config });
      set({ status: 'open', config });
    } catch (error) {
      set({ status: 'error', error: String(error) });
    }
  },

  disconnect: async () => {
    try {
      await invoke('close_port');
      set({ status: 'closed' });
    } catch (error) {
      set({ error: String(error) });
    }
  },

  sendData: async (data: string, format: 'hex' | 'ascii') => {
    try {
      await invoke('send_data', { data, format });
      // 添加到已发送数据列表
      const packet: DataPacket = {
        id: crypto.randomUUID(),
        data,
        timestamp: Date.now(),
        direction: 'tx',
        format,
      };
      set((state) => ({
        receivedData: [...state.receivedData, packet],
      }));
    } catch (error) {
      set({ error: String(error) });
    }
  },

  clearData: () => {
    set({ receivedData: [] });
  },

  setConfig: (config: Partial<SerialConfig>) => {
    set((state) => ({
      config: { ...state.config, ...config },
    }));
  },

  setError: (error: string | null) => {
    set({ error });
  },
}));

// 初始化事件监听
export const initSerialEventListeners = async () => {
  // 监听接收到的数据
  await listen<DataPacket>('serial:data-received', (event) => {
    const packet = event.payload;
    useSerialStore.getState().receivedData.push(packet);
  });

  // 监听状态变化
  await listen<{ status: SerialStatus }>('serial:status-changed', (event) => {
    useSerialStore.setState({ status: event.payload.status });
  });

  // 监听错误
  await listen<{ message: string }>('serial:error', (event) => {
    useSerialStore.setState({ error: event.payload.message, status: 'error' });
  });
};
