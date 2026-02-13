import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { Command, CommandGroup } from '../types';

interface CommandState {
  groups: CommandGroup[];
  activeGroupId: string | null;
  loading: boolean;
  error: string | null;

  // Actions
  loadGroups: () => Promise<void>;
  saveGroup: (group: CommandGroup) => Promise<void>;
  deleteGroup: (id: string) => Promise<void>;
  setActiveGroup: (id: string | null) => void;
  executeCommand: (command: Command) => Promise<void>;
  importGroups: (json: string) => Promise<void>;
  exportGroups: (ids: string[]) => Promise<string>;
}

export const useCommandStore = create<CommandState>((set, get) => ({
  groups: [],
  activeGroupId: null,
  loading: false,
  error: null,

  loadGroups: async () => {
    set({ loading: true, error: null });
    try {
      const groups = await invoke<CommandGroup[]>('list_command_groups');
      set({ groups, loading: false });
    } catch (error) {
      set({ error: String(error), loading: false });
    }
  },

  saveGroup: async (group: CommandGroup) => {
    try {
      await invoke('save_command_group', { group });
      set((state) => {
        const existingIndex = state.groups.findIndex((g) => g.id === group.id);
        if (existingIndex >= 0) {
          const newGroups = [...state.groups];
          newGroups[existingIndex] = group;
          return { groups: newGroups };
        }
        return { groups: [...state.groups, group] };
      });
    } catch (error) {
      set({ error: String(error) });
    }
  },

  deleteGroup: async (id: string) => {
    try {
      await invoke('delete_command_group', { id });
      set((state) => ({
        groups: state.groups.filter((g) => g.id !== id),
        activeGroupId: state.activeGroupId === id ? null : state.activeGroupId,
      }));
    } catch (error) {
      set({ error: String(error) });
    }
  },

  setActiveGroup: (id: string | null) => {
    set({ activeGroupId: id });
  },

  executeCommand: async (command: Command) => {
    try {
      await invoke('send_data', { data: command.data, format: 'hex' });
    } catch (error) {
      set({ error: String(error) });
    }
  },

  importGroups: async (json: string) => {
    try {
      const groups = await invoke<CommandGroup[]>('import_commands', { json });
      set((state) => ({ groups: [...state.groups, ...groups] }));
    } catch (error) {
      set({ error: String(error) });
    }
  },

  exportGroups: async (ids: string[]) => {
    try {
      const json = await invoke<string>('export_commands', { ids });
      return json;
    } catch (error) {
      set({ error: String(error) });
      return '';
    }
  },
}));
