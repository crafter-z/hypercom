import { useEffect } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { useRuleStore } from '../stores/useRuleStore';
import { configService, storageService } from '../services/tauri';
import type { PaneNode, SerialPort, PortMetaEntry } from '../types';
import { useConfigPersistence } from './useConfigPersistence';
import { useSerialPorts } from './useSerialPorts';

/** Validate a deserialized PaneNode tree structure (F.3 session restore). */
function isValidPaneNode(node: unknown): node is PaneNode {
  if (typeof node !== 'object' || node === null) return false;
  const obj = node as Record<string, unknown>;
  if (typeof obj.id !== 'string' || typeof obj.size !== 'number') return false;
  if (obj.type === 'leaf') return Array.isArray(obj.tabIds);
  if (obj.type === 'branch') {
    return (
      (obj.direction === 'horizontal' || obj.direction === 'vertical') &&
      Array.isArray(obj.children) &&
      (obj.children as unknown[]).every(isValidPaneNode)
    );
  }
  return false;
}

/**
 * Hook: 应用初始化
 * 在 App 挂载时调用，加载配置、刷新串口列表等
 */
export function useAppInit() {
  const { loadConfig } = useConfigPersistence();
  const { refreshPorts } = useSerialPorts(0);

  useEffect(() => {
    const init = async () => {
      await loadConfig();

      // Load persisted rule sets and command sets from config (entities now live in config.json)
      const cfg = useAppStore.getState().config;
      useRuleStore.getState().setSendCommandSets(cfg.sendCommandSets);
      useRuleStore.getState().setHighlightRuleSets(cfg.highlightRuleSets);
      useRuleStore.getState().setProtocolTemplates(cfg.protocolTemplates);
      // 迁移旧版残留的 bookmark 动作（从未实现，issue #3-1）：归一为 alert。
      // 旧 config.json 的 actionType 是任意字符串，用 String() 比较避免与
      // TriggerActionType 联合类型（已移除 'bookmark'）的不重叠比较错误。
      useRuleStore.getState().setTriggerRules(
        cfg.triggerRules.map((r) => (String(r.actionType) === 'bookmark' ? { ...r, actionType: 'alert' } : r))
      );
      useRuleStore.getState().setPortToolConfigs(cfg.portToolConfigs);

      // 串口分组恢复（issue #2-3）：分组布局持久化在 config.json。
      // setGroups 必须在下方 groups 自动保存订阅注册**之前**执行，
      // 否则启动载入本身会触发一次无意义的回写。
      useAppStore.getState().setGroups(cfg.portGroups ?? []);

      await refreshPorts();

      // 按持久化的分组成员关系回填 ports.groupId（端口由枚举产生，
      // 自身不记录分组；mergePorts 之后的每次轮询都会保留该字段）。
      for (const group of useAppStore.getState().groups) {
        for (const portId of group.portIds) {
          useAppStore.getState().updatePort(portId, { groupId: group.id });
        }
      }

      // 回填持久化的端口备注名 / 隐藏状态 / 工作模式（issue #4-9；模式 issue #11）：
      // 端口由枚举产生，`mapPortInfo` 不携带 alias/isHidden/mode，需从 config.portMeta 恢复。
      for (const meta of useAppStore.getState().config.portMeta ?? []) {
        useAppStore.getState().updatePort(meta.portId, {
          alias: meta.alias,
          isHidden: meta.isHidden,
          mode: meta.mode,
        });
      }

      // F.3: Session restore — recreate tabs + paneTree from snapshot (no auto-connect)
      if (cfg.restoreSession) {
        try {
          const sessionSnapshot = await configService.getSessionSnapshot();
          if (sessionSnapshot) {
            const snapshot = JSON.parse(sessionSnapshot) as {
              paneTree?: unknown;
              tabs?: Array<{ id: string; title: string; splitPaneId: string; isPinned: boolean }>;
              portConfigs?: Record<string, { baudRate: number; dataBits: number; parity: string; stopBits: string; handshake: string }>;
            };
            const availablePortIds = new Set(useAppStore.getState().ports.map((p) => p.id));
            const validTabs = (snapshot.tabs ?? []).filter((t) => availablePortIds.has(t.id));

            if (validTabs.length > 0) {
              // Apply saved port configs (baud rate etc.) without connecting
              for (const tab of validTabs) {
                const pc = snapshot.portConfigs?.[tab.id];
                if (pc) {
                  useAppStore.getState().updatePort(tab.id, {
                    baudRate: pc.baudRate,
                    dataBits: pc.dataBits as SerialPort['dataBits'],
                    parity: pc.parity as SerialPort['parity'],
                    stopBits: pc.stopBits as SerialPort['stopBits'],
                    handshake: pc.handshake as SerialPort['handshake'],
                  });
                }
              }

              // Validate and restore paneTree; fall back to default if corrupt
              let tree: PaneNode;
              if (isValidPaneNode(snapshot.paneTree)) {
                tree = snapshot.paneTree;
              } else {
                tree = { id: 'main', type: 'leaf', tabIds: validTabs.map((t) => t.id), size: 1 };
              }

              useAppStore.getState().restoreSessionSnapshot({ paneTree: tree, tabs: validTabs });
            }
          }
        } catch (e) {
          console.warn('[useAppInit] Failed to restore session snapshot:', e);
        }
      }
    };
    init();
  }, [loadConfig, refreshPorts]);

  // 分组自动保存（issue #2-3）：分组增删 / 重命名 / 展开折叠 / 拖拽成员等
  // 任何 groups 变更 → 500ms 防抖 → 整组列表回写 config.json（原子写 + .bak
  // 由后端 ConfigManager.save() 保证）。替代旧的「保存布局」手动按钮。
  // 与 App.tsx 会话快照订阅同款防抖写法；后台持久化失败只记日志不弹 toast，
  // 避免高频操作期间的重复打扰。
  // issue #4-10：落盘前同步回写 store.config.portGroups——否则 ConfigModal /
  // 主题切换等「全量保存 config」路径会用陈旧的 config.portGroups 覆盖掉
  // 本次保存的分组，导致重启后分组丢失。
  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    // issue #6-8：防抖 cleanup 原先只 clearTimeout，关窗/崩溃会丢最近 500ms 改动。
    // 兜底 flush：cleanup 时若仍有待触发防抖，同步保存一次再 clear。
    const flushGroups = () => {
      const groups = useAppStore.getState().groups;
      useAppStore.getState().setConfig({ portGroups: groups });
      storageService.savePortGroups(groups).catch((e) => {
        console.warn('[useAppInit] Failed to auto-save port groups:', e);
      });
    };
    const unsubscribe = useAppStore.subscribe((state, prevState) => {
      if (state.groups === prevState.groups) return;
      if (timeoutId !== null) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        timeoutId = null;
        flushGroups();
      }, 500);
    });
    return () => {
      unsubscribe();
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        flushGroups();
      }
    };
  }, []);

  // 端口元数据自动保存（备注名 / 隐藏状态，issue #4-9）：与分组同款防抖 +
  // 整体替换落盘。订阅用「别名/隐藏 签名」比较而非数组引用，因为 3s 端口轮询
  // 每次都会重建 ports 数组，但 mergePorts 保留了 alias/isHidden 值，签名不变
  // 就不会误触发。同样同步回写 store.config.portMeta，防全量保存覆盖。
  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let lastSignature = '';
    const computeSignature = () =>
      useAppStore
        .getState()
        .ports.filter((p) => p.alias != null || p.isHidden || p.mode === 'tty')
        // issue #11：签名纳入 mode，工厂 reset 或合并回 'trx' 时能正确触发回写。
        .map((p) => `${p.id}\u0001${p.alias ?? ''}\u0001${p.isHidden ? '1' : '0'}\u0001${p.mode ?? 'trx'}`)
        .join('\u0002');
    lastSignature = computeSignature();
    // issue #6-8：防抖 cleanup 兜底 flush（同分组 effect），关窗/崩溃不丢最近 500ms 改动。
    const flushMeta = () => {
      const state = useAppStore.getState();
      const meta: PortMetaEntry[] = state.ports
        .filter((p) => p.alias != null || p.isHidden || p.mode === 'tty')
        // issue #11：meta 携带 mode——只有 tty 需要持久化（trx 是默认值，缺省即 trx）。
        .map((p) => ({ portId: p.id, alias: p.alias, isHidden: p.isHidden, mode: p.mode }));
      state.setConfig({ portMeta: meta });
      storageService.savePortMeta(meta).catch((e) => {
        console.warn('[useAppInit] Failed to auto-save port meta:', e);
      });
    };
    const unsubscribe = useAppStore.subscribe((state, prevState) => {
      // 端口数组引用未变（仅流量/UI 等其它字段更新）时跳过，避免每次 TX/RX
      // 统计都重算签名；3s 轮询会重建数组但这不携带 alias/isHidden 变化，
      // 签名比较仍能正确去重。
      if (state.ports === prevState.ports) return;
      const sig = computeSignature();
      if (sig === lastSignature) return;
      lastSignature = sig;
      if (timeoutId !== null) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        timeoutId = null;
        flushMeta();
      }, 500);
    });
    return () => {
      unsubscribe();
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        flushMeta();
      }
    };
  }, []);
}
