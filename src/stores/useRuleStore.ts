import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { HighlightRuleSet, SendCommandSet, ProtocolTemplate, PortToolConfig, TriggerRule } from '../types';

interface RuleState {
  highlightRuleSets: HighlightRuleSet[];
  protocolTemplates: ProtocolTemplate[];
  sendCommandSets: SendCommandSet[];
  activeSendCommandSetId: string | null;
  portToolConfigs: PortToolConfig[];

  setHighlightRuleSets: (sets: HighlightRuleSet[]) => void;
  addHighlightRuleSet: (set: HighlightRuleSet) => void;
  updateHighlightRuleSet: (setId: string, patch: Partial<HighlightRuleSet>) => void;
  removeHighlightRuleSet: (setId: string) => void;

  setProtocolTemplates: (templates: ProtocolTemplate[]) => void;
  addProtocolTemplate: (template: ProtocolTemplate) => void;
  updateProtocolTemplate: (templateId: string, patch: Partial<ProtocolTemplate>) => void;
  removeProtocolTemplate: (templateId: string) => void;

  setSendCommandSets: (sets: SendCommandSet[]) => void;
  addSendCommandSet: (set: SendCommandSet) => void;
  updateSendCommandSet: (setId: string, patch: Partial<SendCommandSet>) => void;
  removeSendCommandSet: (setId: string) => void;
  setActiveSendCommandSetId: (id: string | null) => void;

  setPortToolConfigs: (configs: PortToolConfig[]) => void;
  addPortToolConfig: (config: PortToolConfig) => void;
  updatePortToolConfig: (id: string, patch: Partial<PortToolConfig>) => void;
  removePortToolConfig: (id: string) => void;
  /** 按端口号查找工具配置（取第一个匹配） */
  findToolConfigByPort: (portId: string) => PortToolConfig | undefined;

  triggerRules: TriggerRule[];
  setTriggerRules: (rules: TriggerRule[]) => void;
  addTriggerRule: (rule: TriggerRule) => void;
  updateTriggerRule: (id: string, patch: Partial<TriggerRule>) => void;
  removeTriggerRule: (id: string) => void;
}

export const useRuleStore = create<RuleState>()(
  immer((set, get) => ({
    highlightRuleSets: [],
    protocolTemplates: [],
    sendCommandSets: [],
    activeSendCommandSetId: null,
    portToolConfigs: [],

    setHighlightRuleSets: (sets) => set((state) => { state.highlightRuleSets = sets; }),
    addHighlightRuleSet: (ruleSet) => set((state) => { state.highlightRuleSets.push(ruleSet); }),
    updateHighlightRuleSet: (setId, patch) => set((state) => {
      const ruleSet = state.highlightRuleSets.find((r) => r.id === setId);
      if (ruleSet) Object.assign(ruleSet, patch);
    }),
    removeHighlightRuleSet: (setId) => set((state) => {
      state.highlightRuleSets = state.highlightRuleSets.filter((r) => r.id !== setId);
    }),

    setProtocolTemplates: (templates) => set((state) => { state.protocolTemplates = templates; }),
    addProtocolTemplate: (template) => set((state) => { state.protocolTemplates.push(template); }),
    updateProtocolTemplate: (templateId, patch) => set((state) => {
      const template = state.protocolTemplates.find((t) => t.id === templateId);
      if (template) Object.assign(template, patch);
    }),
    removeProtocolTemplate: (templateId) => set((state) => {
      state.protocolTemplates = state.protocolTemplates.filter((t) => t.id !== templateId);
    }),

    setSendCommandSets: (sets) => set((state) => {
      state.sendCommandSets = sets;
      // 维持「有命令集时 activeSendCommandSetId 必指向有效集」不变量：
      // 当前激活集仍存在则保留，否则回退到第一个。修复 activeSendCommandSetId
      // 从不自动设置导致「配置了命令集但操作面板快捷区/循环发送无反应」。
      if (!sets.some((s) => s.id === state.activeSendCommandSetId)) {
        state.activeSendCommandSetId = sets[0]?.id ?? null;
      }
    }),
    addSendCommandSet: (cmdSet) => set((state) => {
      state.sendCommandSets.push(cmdSet);
      // 首个命令集自动激活，使快捷发送/循环发送立即可用。
      if (state.activeSendCommandSetId == null) {
        state.activeSendCommandSetId = cmdSet.id;
      }
    }),
    updateSendCommandSet: (setId, patch) => set((state) => {
      const commandSet = state.sendCommandSets.find((r) => r.id === setId);
      if (commandSet) Object.assign(commandSet, patch);
    }),
    removeSendCommandSet: (setId) => set((state) => {
      state.sendCommandSets = state.sendCommandSets.filter((r) => r.id !== setId);
      if (state.activeSendCommandSetId === setId) {
        state.activeSendCommandSetId = state.sendCommandSets[0]?.id ?? null;
      }
    }),
    setActiveSendCommandSetId: (id) => set((state) => { state.activeSendCommandSetId = id; }),

    setPortToolConfigs: (configs) => set((state) => { state.portToolConfigs = configs; }),
    addPortToolConfig: (config) => set((state) => { state.portToolConfigs.push(config); }),
    updatePortToolConfig: (id, patch) => set((state) => {
      const config = state.portToolConfigs.find((c) => c.id === id);
      if (config) Object.assign(config, patch);
    }),
    removePortToolConfig: (id) => set((state) => {
      state.portToolConfigs = state.portToolConfigs.filter((c) => c.id !== id);
    }),
    findToolConfigByPort: (portId) => {
      return get().portToolConfigs.find((c) => c.portId === portId);
    },

    triggerRules: [],
    setTriggerRules: (rules) => set((state) => { state.triggerRules = rules; }),
    addTriggerRule: (rule) => set((state) => { state.triggerRules.push(rule); }),
    updateTriggerRule: (id, patch) => set((state) => {
      const rule = state.triggerRules.find((r) => r.id === id);
      if (rule) Object.assign(rule, patch);
    }),
    removeTriggerRule: (id) => set((state) => {
      state.triggerRules = state.triggerRules.filter((r) => r.id !== id);
    }),
  }))
);
