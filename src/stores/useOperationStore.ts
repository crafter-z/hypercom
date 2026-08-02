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
  isLoopSending: boolean;

  setOpState: (patch: Partial<Omit<OperationState, 'setOpState'>>) => void;
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
    isLoopSending: false,

    setOpState: (patch) => set((state) => {
      Object.assign(state, patch);
    }),
  }))
);
