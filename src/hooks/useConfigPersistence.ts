import { useCallback } from 'react';
import type { SerialPort, AppConfig, PortMetaEntry } from '../types';
import { useAppStore } from '../stores/useAppStore';
import { useSystemStore } from '../stores/useSystemStore';
import { useRuleStore } from '../stores/useRuleStore';
import { configService, storageService } from '../services/tauri';
import { notifyError } from '../stores/useToastStore';
import { commitUpdateMode } from '../utils/updateService';

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

/** An absent port cannot be edited from this window. Keep its latest persisted
 * metadata; ports currently in the list are authoritative, including clearing
 * alias/hidden/TTY (which removes their entry altogether). */
export function mergePortMeta(ports: SerialPort[], persisted: PortMetaEntry[]): PortMetaEntry[] {
  const present = new Set(ports.map((port) => port.id));
  return [...persisted.filter((entry) => !present.has(entry.portId)), ...collectPortMeta(ports)];
}

// Serialize metadata and full-config writes from this webview. In particular, a
// debounced older snapshot must not finish after a newer clear and restore it.
let lastConfigWrite: Promise<void> = Promise.resolve();
function enqueueConfigWrite<T>(work: () => Promise<T>): Promise<T> {
  const result = lastConfigWrite.then(work);
  lastConfigWrite = result.then(() => undefined, () => undefined);
  return result;
}

/** Auto-save only the metadata while preserving backend-owned config fields.
 * The backend's revision check retries if another writer commits in flight. */
export function saveCurrentPortMeta(): Promise<void> {
  return enqueueConfigWrite(async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const persisted = await configService.getConfig();
      if (persisted.revision === undefined) throw new Error('Backend config revision is missing');
      const portMeta = mergePortMeta(useAppStore.getState().ports, persisted.portMeta);
      if (await configService.setConfig({ ...persisted, portMeta }, false, persisted.revision)) return;
    }
    throw new Error('Config changed during port metadata save; please try again');
  });
}

/** Preserve local edits on untouched entities; a newer backend CRUD change
 * to the same ID wins instead of being silently reverted by full save. */
function reconcileEntities<T>(live: T[], initial: T[], persisted: T[], id: (item: T) => string): T[] {
  const old = new Map(initial.map((item) => [id(item), item]));
  const current = new Map(persisted.map((item) => [id(item), item]));
  const result = live.flatMap((item) => {
    const fromDisk = current.get(id(item));
    return JSON.stringify(old.get(id(item))) !== JSON.stringify(fromDisk)
      ? (fromDisk ? [fromDisk] : []) : [item];
  });
  const seen = new Set(live.map(id));
  for (const item of persisted) {
    if (!seen.has(id(item)) && JSON.stringify(old.get(id(item))) !== JSON.stringify(item)) {
      result.push(item);
    }
  }
  return result;
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
      commitUpdateMode(config.updateCheckMode);
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
   * `fieldOnly=true` applies just the patch to a fresh backend config (dialog actions),
   * preserving unrelated settings drafts and independently persisted entities.
   * 全量保存配置。`patch` 只用来覆盖**本次调用关心的普通字段**（如更新模式）；
   * 实体数组一律不取入参，见下方快照来源。
   *
   * 后端 `set_config` 是整体替换，所以调用方不能直接把 `useAppStore.config` 交出去：
   * 那是启动时读入的快照，而各实体数组有各自的权威来源（规则页的单条 ✓ 保存只写
   * useRuleStore / storageService，从不回写 store.config）。直接整体替换会把用户
   * 刚保存的规则、分组、预设静默回滚成启动时的样子。
   */
  const saveConfig = useCallback((patch?: Partial<AppConfig>, fieldOnly = false) => enqueueConfigWrite(async () => {
    try {
      // Retry reads fresh backend state and current live stores each time.
      // Read the backend revision BEFORE any async entity load. A CRUD write
      // during that wait (or while invoke is in flight) must invalidate the
      // snapshot, not be overwritten by the later full replacement.
      for (let attempt = 0; attempt < 5; attempt++) {
        const persisted = await configService.getConfig();
        const { revision } = persisted;
        if (revision === undefined) throw new Error('Backend config revision is missing');
        // Presets have no frontend live mirror. A failed read must abort the save.
        const portPresets = fieldOnly ? persisted.portPresets : await storageService.loadPortPresets();
        // These stores are read AFTER the await on every attempt, never from a
        // snapshot captured when the save began.
        const state = useAppStore.getState();
        const rules = useRuleStore.getState();
        const initial = state.config;
        // Plugin authorizations are preserved by set_config under plugin_io.
        // A dialog's single-field write must preserve persisted settings/entities,
        // not commit an unrelated open Settings draft.
        const candidate: AppConfig = fieldOnly ? { ...persisted, ...patch } : {
          ...state.config,
          ...patch,
          sendCommandSets: reconcileEntities(rules.sendCommandSets, initial.sendCommandSets, persisted.sendCommandSets, (item) => item.id),
          highlightRuleSets: reconcileEntities(rules.highlightRuleSets, initial.highlightRuleSets, persisted.highlightRuleSets, (item) => item.id),
          protocolTemplates: reconcileEntities(rules.protocolTemplates, initial.protocolTemplates, persisted.protocolTemplates, (item) => item.id),
          triggerRules: reconcileEntities(rules.triggerRules, initial.triggerRules, persisted.triggerRules, (item) => item.id),
          portToolConfigs: reconcileEntities(rules.portToolConfigs, initial.portToolConfigs, persisted.portToolConfigs, (item) => item.id),
          portGroups: state.groups,
          portMeta: mergePortMeta(state.ports, persisted.portMeta),
          portPresets,
        };
        const saved = await configService.setConfig(candidate, false, revision);
        if (saved) {
          commitUpdateMode(candidate.updateCheckMode, true);
          return true;
        }
      }
      throw new Error('Config changed during save; please try again');
    } catch (err) {
      console.error('[useConfigPersistence] Failed to save config:', err);
      notifyError(err);
      return false;
    }
  }), []);

  return { loadConfig, saveConfig };
}
