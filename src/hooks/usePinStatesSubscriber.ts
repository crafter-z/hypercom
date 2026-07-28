import { useEffect } from 'react';
import { usePinStatesStore } from '../stores/usePinStatesStore';
import { eventService } from '../services/tauri';
import type { SerialPinStatesEvent } from '../services/tauri';

/**
 * Hook: 串口引脚状态订阅（事件监听生命周期）
 * 监听 `serial:pin_states` 事件并写入 PinStatesStore。
 * 在 App.tsx 中调用一次，全局唯一。
 */
export function usePinStatesSubscriber() {
  const setPinStates = usePinStatesStore((s) => s.setPinStates);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    const setup = async () => {
      unlisten = await eventService.onSerialPinStates((event: SerialPinStatesEvent) => {
        if (cancelled) return;
        setPinStates(event.port_id, {
          dtr: event.dtr,
          rts: event.rts,
          cts: event.cts,
          dsr: event.dsr,
          rlsd: event.rlsd,
          ri: event.ri,
        });
      });
    };
    setup().catch((e) => console.debug('[usePinStatesSubscriber] Failed to subscribe to pin states:', e));

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [setPinStates]);
}
