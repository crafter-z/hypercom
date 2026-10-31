import { useCallback, useRef } from 'react';
import { useSystemStore } from '../stores/useSystemStore';
import { serialService } from '../services/tauri';
import { notifyError } from '../stores/useToastStore';
import { useSerialPorts } from './useSerialPorts';
import { DEV_FEATURES_ENABLED } from '../utils/devMode';

/**
 * Hook: 模拟串口模式
 * 开启后串口列表会出现 SIM:Loopback / SIM:Loopback2 两路独立虚拟串口
 * 发送文本模式纯数字（如 `100`）即把周期输出频率切到每秒 N 次（0 = 停止），
 * 默认 2/s；输出为 `[SIM] Heartbeat #<seq>` 序号行（issue #14 高吞吐验证）。
 *
 * 仅调试模式可用（issue #2-9）：release 安装包不暴露模拟串口，
 * UI 入口（Sidebar 烧瓶按钮 / GuideCard）已按 `DEV_FEATURES_ENABLED` 隐藏，
 * 这里再做一层兜底，任何调用路径在 release 构建下都是 no-op。
 */
export function useSimulation() {
  const simulationMode = useSystemStore((s) => s.simulationMode);
  const setSimulationMode = useSystemStore((s) => s.setSimulationMode);
  const { refreshPorts } = useSerialPorts(0);
  const inFlightRef = useRef(false);

  const toggleSimulation = useCallback(async () => {
    if (!DEV_FEATURES_ENABLED || inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      if (simulationMode) {
        await serialService.disableSimulation();
        setSimulationMode(false);
      } else {
        await serialService.enableSimulation();
        setSimulationMode(true);
      }
      // Refresh through the shared request sequence so an earlier poll cannot
      // resolve later and drop the just-enabled virtual port.
      await refreshPorts();
    } catch (err) {
      console.error('[useSimulation] Failed to toggle simulation:', err);
      notifyError(err);
    } finally {
      inFlightRef.current = false;
    }
  }, [simulationMode, setSimulationMode, refreshPorts]);

  return { simulationMode, toggleSimulation };
}
