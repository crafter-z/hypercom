import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { AppSettings, DisplaySettings, LogSettings } from '../types';
import { DEFAULT_SETTINGS } from '../types';

interface SettingsState {
  settings: AppSettings;
  loading: boolean;
  error: string | null;

  // Actions
  loadSettings: () => Promise<void>;
  saveSettings: () => Promise<void>;
  updateDisplay: (display: Partial<DisplaySettings>) => void;
  updateLog: (log: Partial<LogSettings>) => void;
  setTheme: (theme: 'light' | 'dark' | 'system') => void;
  setFontSize: (size: number) => void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loading: false,
  error: null,

  loadSettings: async () => {
    set({ loading: true, error: null });
    try {
      const settings = await invoke<AppSettings>('get_settings');
      set({ settings: settings || DEFAULT_SETTINGS, loading: false });
      
      // 应用主题
      const theme = settings?.display?.theme || 'system';
      applyTheme(theme);
      
      // 应用字体大小
      const fontSize = settings?.display?.fontSize || 14;
      document.documentElement.style.setProperty('--terminal-font-size', `${fontSize}px`);
    } catch (error) {
      set({ settings: DEFAULT_SETTINGS, loading: false });
    }
  },

  saveSettings: async () => {
    try {
      await invoke('save_settings', { settings: get().settings });
    } catch (error) {
      set({ error: String(error) });
    }
  },

  updateDisplay: (display: Partial<DisplaySettings>) => {
    set((state) => ({
      settings: {
        ...state.settings,
        display: { ...state.settings.display, ...display },
      },
    }));
    get().saveSettings();
  },

  updateLog: (log: Partial<LogSettings>) => {
    set((state) => ({
      settings: {
        ...state.settings,
        log: { ...state.settings.log, ...log },
      },
    }));
    get().saveSettings();
  },

  setTheme: (theme: 'light' | 'dark' | 'system') => {
    applyTheme(theme);
    get().updateDisplay({ theme });
  },

  setFontSize: (size: number) => {
    document.documentElement.style.setProperty('--terminal-font-size', `${size}px`);
    get().updateDisplay({ fontSize: size });
  },
}));

// 应用主题
function applyTheme(theme: 'light' | 'dark' | 'system') {
  const root = document.documentElement;
  
  if (theme === 'system') {
    const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.classList.toggle('dark', isDark);
  } else {
    root.classList.toggle('dark', theme === 'dark');
  }
}

// 监听系统主题变化
if (typeof window !== 'undefined') {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    const theme = useSettingsStore.getState().settings.display.theme;
    if (theme === 'system') {
      document.documentElement.classList.toggle('dark', e.matches);
    }
  });
}
