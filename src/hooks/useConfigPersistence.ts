import { useCallback } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { configService, logService } from '../services/tauri';
import type { AppConfig } from '../types';
import { notifyError } from '../stores/useToastStore';

/**
 * Push every log-related config field to the backend logger so the two sides
 * never drift. `logDirectory` is only synced when non-empty — an empty string
 * would wipe the backend's default log root. Individual failures are logged
 * and swallowed; a single unsupported setter must not abort the whole sync.
 */
export function syncLogSettingsToBackend(config: AppConfig): Promise<void> {
  return Promise.all([
    logService.setAutoSave(config.autoSaveLog).catch((e) => console.debug('[useTauri] setAutoSave failed:', e)),
    logService.setEncoding(config.logEncoding).catch((e) => console.debug('[useTauri] setEncoding failed:', e)),
    logService.setLogFilenameFormat(config.logFilenameFormat).catch((e) => console.debug('[useTauri] setLogFilenameFormat failed:', e)),
    logService.setLogSplitSize(config.logSplitSizeMb).catch((e) => console.debug('[useTauri] setLogSplitSize failed:', e)),
    logService.setLogSplitEnabled(config.logSplitEnabled).catch((e) => console.debug('[useTauri] setLogSplitEnabled failed:', e)),
    ...(config.logDirectory
      ? [logService.setLogDirectory(config.logDirectory).catch((e) => console.debug('[useTauri] setLogDirectory failed:', e))]
      : []),
  ]).then(() => undefined);
}

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
      await syncLogSettingsToBackend(config);
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
      await syncLogSettingsToBackend(defaultConfig);
    } catch (err) {
      console.error('[useConfigPersistence] Failed to reset config:', err);
      notifyError(err);
    }
  }, [resetConfig, setConfig]);

  return { loadConfig, saveConfig, resetAndReload };
}
