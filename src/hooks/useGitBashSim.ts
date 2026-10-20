import { useCallback, useRef, useState } from 'react';
import { gitBashSimService } from '../services/tauri';
import { useSerialPorts } from './useSerialPorts';
import { notifyError } from '../stores/useToastStore';
import { DEV_FEATURES_ENABLED } from '../utils/devMode';

/**
 * Hook: GIT:BASH 模拟终端（issue #11）
 * 开启后串口列表会出现 GIT:BASH 虚拟端口（后端 spawn 本地 git bash pty），
 * 切到 TTY 模式即可交互验证（vim/top/readline/尺寸协商）。
 *
 * 仅调试模式可用（镜像 useSimulation 的 issue #2-9 双层门控）：release 构建
 * 下 UI 入口隐藏、此处再兜底 no-op，后端命令同样 `cfg(not(debug_assertions))` 拒绝。
 *
 * 模式状态用组件/模块局部 useState，不新增 store 字段（模式开关在 M1 的
 * `Port.mode` 上，这里只管「模拟终端进程是否在跑」）。
 */
export function useGitBashSim() {
  const [gitBashMode, setGitBashMode] = useState(false);
  const { refreshPorts } = useSerialPorts(0);
  const inFlightRef = useRef(false);

  const toggleGitBashSim = useCallback(async () => {
    if (!DEV_FEATURES_ENABLED || inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      if (gitBashMode) {
        await gitBashSimService.disableGitBashSim();
        setGitBashMode(false);
      } else {
        await gitBashSimService.enableGitBashSim();
        setGitBashMode(true);
      }
      // Refresh through the shared request sequence (see useSimulation).
      await refreshPorts();
    } catch (err) {
      console.error('[useGitBashSim] Failed to toggle git bash sim:', err);
      notifyError(err);
    } finally {
      inFlightRef.current = false;
    }
  }, [gitBashMode, refreshPorts]);

  return { gitBashMode, toggleGitBashSim };
}