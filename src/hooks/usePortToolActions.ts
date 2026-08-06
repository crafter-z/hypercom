import React, { useCallback, useState } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { useRuleStore } from '../stores/useRuleStore';
import { toolService } from '../services/tauri';
import { notifyError } from '../stores/useToastStore';
import { partitionGroupPorts } from '../utils/groupTool';
import type { PortGroup, SerialPort } from '../types';
import GroupToolDialog from '../components/shared/GroupToolDialog';

/**
 * 外部工具动作（issue #2-2 / #5-7）：侧边栏端口/分组右键菜单与标签页右键菜单共用，
 * 保证各处「执行外部工具 / 终止外部工具 / 配置外部工具」内容与行为完全一致。
 *
 * - runTool：未配置该端口的工具 → 直接跳转配置弹窗「外部工具」页；
 *   已配置 → 置 `toolRunning` 并调用后端（后端负责 关串口→跑工具→流式输出→重开串口）。
 * - killTool：终止运行中的工具进程。
 * - configTool：打开配置弹窗「外部工具」页。
 * - runToolForGroup：整组执行（issue #5-7）——组内存在未正确配置（无配置或命令为空）
 *   的串口时弹出 GroupToolDialog 警告，用户可选择仅运行已配置的串口或先去配置；
 *   全部已配置则直接顺序执行（100ms 节流，跳过运行中串口）。
 */
export function usePortToolActions() {
  const updatePort = useAppStore((s) => s.updatePort);
  const [groupToolState, setGroupToolState] = useState<{
    group: PortGroup;
    configured: SerialPort[];
    unconfigured: SerialPort[];
  } | null>(null);

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

  // 顺序执行已配置端口（100ms 节流，与 connectAll / Pane.tsx 批量开关同款）。
  // 每个端口执行前重新查 store 跳过已运行中的；单端口失败不中断整组
  // （runTool 内部已自行 toast 错误，此处仅防御性兜底）。
  const runConfiguredPorts = useCallback(async (configured: SerialPort[]) => {
    for (const p of configured) {
      const port = useAppStore.getState().ports.find((x) => x.id === p.id);
      if (port?.toolRunning) continue;
      try {
        await runTool(p.id);
      } catch {
        // 忽略：runTool 已通知错误
      }
      await new Promise((r) => setTimeout(r, 100));
    }
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

  // 本文件为 .ts（无 JSX 解析），弹窗元素用 createElement 构建。
  const groupToolDialog = groupToolState
    ? React.createElement(GroupToolDialog, {
        group: groupToolState.group,
        configured: groupToolState.configured,
        unconfigured: groupToolState.unconfigured,
        onRun: () => {
          const configured = groupToolState.configured;
          setGroupToolState(null);
          void runConfiguredPorts(configured);
        },
        onConfigure: () => {
          setGroupToolState(null);
          useAppStore.getState().setConfigActiveTab('tools');
          useAppStore.getState().toggleConfigModal(true);
        },
        onClose: () => setGroupToolState(null),
      })
    : null;

  return { runTool, killTool, configTool, runToolForGroup, groupToolDialog };
}
