import { useCallback } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { serialService } from '../services/tauri';
import { notifyError } from '../stores/useToastStore';
import { mapPortInfo, mergePorts } from './useSerialPorts';
import { DEV_FEATURES_ENABLED } from '../utils/devMode';

/**
 * Hook: 模拟串口模式
 * 开启后串口列表会出现 SIM:Loopback 虚拟串口
 * 发送数据后会回显 "Received: xxx"，每5秒发送心跳
 *
 * 仅调试模式可用（issue #2-9）：release 安装包不暴露模拟串口，
 * UI 入口（Sidebar 烧瓶按钮 / GuideCard）已按 `DEV_FEATURES_ENABLED` 隐藏，
 * 这里再做一层兜底，任何调用路径在 release 构建下都是 no-op。
 */
export function useSimulation() {
  const simulationMode = useAppStore((s) => s.simulationMode);
  const setSimulationMode = useAppStore((s) => s.setSimulationMode);

  const toggleSimulation = useCallback(async () => {
    if (!DEV_FEATURES_ENABLED) return;
    try {
      if (simulationMode) {
        await serialService.disableSimulation();
        setSimulationMode(false);
      } else {
        await serialService.enableSimulation();
        setSimulationMode(true);
      }
      // 刷新串口列表以显示/隐藏模拟串口
      const list = await serialService.listAvailablePorts();
      const merged = mergePorts(list.map(mapPortInfo), useAppStore.getState().ports);
      useAppStore.getState().setPorts(merged);
    } catch (err) {
      console.error('[useSimulation] Failed to toggle simulation:', err);
      notifyError(err);
    }
  }, [simulationMode, setSimulationMode]);

  return { simulationMode, toggleSimulation };
}
