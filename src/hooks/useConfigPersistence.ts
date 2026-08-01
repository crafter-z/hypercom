import { useCallback } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { configService } from '../services/tauri';
import type { AppConfig } from '../types';
import { notifyError } from '../stores/useToastStore';

/**
 * Hook: 配置持久化
 * 从后端加载配置、保存配置到后端
 */
export function useConfigPersistence() {
  const setConfig = useAppStore((s) => s.setConfig);
  const resetConfig = useAppStore((s) => s.resetConfig);

  const loadConfig = useCallback(async () => {
    try {
      const config = await configService.getConfig();
      setConfig(config);
    } catch (err) {
      console.warn('[useConfigPersistence] Failed to load config, using defaults:', err);
    }
  }, [setConfig]);

  const saveConfig = useCallback(async (config: AppConfig) => {
    try {
      await configService.setConfig(config);
    } catch (err) {
      console.error('[useConfigPersistence] Failed to save config:', err);
      notifyError(err);
    }
  }, []);

  const resetAndReload = useCallback(async () => {
    try {
      const defaultConfig = await configService.resetConfig();
      resetConfig();
      setConfig(defaultConfig);
    } catch (err) {
      console.error('[useConfigPersistence] Failed to reset config:', err);
      notifyError(err);
    }
  }, [resetConfig, setConfig]);

  return { loadConfig, saveConfig, resetAndReload };
}
