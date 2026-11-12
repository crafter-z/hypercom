import { useEffect } from 'react';
import { useSystemStore } from '../stores/useSystemStore';
import { systemService } from '../services/tauri';

/**
 * Hook: 系统状态轮询
 */
export function useSystemStatus(pollIntervalMs: number = 5000) {
  const setSystemStatus = useSystemStore((s) => s.setSystemStatus);

  useEffect(() => {
    // A non-positive interval is the explicit opt-out used by callers that
    // only need the hook's API shape. Do not pass 0 to setInterval: browsers
    // clamp it to a busy ~1ms loop and can overwhelm the backend.
    if (pollIntervalMs <= 0) return;

    let requestId = 0;
    const poll = async () => {
      const id = ++requestId;
      try {
        const status = await systemService.getSystemStatus();
        // A slow earlier poll must not overwrite the result of a newer one.
        if (id !== requestId) return;
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
    return () => {
      requestId++;
      clearInterval(timer);
    };
  }, [setSystemStatus, pollIntervalMs]);
}
