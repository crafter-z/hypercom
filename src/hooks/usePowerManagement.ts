import { useEffect } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { systemService } from '../services/tauri';
import { notifyError } from '../stores/useToastStore';

type PowerSetting = 'preventScreenOff' | 'preventSleep';

// Each setting has a single serialized lane. When a newer value arrives while
// an invoke is pending, the lane replays the latest value after that invoke,
// preventing an older completion from becoming the final OS state.
const lanes: Record<PowerSetting, { running: boolean; pending: boolean; value: boolean }> = {
  preventScreenOff: { running: false, pending: false, value: false },
  preventSleep: { running: false, pending: false, value: false },
};

async function applyPowerSetting(setting: PowerSetting, value: boolean): Promise<void> {
  const lane = lanes[setting];
  lane.value = value;
  lane.pending = true;
  if (lane.running) return;
  lane.running = true;
  try {
    while (lane.pending) {
      lane.pending = false;
      try {
        if (setting === 'preventScreenOff') await systemService.preventScreenOff(lane.value);
        else await systemService.preventSleep(lane.value);
      } catch (e) {
        console.debug(`[usePowerManagement] ${setting} failed:`, e);
        notifyError(e);
      }
    }
  } finally {
    lane.running = false;
  }
}

/** Mirrors power-prevention config flags to the OS through serialized lanes. */
export function usePowerManagement(): void {
  const preventScreenOff = useAppStore((s) => s.config.preventScreenOff);
  const preventSleep = useAppStore((s) => s.config.preventSleep);

  useEffect(() => {
    void applyPowerSetting('preventScreenOff', preventScreenOff);
  }, [preventScreenOff]);

  useEffect(() => {
    void applyPowerSetting('preventSleep', preventSleep);
  }, [preventSleep]);
}
