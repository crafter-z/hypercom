import { useCallback } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { useRuleStore } from '../stores/useRuleStore';
import { toolService } from '../services/tauri';
import { notifyError } from '../stores/useToastStore';

/**
 * 外部工具动作（issue #2-2）：侧边栏端口右键菜单与标签页右键菜单共用，
 * 保证两处「执行外部工具 / 终止外部工具 / 配置外部工具」内容与行为完全一致。
 *
 * - runTool：未配置该端口的工具 → 直接跳转配置弹窗「外部工具」页；
 *   已配置 → 置 `toolRunning` 并调用后端（后端负责 关串口→跑工具→流式输出→重开串口）。
 * - killTool：终止运行中的工具进程。
 * - configTool：打开配置弹窗「外部工具」页。
 */
export function usePortToolActions() {
  const updatePort = useAppStore((s) => s.updatePort);

  const runTool = useCallback(async (portId: string) => {
    const config = useRuleStore.getState().findToolConfigByPort(portId);
    if (!config) {
      // 未配置 → 跳转配置页
      useAppStore.getState().setConfigActiveTab('tools');
      useAppStore.getState().toggleConfigModal(true);
      return;
    }
    updatePort(portId, { toolRunning: true });
    try {
      await toolService.runPortTool({
        portId,
        command: config.command,
        workdir: config.workdir || undefined,
      });
    } catch (err) {
      updatePort(portId, { toolRunning: false });
      notifyError(err);
    }
  }, [updatePort]);

  const killTool = useCallback(async (portId: string) => {
    try {
      await toolService.killPortTool(portId);
    } catch (err) {
      notifyError(err);
    }
  }, []);

  const configTool = useCallback(() => {
    useAppStore.getState().setConfigActiveTab('tools');
    useAppStore.getState().toggleConfigModal(true);
  }, []);

  return { runTool, killTool, configTool };
}
