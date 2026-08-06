/**
 * 整组执行外部工具的分区辅助（issue #5-7）
 *
 * 把一组串口按「是否已正确配置外部工具」分成两桶：
 * - configured：端口在组内、未隐藏，且存在 portId 匹配的 PortToolConfig，
 *   且 `command.trim() !== ''`（workdir 为空串视为合法——可选）。
 * - unconfigured：组内未隐藏但未通过上述检查的端口。
 *
 * 纯函数、无 DOM 依赖，可在 vitest node 环境直接测试。
 */
import type { PortGroup, PortToolConfig, SerialPort } from '../types';

export interface GroupToolPartition {
  configured: SerialPort[];
  unconfigured: SerialPort[];
}

/** 该端口的工具配置是否"已正确配置"（配置存在 + 命令非空）。 */
function isConfiguredPort(port: SerialPort, toolConfigs: PortToolConfig[]): boolean {
  const config = toolConfigs.find((c) => c.portId === port.id);
  return !!config && config.command.trim() !== '';
}

/**
 * 按组划分端口。仅统计组内未隐藏端口；组外端口（含已配置工具的）一律忽略。
 * 两桶均保持入参 `ports` 的迭代顺序。
 */
export function partitionGroupPorts(
  ports: SerialPort[],
  group: PortGroup,
  toolConfigs: PortToolConfig[],
): GroupToolPartition {
  const configured: SerialPort[] = [];
  const unconfigured: SerialPort[] = [];
  for (const port of ports) {
    if (!group.portIds.includes(port.id) || port.isHidden) continue;
    (isConfiguredPort(port, toolConfigs) ? configured : unconfigured).push(port);
  }
  return { configured, unconfigured };
}
