import { useEffect } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { useRuleStore } from '../stores/useRuleStore';
import { configService, storageService } from '../services/tauri';
import type { PaneNode, SerialPort } from '../types';
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
      // 配置加载完成后才允许首次启动引导弹窗渲染，避免 hasSeenTour
      // 尚未从后端同步到 store 时引导一闪而过（loadConfig 内部已吞掉异常，
      // 此处无论成功与否都需要置位）
      useAppStore.getState().setUIState({ configLoaded: true });

      // Load persisted rule sets and command sets from config (entities now live in config.json)
      const cfg = useAppStore.getState().config;
      useRuleStore.getState().setSendCommandSets(cfg.sendCommandSets);
      useRuleStore.getState().setHighlightRuleSets(cfg.highlightRuleSets);
      useRuleStore.getState().setProtocolTemplates(cfg.protocolTemplates);
      useRuleStore.getState().setTriggerRules(cfg.triggerRules);
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
  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = useAppStore.subscribe((state, prevState) => {
      if (state.groups === prevState.groups) return;
      if (timeoutId !== null) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        timeoutId = null;
        storageService.savePortGroups(useAppStore.getState().groups).catch((e) => {
          console.warn('[useAppInit] Failed to auto-save port groups:', e);
        });
      }, 500);
    });
    return () => {
      unsubscribe();
      if (timeoutId !== null) clearTimeout(timeoutId);
    };
  }, []);
}
