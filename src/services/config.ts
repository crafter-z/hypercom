/**
 * 应用配置命令（config.json 读写 + 会话快照）。
 *
 * 参数约定见 `./tauri.ts` 文件头。
 *
 * 无 `resetConfig` 包装：后端 `reset_config` 命令不存在，前端「恢复默认」是
 * `useAppStore.resetConfig()` 改内存后走 K5 安全快照 `set_config` 落盘——
 * 多一条后端命令只会多一个写路径。
 */
import { invoke } from '@tauri-apps/api/core';
import type { AppConfig } from '../types';

export const configService = {
  getConfig: (): Promise<AppConfig> => {
    return invoke<AppConfig>('get_config');
  },

  // A normal whole-config save must supply the revision read before composing its
  // snapshot; false means a concurrent writer won, so the caller must recompose.
  setConfig: (config: AppConfig, restorePluginConfigs = false, expectedRevision?: number): Promise<boolean> => {
    return invoke<boolean>('set_config', { newConfig: config, restorePluginConfigs, expectedRevision });
  },

  updateSessionSnapshot: (snapshot: string): Promise<void> => {
    return invoke<void>('update_session_snapshot', { snapshot });
  },

  getSessionSnapshot: (): Promise<string> => {
    return invoke<string>('get_session_snapshot');
  },

  getConfigPath: (): Promise<string> => {
    return invoke<string>('get_config_path');
  },
};
