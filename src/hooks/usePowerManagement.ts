import { useEffect } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { systemService } from '../services/tauri';
import { notifyError } from '../stores/useToastStore';

/**
 * Mirrors the `preventScreenOff` / `preventSleep` config flags to the OS
 * (Win32 `SetThreadExecutionState` via the backend).
 *
 * Extracted from ThemeProvider: power management is a system concern, not a
 * presentation one. Call once at the app root.
 */
export function usePowerManagement(): void {
  const preventScreenOff = useAppStore((s) => s.config.preventScreenOff);
  const preventSleep = useAppStore((s) => s.config.preventSleep);

  useEffect(() => {
    systemService.preventScreenOff(preventScreenOff).catch((e) => {
      console.debug('[usePowerManagement] preventScreenOff failed:', e);
      notifyError(e);
    });
  }, [preventScreenOff]);

  useEffect(() => {
    systemService.preventSleep(preventSleep).catch((e) => {
      console.debug('[usePowerManagement] preventSleep failed:', e);
      notifyError(e);
    });
  }, [preventSleep]);
}
