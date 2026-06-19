import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type {
  DataBits,
  DisplayFormat,
  Encoding,
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
  scrollLocked: boolean;
  showTimestamp: boolean;
  displayFormat: DisplayFormat;
  encoding: Encoding;
  sendIsHex: boolean;
  sendAppendLineEnding: LineEnding;
  sendInput: string;
  isLoopSending: boolean;
  loopInterval: number;

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
    scrollLocked: true,
    showTimestamp: true,
    displayFormat: 'string',
    encoding: 'ASCII',
    sendIsHex: false,
    sendAppendLineEnding: '\\r\\n',
    sendInput: '',
    isLoopSending: false,
    loopInterval: 500,

    setOpState: (patch) => set((state) => {
      Object.assign(state, patch);
    }),
  }))
);
