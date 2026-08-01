import { useEffect } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { useRuleStore } from '../stores/useRuleStore';
import { storageService, portToolConfigService } from '../services/tauri';
import type { CommandSetInfo, HighlightSetInfo, CommandInfo, HighlightRuleInfo, ProtocolTemplateInfo } from '../services/tauri';
import type { SendCommandSet, HighlightRuleSet, SendCommand, ProtocolTemplate, PaneNode, SerialPort } from '../types';
import { useConfigPersistence, syncLogSettingsToBackend } from './useConfigPersistence';
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

/** Map backend CommandSetInfo to frontend SendCommandSet */
export function mapCommandSetInfo(s: CommandSetInfo): SendCommandSet {
  return {
    id: s.id,
    name: s.name,
    isLoop: s.is_loop,
    loopDelay: s.loop_delay_ms,
    commands: s.commands.map((c: CommandInfo) => ({
      id: c.id,
      name: c.name,
      order: c.order_idx,
      delay: c.delay_ms,
      type: c.cmd_type as SendCommand['type'],
      content: c.content,
      appendLineEnding: c.append_line_ending as SendCommand['appendLineEnding'],
    })),
  };
}

/** Map backend HighlightSetInfo to frontend HighlightRuleSet */
export function mapHighlightSetInfo(s: HighlightSetInfo): HighlightRuleSet {
  return {
    id: s.id,
    name: s.name,
    isEnabled: s.is_enabled,
    rules: s.rules.map((r: HighlightRuleInfo) => ({
      id: r.id,
      name: r.name,
      pattern: r.pattern,
      isRegex: r.is_regex,
      color: r.color,
      bold: r.bold,
      italic: r.italic,
    })),
  };
}

/** Map backend ProtocolTemplateInfo to frontend ProtocolTemplate */
function mapProtocolTemplateInfo(s: ProtocolTemplateInfo): ProtocolTemplate {
  return {
    id: s.id,
    name: s.name,
    // SQLite stores is_enabled as i32 — coerce to a real boolean so the
    // frontend never sees a truthy number masquerading as a boolean.
    isEnabled: Boolean(s.is_enabled),
    headerBytes: s.header_bytes,
    lengthFieldOffset: s.length_field_offset,
    lengthFieldSize: s.length_field_size as 1 | 2,
    lengthEndian: s.length_endian as 'little' | 'big',
    lengthAdjust: s.length_adjust,
    checksumAlgorithm: s.checksum_algorithm as ProtocolTemplate['checksumAlgorithm'],
    checksumOffset: s.checksum_offset,
    footerBytes: s.footer_bytes,
    colorHeader: s.color_header,
    colorLength: s.color_length,
    colorPayload: s.color_payload,
    colorChecksum: s.color_checksum,
    colorFooter: s.color_footer,
  };
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
      const loaded = useAppStore.getState().config;
      await syncLogSettingsToBackend(loaded);
      // Load persisted rule sets and command sets at startup
      try {
        const [cmdSets, hlSets, protoTemplates, toolConfigs] = await Promise.all([
          storageService.loadCommandSets(),
          storageService.loadHighlightSets(),
          storageService.loadProtocolTemplates(),
          portToolConfigService.loadPortToolConfigs(),
        ]);
        useRuleStore.getState().setSendCommandSets(cmdSets.map(mapCommandSetInfo));
        useRuleStore.getState().setHighlightRuleSets(hlSets.map(mapHighlightSetInfo));
        useRuleStore.getState().setProtocolTemplates(protoTemplates.map(mapProtocolTemplateInfo));
        useRuleStore.getState().setPortToolConfigs(toolConfigs.map(c => ({
          id: c.id,
          name: c.name,
          portId: c.port_id,
          command: c.command,
          workdir: c.workdir,
        })));
      } catch (e) {
        console.warn('[useAppInit] Failed to load stored rules/commands:', e);
      }
      await refreshPorts();

      // F.3: Session restore — recreate tabs + paneTree from snapshot (no auto-connect)
      const cfg = useAppStore.getState().config;
      if (cfg.restoreSession && cfg.sessionSnapshot) {
        try {
          const snapshot = JSON.parse(cfg.sessionSnapshot) as {
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
        } catch (e) {
          console.warn('[useAppInit] Failed to restore session snapshot:', e);
        }
      }
    };
    init();
  }, [loadConfig, refreshPorts]);
}
