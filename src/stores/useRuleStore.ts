import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { HighlightRuleSet, SendCommandSet } from '../types';

interface RuleState {
  highlightRuleSets: HighlightRuleSet[];
  activeHighlightSetId: string | null;
  sendCommandSets: SendCommandSet[];
  activeSendCommandSetId: string | null;

  setHighlightRuleSets: (sets: HighlightRuleSet[]) => void;
  addHighlightRuleSet: (set: HighlightRuleSet) => void;
  updateHighlightRuleSet: (setId: string, patch: Partial<HighlightRuleSet>) => void;
  removeHighlightRuleSet: (setId: string) => void;
  setActiveHighlightSetId: (id: string | null) => void;

  setSendCommandSets: (sets: SendCommandSet[]) => void;
  addSendCommandSet: (set: SendCommandSet) => void;
  updateSendCommandSet: (setId: string, patch: Partial<SendCommandSet>) => void;
  removeSendCommandSet: (setId: string) => void;
  setActiveSendCommandSetId: (id: string | null) => void;
}

export const useRuleStore = create<RuleState>()(
  immer((set) => ({
    highlightRuleSets: [],
    activeHighlightSetId: null,
    sendCommandSets: [],
    activeSendCommandSetId: null,

    setHighlightRuleSets: (sets) => set((state) => { state.highlightRuleSets = sets; }),
    addHighlightRuleSet: (ruleSet) => set((state) => { state.highlightRuleSets.push(ruleSet); }),
    updateHighlightRuleSet: (setId, patch) => set((state) => {
      const ruleSet = state.highlightRuleSets.find((r) => r.id === setId);
      if (ruleSet) Object.assign(ruleSet, patch);
    }),
    removeHighlightRuleSet: (setId) => set((state) => {
      state.highlightRuleSets = state.highlightRuleSets.filter((r) => r.id !== setId);
    }),
    setActiveHighlightSetId: (id) => set((state) => { state.activeHighlightSetId = id; }),

    setSendCommandSets: (sets) => set((state) => { state.sendCommandSets = sets; }),
    addSendCommandSet: (cmdSet) => set((state) => { state.sendCommandSets.push(cmdSet); }),
    updateSendCommandSet: (setId, patch) => set((state) => {
      const commandSet = state.sendCommandSets.find((r) => r.id === setId);
      if (commandSet) Object.assign(commandSet, patch);
    }),
    removeSendCommandSet: (setId) => set((state) => {
      state.sendCommandSets = state.sendCommandSets.filter((r) => r.id !== setId);
    }),
    setActiveSendCommandSetId: (id) => set((state) => { state.activeSendCommandSetId = id; }),
  }))
);
