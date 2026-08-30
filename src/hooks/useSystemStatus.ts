import { useEffect } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { systemService } from '../services/tauri';

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
          memoryUsedMb: status.memoryUsedMb,
          cpuUsage: status.cpuUsage,
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
