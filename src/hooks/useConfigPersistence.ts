import { useCallback } from 'react';
import type { SerialPort, AppConfig, PortMetaEntry } from '../types';
import { useAppStore } from '../stores/useAppStore';
import { useSystemStore } from '../stores/useSystemStore';
import { useRuleStore } from '../stores/useRuleStore';
import { configService, storageService } from '../services/tauri';
import { notifyError } from '../stores/useToastStore';

/**
 * 端口备注名 / 隐藏状态 / tty 模式 → config.portMeta 条目。
 *
 * 这三项只存在于端口列表（枚举产生，`mapPortInfo` 不携带），落盘时才投影成
 * portMeta。`saveConfig` 的安全快照与 useAppInit 的自动保存共用此函数，避免两处
 * 各自手写一遍过滤条件后悄悄漂移（漏一项就会被全量保存静默抹掉）。
 */
export function collectPortMeta(ports: SerialPort[]): PortMetaEntry[] {
  return ports
    .filter((p) => p.alias != null || p.isHidden || p.mode === 'tty')
    // issue #11：只有 tty 需要持久化（trx 是默认值，缺省即 trx）。
    .map((p) => ({ portId: p.id, alias: p.alias, isHidden: p.isHidden, mode: p.mode }));
}

/**
 * Hook: 配置持久化
 * 从后端加载配置、保存配置到后端
 */
export function useConfigPersistence() {
  const setConfig = useAppStore((s) => s.setConfig);
  const setUIState = useSystemStore((s) => s.setUIState);

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

  /**
   * 全量保存配置。`patch` 只用来覆盖**本次调用关心的普通字段**（如更新模式）；
   * 实体数组一律不取入参，见下方快照来源。
   *
   * 后端 `set_config` 是整体替换，所以调用方不能直接把 `useAppStore.config` 交出去：
   * 那是启动时读入的快照，而各实体数组有各自的权威来源（规则页的单条 ✓ 保存只写
   * useRuleStore / storageService，从不回写 store.config）。直接整体替换会把用户
   * 刚保存的规则、分组、预设静默回滚成启动时的样子。
   */
  const saveConfig = useCallback(async (patch?: Partial<AppConfig>) => {
    try {
      const state = useAppStore.getState();
      const rules = useRuleStore.getState();
      // 预设没有活镜像（唯一写路径是 storageService.savePortPresets），只能从后端
      // 读回；读不到就不写——宁可不保存，也不能用陈旧快照覆盖磁盘。
      const portPresets = await storageService.loadPortPresets();
      await configService.setConfig({
        ...state.config,
        ...patch,
        sendCommandSets: rules.sendCommandSets,
        highlightRuleSets: rules.highlightRuleSets,
        protocolTemplates: rules.protocolTemplates,
        triggerRules: rules.triggerRules,
        portToolConfigs: rules.portToolConfigs,
        portGroups: state.groups,
        portMeta: collectPortMeta(state.ports),
        portPresets,
      });
    } catch (err) {
      console.error('[useConfigPersistence] Failed to save config:', err);
      notifyError(err);
    }
  }, []);

  return { loadConfig, saveConfig };
}
