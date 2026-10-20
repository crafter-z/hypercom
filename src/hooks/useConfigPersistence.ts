import { useCallback } from 'react';
import type { SerialPort, AppConfig, PortMetaEntry } from '../types';
import { useAppStore } from '../stores/useAppStore';
import { useSystemStore } from '../stores/useSystemStore';
import { useRuleStore } from '../stores/useRuleStore';
import { configService, storageService } from '../services/tauri';
import { notifyError } from '../stores/useToastStore';
import { commitUpdateMode, getCommittedUpdateMode } from '../utils/updateService';

/**
 * 端口备注名 / 隐藏状态 / tty 模式 → config.portMeta 条目。
 *
 * 这三项只存在于端口列表（枚举产生，`mapPortInfo` 不携带），落盘时才投影成
 * portMeta。`saveConfig` 的安全快照与 useAppInit 的自动保存共用此函数，避免两处
 * 各自手写一遍过滤条件后悄悄漂移（漏一项就会被全量保存静默抹掉）。
 */
export function collectPortMeta(ports: SerialPort[]): PortMetaEntry[] {
  return ports
    .filter((p) => p.alias != null || p.isHidden || p.mode === 'tty' || p.displayView != null)
    .map((p) => ({ portId: p.id, alias: p.alias, isHidden: p.isHidden, mode: p.mode, displayView: p.displayView }));
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
 * The backend's revision check retries if another writer commits in flight.
 * `snapshot` lets the debounced caller capture the edit-time state: a port
 * unplugged inside the debounce window must not drop its just-edited metadata. */
export function saveCurrentPortMeta(
  snapshot?: { entries: PortMetaEntry[]; presentIds: string[] },
): Promise<void> {
  return enqueueConfigWrite(async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const persisted = await configService.getConfig();
      if (persisted.revision === undefined) throw new Error('Backend config revision is missing');
      const current = snapshot ?? {
        entries: collectPortMeta(useAppStore.getState().ports),
        presentIds: useAppStore.getState().ports.map((port) => port.id),
      };
      const present = new Set(current.presentIds);
      const portMeta = [...persisted.portMeta.filter((entry) => !present.has(entry.portId)), ...current.entries];
      if (await configService.setConfig({ ...persisted, portMeta }, false, persisted.revision)) return;
    }
    throw new Error('Config changed during port metadata save; please try again');
  });
}

/** Preserve local edits since the last confirmed persistence; a newer backend
 * CRUD change to the same ID wins instead of being reverted by full save. */
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
   * 后端整体替换配置，不能直接提交 config 中的实体基线。五类规则活编辑在
   * useRuleStore，groups/ports/预设各有权威来源；这里按已确认基线与新鲜后端
   * 状态协调实体并 revision CAS，避免丢活编辑或回滚其他窗口的 CRUD。
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
          if (!fieldOnly) {
            const entities = {
              sendCommandSets: candidate.sendCommandSets,
              highlightRuleSets: candidate.highlightRuleSets,
              protocolTemplates: candidate.protocolTemplates,
              triggerRules: candidate.triggerRules,
              portToolConfigs: candidate.portToolConfigs,
            };
            useAppStore.getState().setConfig(entities);
            // Adopt concurrent backend winners, but never erase an editor change
            // made while this successful invoke was in flight.
            const live = useRuleStore.getState();
            if (live.sendCommandSets === rules.sendCommandSets) live.setSendCommandSets(entities.sendCommandSets);
            if (live.highlightRuleSets === rules.highlightRuleSets) live.setHighlightRuleSets(entities.highlightRuleSets);
            if (live.protocolTemplates === rules.protocolTemplates) live.setProtocolTemplates(entities.protocolTemplates);
            if (live.triggerRules === rules.triggerRules) live.setTriggerRules(entities.triggerRules);
            if (live.portToolConfigs === rules.portToolConfigs) live.setPortToolConfigs(entities.portToolConfigs);
          }
          // Only a real channel change may invalidate in-flight update checks;
          // bumping the generation on every unrelated settings save silently
          // discarded an available update found at the same moment.
          if (candidate.updateCheckMode !== getCommittedUpdateMode()) {
            commitUpdateMode(candidate.updateCheckMode, true);
          }
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
