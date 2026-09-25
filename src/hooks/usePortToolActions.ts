import { useCallback, useState } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { useSystemStore } from '../stores/useSystemStore';
import { useRuleStore } from '../stores/useRuleStore';
import { toolService } from '../services/tauri';
import { notifyError } from '../stores/useToastStore';
import { partitionGroupPorts } from '../utils/groupTool';
import type { PortGroup, SerialPort } from '../types';

/**
 * 外部工具动作（issue #2-2 / #5-7）：侧边栏端口/分组右键菜单与标签页右键菜单共用，
 * 保证各处「执行外部工具 / 终止外部工具 / 配置外部工具」内容与行为完全一致。
 *
 * - runTool：未配置该端口的工具 → 直接跳转配置弹窗「外部工具」页；
 *   已配置 → 置 `toolRunning` 并调用后端（后端负责 关串口→跑工具→流式输出→重开串口）。
 * - killTool：终止运行中的工具进程。
 * - configTool：打开配置弹窗「外部工具」页。
 * - runToolForGroup：整组执行（issue #5-7 / #7-9）——组内存在未正确配置（无配置或命令为空）
 *   的串口时把待确认内容写进 `toolDialog` 状态并由调用方渲染 GroupToolDialog，
 *   用户可选择仅运行已配置的串口或先去配置；全部已配置则直接**并行**执行
 *   （issue #7-9，跳过运行中串口）。
 *
 * 本 hook 只持有状态与动作，不 import 任何组件：弹窗由调用方渲染（Sidebar）。
 */

/** `toolDialog` 非空时调用方渲染 `GroupToolDialog` 所需的全部数据。 */
export interface GroupToolDialogState {
  group: PortGroup;
  configured: SerialPort[];
  unconfigured: SerialPort[];
}

/** 跳到配置弹窗的「外部工具」页（未配置 / 配置按钮 / 组执行警告三处共用同一动作：
 *  三处必须同时切页并开窗，漏一处就会打开在上一次的页签上）。 */
function openToolConfigPage(): void {
  const system = useSystemStore.getState();
  system.setConfigActiveTab('tools');
  system.toggleConfigModal(true);
}

export function usePortToolActions() {
  const updatePort = useAppStore((s) => s.updatePort);
  const [groupToolState, setGroupToolState] = useState<GroupToolDialogState | null>(null);

  const runTool = useCallback(async (portId: string) => {
    const config = useRuleStore.getState().findToolConfigByPort(portId);
    if (!config) {
      // 未配置 → 跳转配置页
      openToolConfigPage();
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
    openToolConfigPage();
  }, []);

  // issue #7-9：整组执行改为**并行**——组内每个已配置端口同时启动外部工具
  // （此前 100ms 节流串行，多端口组要等前一个跑完才轮到下一个）。
  // 每个端口执行前重新查 store 跳过已运行中的；单端口失败不中断整组
  // （runTool 内部已自行 toast 错误，此处仅防御性兜底）。
  const runConfiguredPorts = useCallback(async (configured: SerialPort[]) => {
    await Promise.all(
      configured.map(async (p) => {
        const port = useAppStore.getState().ports.find((x) => x.id === p.id);
        if (port?.toolRunning) return;
        try {
          await runTool(p.id);
        } catch {
          // 忽略：runTool 已通知错误
        }
      })
    );
  }, [runTool]);

  const runToolForGroup = useCallback((group: PortGroup) => {
    const { configured, unconfigured } = partitionGroupPorts(
      useAppStore.getState().ports,
      group,
      useRuleStore.getState().portToolConfigs,
    );
    if (configured.length === 0 || unconfigured.length > 0) {
      setGroupToolState({ group, configured, unconfigured });
      return;
    }
    void runConfiguredPorts(configured);
  }, [runConfiguredPorts]);

  // 弹窗渲染交给调用方（Sidebar）：本 hook 只暴露待确认数据与三个动作，
  // 避免 hook 层反向依赖组件层把 GroupToolDialog + i18n 拖进每个 leaf 消费方的依赖图。
  const closeToolDialog = useCallback(() => setGroupToolState(null), []);

  const runToolDialogConfigured = useCallback(() => {
    if (groupToolState) void runConfiguredPorts(groupToolState.configured);
    setGroupToolState(null);
  }, [groupToolState, runConfiguredPorts]);

  const configureToolFromDialog = useCallback(() => {
    setGroupToolState(null);
    openToolConfigPage();
  }, []);

  return {
    runTool,
    killTool,
    configTool,
    runToolForGroup,
    toolDialog: groupToolState,
    closeToolDialog,
    runToolDialogConfigured,
    configureToolFromDialog,
  };
}
