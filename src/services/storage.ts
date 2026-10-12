/**
 * 规则实体存储命令（命令集 / 高亮 / 协议模板 / 触发规则 / 端口预设 /
 * 端口工具配置 / 分组布局 / 端口元数据）。
 *
 * 实体载荷是 Rust 结构体（字段名即 wire 名），故这里直接把实体对象作为
 * `args` 传出——TS 侧的实体类型（`src/types`）本身就以 wire 名定义。
 * 参数约定见 `./tauri.ts` 文件头。
 */
import { invoke } from '@tauri-apps/api/core';
import type {
  HighlightRuleSet,
  AppConfig,
  PortGroup,
  PortMetaEntry,
  PortPreset,
  PortToolConfig,
  ProtocolTemplate,
  SendCommandSet,
  TriggerRule,
} from '../types';
import { useAppStore } from '../stores/useAppStore';

type RuleEntityKey = 'sendCommandSets' | 'highlightRuleSets' | 'protocolTemplates' | 'triggerRules' | 'portToolConfigs';

// Keep the last confirmed persisted entities separate from live editor drafts.
// Full-config reconciliation must recognize this window's own successful CRUD
// rather than mistake every change since startup for a competing writer.
async function loadRuleEntities<K extends RuleEntityKey>(key: K, pending: Promise<AppConfig[K]>): Promise<AppConfig[K]> {
  const baseline = useAppStore.getState().config[key];
  const items = await pending;
  if (useAppStore.getState().config[key] === baseline) useAppStore.getState().setConfig({ [key]: items });
  return items;
}

async function saveRuleEntity<K extends RuleEntityKey>(key: K, args: AppConfig[K][number], pending: Promise<string>): Promise<string> {
  const id = await pending;
  const saved = { ...args, id };
  const baseline = useAppStore.getState().config[key];
  const items = baseline.filter((item) => item.id !== id);
  const index = baseline.findIndex((item) => item.id === id);
  items.splice(index < 0 ? items.length : index, 0, saved);
  useAppStore.getState().setConfig({ [key]: items });
  return id;
}

async function deleteRuleEntity<K extends RuleEntityKey>(key: K, id: string, pending: Promise<void>): Promise<void> {
  await pending;
  useAppStore.getState().setConfig({ [key]: useAppStore.getState().config[key].filter((item) => item.id !== id) });
}

export const storageService = {
  saveCommandSet: (args: SendCommandSet): Promise<string> => {
    return saveRuleEntity('sendCommandSets', args, invoke<string>('save_command_set', { args }));
  },

  loadCommandSets: (): Promise<SendCommandSet[]> => {
    return loadRuleEntities('sendCommandSets', invoke<SendCommandSet[]>('load_command_sets'));
  },

  deleteCommandSet: (setId: string): Promise<void> => {
    return deleteRuleEntity('sendCommandSets', setId, invoke<void>('delete_command_set', { setId }));
  },

  saveHighlightSet: (args: HighlightRuleSet): Promise<string> => {
    return saveRuleEntity('highlightRuleSets', args, invoke<string>('save_highlight_set', { args }));
  },

  loadHighlightSets: (): Promise<HighlightRuleSet[]> => {
    return loadRuleEntities('highlightRuleSets', invoke<HighlightRuleSet[]>('load_highlight_sets'));
  },

  deleteHighlightSet: (setId: string): Promise<void> => {
    return deleteRuleEntity('highlightRuleSets', setId, invoke<void>('delete_highlight_set', { setId }));
  },

  saveProtocolTemplate: (args: ProtocolTemplate): Promise<string> => {
    return saveRuleEntity('protocolTemplates', args, invoke<string>('save_protocol_template', { args }));
  },

  loadProtocolTemplates: (): Promise<ProtocolTemplate[]> => {
    return loadRuleEntities('protocolTemplates', invoke<ProtocolTemplate[]>('load_protocol_templates'));
  },

  deleteProtocolTemplate: (setId: string): Promise<void> => {
    return deleteRuleEntity('protocolTemplates', setId, invoke<void>('delete_protocol_template', { setId }));
  },

  saveTriggerRule: (args: TriggerRule): Promise<string> => {
    return saveRuleEntity('triggerRules', args, invoke<string>('save_trigger_rule', { args }));
  },

  loadTriggerRules: (): Promise<TriggerRule[]> => {
    return loadRuleEntities('triggerRules', invoke<TriggerRule[]>('load_trigger_rules'));
  },

  deleteTriggerRule: (ruleId: string): Promise<void> => {
    return deleteRuleEntity('triggerRules', ruleId, invoke<void>('delete_trigger_rule', { ruleId }));
  },

  savePortPreset: (args: PortPreset): Promise<string> => {
    return invoke<string>('save_port_preset', { args });
  },

  loadPortPresets: (): Promise<PortPreset[]> => {
    return invoke<PortPreset[]>('load_port_presets');
  },

  deletePortPreset: (presetId: string): Promise<void> => {
    return invoke<void>('delete_port_preset', { presetId });
  },

  savePortToolConfig: (args: PortToolConfig): Promise<string> => {
    return saveRuleEntity('portToolConfigs', args, invoke<string>('save_port_tool_config', { args }));
  },

  loadPortToolConfigs: (): Promise<PortToolConfig[]> => {
    return loadRuleEntities('portToolConfigs', invoke<PortToolConfig[]>('load_port_tool_configs'));
  },

  deletePortToolConfig: (configId: string): Promise<void> => {
    return deleteRuleEntity('portToolConfigs', configId, invoke<void>('delete_port_tool_config', { configId }));
  },

  /** 整体替换保存串口分组布局（issue #2-3，前端分组变更后防抖调用）。
   *  读取随 get_config 返回的 AppConfig.portGroups，无单独 load 命令。 */
  savePortGroups: (groups: PortGroup[]): Promise<void> => {
    return invoke<void>('save_port_groups', { args: groups });
  },

  /** 整体替换保存串口备注名 / 隐藏状态（issue #4-9，前端端口元数据变更后防抖调用）。
   *  读取随 get_config 返回的 AppConfig.portMeta，无单独 load 命令。 */
  savePortMeta: (meta: PortMetaEntry[]): Promise<void> => {
    return invoke<void>('save_port_meta', { args: meta });
  },
};
