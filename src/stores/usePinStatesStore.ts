/**
 * Pin state store (Zustand + Immer).
 *
 * Holds the latest modem pin states per portId, emitted by the backend
 * through `serial:pin_states` events. UI components select the state for a
 * specific port to avoid re-rendering when other ports' pins change.
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

export interface PinStates {
  dtr: boolean;
  rts: boolean;
  cts: boolean;
  dsr: boolean;
  rlsd: boolean;
  ri: boolean;
}

interface PinStateStoreState {
  pinStates: Record<string, PinStates>;
  setPinStates: (portId: string, states: PinStates) => void;
}

export const usePinStatesStore = create<PinStateStoreState>()(
  immer((set) => ({
    pinStates: {},

    setPinStates: (portId, states) =>
      set((draft) => {
        draft.pinStates[portId] = states;
      }),
  }))
);
