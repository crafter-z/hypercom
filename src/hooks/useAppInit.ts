import { useEffect } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { useRuleStore } from '../stores/useRuleStore';
import { configService } from '../services/tauri';
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

      await refreshPorts();

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
}
