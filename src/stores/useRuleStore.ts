import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { HighlightRuleSet, SendCommandSet, ProtocolTemplate, PortToolConfig, TriggerRule } from '../types';

interface RuleState {
  highlightRuleSets: HighlightRuleSet[];
  activeHighlightSetId: string | null;
  protocolTemplates: ProtocolTemplate[];
  activeProtocolTemplateId: string | null;
  sendCommandSets: SendCommandSet[];
  activeSendCommandSetId: string | null;
  portToolConfigs: PortToolConfig[];

  setHighlightRuleSets: (sets: HighlightRuleSet[]) => void;
  addHighlightRuleSet: (set: HighlightRuleSet) => void;
  updateHighlightRuleSet: (setId: string, patch: Partial<HighlightRuleSet>) => void;
  removeHighlightRuleSet: (setId: string) => void;
  setActiveHighlightSetId: (id: string | null) => void;

  setProtocolTemplates: (templates: ProtocolTemplate[]) => void;
  addProtocolTemplate: (template: ProtocolTemplate) => void;
  updateProtocolTemplate: (templateId: string, patch: Partial<ProtocolTemplate>) => void;
  removeProtocolTemplate: (templateId: string) => void;
  setActiveProtocolTemplateId: (id: string | null) => void;

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
    activeHighlightSetId: null,
    protocolTemplates: [],
    activeProtocolTemplateId: null,
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
      if (state.activeHighlightSetId === setId) {
        state.activeHighlightSetId = state.highlightRuleSets[0]?.id ?? null;
      }
    }),
    setActiveHighlightSetId: (id) => set((state) => { state.activeHighlightSetId = id; }),

    setProtocolTemplates: (templates) => set((state) => { state.protocolTemplates = templates; }),
    addProtocolTemplate: (template) => set((state) => { state.protocolTemplates.push(template); }),
    updateProtocolTemplate: (templateId, patch) => set((state) => {
      const template = state.protocolTemplates.find((t) => t.id === templateId);
      if (template) Object.assign(template, patch);
    }),
    removeProtocolTemplate: (templateId) => set((state) => {
      state.protocolTemplates = state.protocolTemplates.filter((t) => t.id !== templateId);
    }),
    setActiveProtocolTemplateId: (id) => set((state) => { state.activeProtocolTemplateId = id; }),

    setSendCommandSets: (sets) => set((state) => { state.sendCommandSets = sets; }),
    addSendCommandSet: (cmdSet) => set((state) => { state.sendCommandSets.push(cmdSet); }),
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
