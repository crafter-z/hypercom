import { useEffect, useCallback } from 'react';
import { useAppStore, type AppStoreState } from '../stores/useAppStore';
import { serialService } from '../services/tauri';
import type { AvailablePortInfo } from '../services/tauri';
import type { SerialPort, PortStatus } from '../types';

/** 上一次端口列表刷新是否失败（用于连续失败时降级日志级别，避免 3s 轮询刷屏）。 */
let lastListFailed = false;
/** 所有 hook 实例共享的请求序号；旧轮询响应不得回写新枚举。 */
let latestListRequest = 0;

/**
 * 「幽灵」存活端口连续未出现在枚举中的次数（issue：串口热插拔后侧边栏状态
 * 卡死）：USB 拔出后读线程可能因空闲而永不报错（无 disconnected 事件），store
 * status 停在 connected，union-back 会把已消失的端口永续插回列表。这里按连续
 * 缺失轮数限制保留期——容忍瞬时 USB 抖动 / 睡眠恢复，但不允许永久幽灵。
 */
const ghostMissingPolls = new Map<string, number>();
/** 连续缺失 MAX_MISSING_POLLS 轮枚举后放弃保留（3s 轮询 ≈ 9 秒宽限）。 */
const MAX_MISSING_POLLS = 3;

/**
 * 将后端 PortInfo 映射为前端 SerialPort
 * 后端的 port_type 是 "real"|"virtual"，前端 PortStatus 需要从后端获取或默认 disconnected
 */
export function mapPortInfo(info: AvailablePortInfo): SerialPort {
  const type = info.port_type === 'sim' ? 'sim' : info.port_type === 'real' ? 'real' : 'virtual';
  return {
    id: info.id,
    name: info.name,
    alias: undefined,
    status: 'disconnected' as PortStatus,
    type: type as SerialPort['type'],
    isHidden: false,
    groupId: undefined,
    // issue #11：枚举出的端口默认传统收发模式；持久化的 mode 由 mergePorts 回填。
    mode: 'trx' as const,
  };
}

export function mergePorts(
  incoming: SerialPort[],
  existing: SerialPort[],
  portOrder: AppStoreState['portOrder'] = 'added',
): SerialPort[] {
  const incomingMap = new Map(incoming.map(p => [p.id, p]));
  const merged = new Map<string, SerialPort>();
  // Merge state independently of display order. Map insertion order preserves
  // manual arrangements; the default path projects the current enumeration below.
  for (const prev of existing) {
    const fresh = incomingMap.get(prev.id);
    if (fresh) {
      // 端口重新出现在枚举中（热插拔重插 / 上次打开失败后恢复）：`error` 是
      // 瞬时失败态（openPort 失败写入），新枚举证明端口现在可用——重置为
      // disconnected，这样「刷新按钮」能真正修复卡死的报错状态，无需重启。
      // connected / connecting 反映真实会话，必须保留。
      const status = prev.status === 'error' ? 'disconnected' : prev.status;
      // 端口仍在枚举中 → 幽灵计数清零
      ghostMissingPolls.delete(prev.id);
      merged.set(prev.id, {
        ...fresh,
        status,
        alias: prev.alias,
        isHidden: prev.isHidden,
        groupId: prev.groupId,
        baudRate: prev.baudRate,
        dataBits: prev.dataBits,
        parity: prev.parity,
        stopBits: prev.stopBits,
        handshake: prev.handshake,
        protocolTemplateId: prev.protocolTemplateId,
        toolRunning: prev.toolRunning,
        connectionGeneration: prev.connectionGeneration,
        // issue #11：保留持久化的工作模式，否则每 3s 轮询会把 TTY 重置回 TRX。
        mode: prev.mode,
        displayView: prev.displayView,
      });
    } else if (prev.status === 'connected' || prev.status === 'connecting') {
      // Union back any live port that transiently vanished from the enumeration
      // (USB glitch / sleep-resume). Dropping a connected/connecting port while
      // its tab/terminal still reference it causes store/backend drift; it
      // would reappear later as 'disconnected'.
      // issue：串口热插拔「幽灵端口」——拔出/重插后读线程可能不报错，端口从
      // 枚举消失而 status 停在 connected，无脑 union-back 会永远保留幽灵。
      // 按连续缺失轮数限制保留期：允许短暂抖动，但拔出后不产生永久幽灵。
      const missing = (ghostMissingPolls.get(prev.id) ?? 0) + 1;
      if (missing <= MAX_MISSING_POLLS) {
        ghostMissingPolls.set(prev.id, missing);
        merged.set(prev.id, prev);
      } else {
        // 超过宽限：放弃保留。端口从列表消失符合物理现实，重插 / 重启后
        // 会重新枚举出现。
        ghostMissingPolls.delete(prev.id);
      }
    }
  }
  // New ports recover persisted metadata and group membership in either order.
  for (const p of incoming) {
    if (!merged.has(p.id)) {
      const state = useAppStore.getState();
      const meta = state.config.portMeta?.find((entry) => entry.portId === p.id);
      // groupId lives on groups[].portIds; a re-plugged port is "new" to this
      // array but may still be a persisted group member. Without this backfill
      // Sidebar renders it both inside the group (portIds) and as ungrouped
      // (!port.groupId), producing duplicate dnd-kit ids.
      const groupId = state.groups.find((group) => group.portIds.includes(p.id))?.id;
      merged.set(p.id, meta
        ? { ...p, alias: meta.alias, isHidden: meta.isHidden, mode: meta.mode ?? 'trx', displayView: meta.displayView, groupId }
        : { ...p, groupId });
    }
  }
  if (portOrder === 'manual') return Array.from(merged.values());
  const ordered: SerialPort[] = [];
  for (const port of incoming) {
    const current = merged.get(port.id);
    if (current) {
      ordered.push(current);
      merged.delete(port.id);
    }
  }
  // Temporarily missing live ports retain their grace period, after fresh ports.
  ordered.push(...merged.values());
  return ordered;
}

/**
 * Hook: 自动刷新串口列表
 */
export function useSerialPorts(pollIntervalMs: number = 3000) {
  const setPorts = useAppStore((s) => s.setPorts);

  const refreshPorts = useCallback(async () => {
    const requestId = ++latestListRequest;
    try {
      const list = await serialService.listAvailablePorts();
      if (requestId !== latestListRequest) return;
      const state = useAppStore.getState();
      const merged = mergePorts(list.map(mapPortInfo), state.ports, state.portOrder);
      setPorts(merged);
      lastListFailed = false;
    } catch (err) {
      if (requestId !== latestListRequest) return;
      // 轮询每 3s 一次：连续失败时只在首次告警，后续降为 debug，避免刷屏。
      if (!lastListFailed) {
        console.warn('[useSerialPorts] Failed to list ports:', err);
      } else {
        console.debug('[useSerialPorts] Port listing still failing:', err);
      }
      lastListFailed = true;
    }
  }, [setPorts]);

  useEffect(() => {
    if (pollIntervalMs > 0) {
      refreshPorts();
      const timer = setInterval(refreshPorts, pollIntervalMs);
      return () => clearInterval(timer);
    }
  }, [refreshPorts, pollIntervalMs]);

  return { refreshPorts };
}
