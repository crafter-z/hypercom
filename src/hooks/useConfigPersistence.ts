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
  const setUIState = useAppStore((s) => s.setUIState);
  const resetConfig = useAppStore((s) => s.resetConfig);

  const loadConfig = useCallback(async () => {
    try {
      const config = await configService.getConfig();
      setConfig(config);
    } catch (err) {
      console.warn('[useConfigPersistence] Failed to load config, using defaults:', err);
    } finally {
      // issue #12 复审：config 就绪信号（失败时保留默认值同样置位）——
      // useAutoUpdate 等该信号再评估更新模式，替代旧 3s 启发式窗口
      // （config 加载超过 3s 会按默认 stable 误判用户设置的 none/preview）。
      setUIState({ configReady: true });
    }
  }, [setConfig, setUIState]);

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
