import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type {
  DataBits,
  Handshake,
  LineEnding,
  Parity,
  StopBits,
} from '../types';

interface OperationState {
  baudRate: number;
  dataBits: DataBits;
  parity: Parity;
  stopBits: StopBits;
  handshake: Handshake;
  dtr: boolean;
  rts: boolean;
  ignoreEmptyChars: boolean;
  sendIsHex: boolean;
  sendAppendLineEnding: LineEnding;
  sendInput: string;
  /**
   * 每端口循环发送开关（portId → running）。多端口可并行循环，互不干扰；
   * 循环目标**绑定启动它的端口**，与当前聚焦/活动标签无关——切换聚焦不影响
   * 已在运行的循环（压测场景：COM3 循环启动后切到 COM4，COM3 继续发）。
   */
  cyclicLoops: Record<string, boolean>;

  setOpState: (patch: Partial<Omit<OperationState, 'setOpState' | 'setCyclicLoop' | 'cyclicLoops'>>) => void;
  setCyclicLoop: (portId: string, running: boolean) => void;
}

export const useOperationStore = create<OperationState>()(
  immer((set) => ({
    baudRate: 115200,
    dataBits: 8,
    parity: 'None',
    stopBits: 'One',
    handshake: 'None',
    dtr: false,
    rts: false,
    ignoreEmptyChars: false,
    sendIsHex: false,
    sendAppendLineEnding: '\\r\\n',
    sendInput: '',
    cyclicLoops: {},

    setOpState: (patch) => set((state) => {
      Object.assign(state, patch);
    }),

    // 每端口循环开关：running=true 启用该端口循环；false 停止。空 portId 为 no-op。
    setCyclicLoop: (portId, running) => set((state) => {
      if (!portId) return;
      if (running) {
        state.cyclicLoops[portId] = true;
      } else {
        delete state.cyclicLoops[portId];
      }
    }),
  }))
);
