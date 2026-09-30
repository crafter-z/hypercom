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
  PortGroup,
  PortMetaEntry,
  PortPreset,
  PortToolConfig,
  ProtocolTemplate,
  SendCommandSet,
  TriggerRule,
} from '../types';

export const storageService = {
  saveCommandSet: (args: SendCommandSet): Promise<string> => {
    return invoke<string>('save_command_set', { args });
  },

  loadCommandSets: (): Promise<SendCommandSet[]> => {
    return invoke<SendCommandSet[]>('load_command_sets');
  },

  deleteCommandSet: (setId: string): Promise<void> => {
    return invoke<void>('delete_command_set', { setId });
  },

  saveHighlightSet: (args: HighlightRuleSet): Promise<string> => {
    return invoke<string>('save_highlight_set', { args });
  },

  loadHighlightSets: (): Promise<HighlightRuleSet[]> => {
    return invoke<HighlightRuleSet[]>('load_highlight_sets');
  },

  deleteHighlightSet: (setId: string): Promise<void> => {
    return invoke<void>('delete_highlight_set', { setId });
  },

  saveProtocolTemplate: (args: ProtocolTemplate): Promise<string> => {
    return invoke<string>('save_protocol_template', { args });
  },

  loadProtocolTemplates: (): Promise<ProtocolTemplate[]> => {
    return invoke<ProtocolTemplate[]>('load_protocol_templates');
  },

  deleteProtocolTemplate: (setId: string): Promise<void> => {
    return invoke<void>('delete_protocol_template', { setId });
  },

  saveTriggerRule: (args: TriggerRule): Promise<string> => {
    return invoke<string>('save_trigger_rule', { args });
  },

  loadTriggerRules: (): Promise<TriggerRule[]> => {
    return invoke<TriggerRule[]>('load_trigger_rules');
  },

  deleteTriggerRule: (ruleId: string): Promise<void> => {
    return invoke<void>('delete_trigger_rule', { ruleId });
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
    return invoke<string>('save_port_tool_config', { args });
  },

  loadPortToolConfigs: (): Promise<PortToolConfig[]> => {
    return invoke<PortToolConfig[]>('load_port_tool_configs');
  },

  deletePortToolConfig: (configId: string): Promise<void> => {
    return invoke<void>('delete_port_tool_config', { configId });
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
