import { useCallback } from 'react';
import type { SerialPort, AppConfig, PortMetaEntry } from '../types';
import { useAppStore } from '../stores/useAppStore';
import { useSystemStore } from '../stores/useSystemStore';
import { configService, storageService } from '../services/tauri';
import { notifyError } from '../stores/useToastStore';
import { commitUpdateMode, getCommittedUpdateMode } from '../utils/updateService';
import { enqueueConfigWrite } from '../utils/configWriteQueue';
import { prepareEntityCollectionForSave, commitEntityEditorDraft } from '../utils/entityEditor';
import type { EntityKey } from '../utils/entityEditor';
import { jsonEqual } from '../utils/jsonEqual';

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


const ENTITY_KEYS: readonly EntityKey[] = [
  'sendCommandSets', 'highlightRuleSets', 'protocolTemplates', 'triggerRules', 'portToolConfigs',
];

let ordinaryBaseline: AppConfig | null = null;
function ordinaryValues(config: AppConfig): Partial<AppConfig> {
  const result = { ...config } as Partial<AppConfig>;
  for (const key of ENTITY_KEYS) delete result[key];
  delete result.portGroups;
  delete result.portMeta;
  delete result.portPresets;
  delete result.pluginConfigs;
  delete result.revision;
  return result;
}

export function isOrdinaryConfigDirty(): boolean {
  const current = useAppStore.getState().config;
  return ordinaryBaseline !== null && !jsonEqual(ordinaryValues(current), ordinaryValues(ordinaryBaseline));
}

export function markOrdinaryConfigSaved(config: AppConfig = useAppStore.getState().config): void {
  ordinaryBaseline = { ...config };
}

export function discardOrdinaryConfigDraft(): void {
  if (!ordinaryBaseline) return;
  const current = useAppStore.getState().config;
  useAppStore.getState().setConfig({
    ...ordinaryBaseline,
    revision: current.revision,
    sendCommandSets: current.sendCommandSets,
    highlightRuleSets: current.highlightRuleSets,
    protocolTemplates: current.protocolTemplates,
    triggerRules: current.triggerRules,
    portToolConfigs: current.portToolConfigs,
    portGroups: current.portGroups,
    portMeta: current.portMeta,
    portPresets: current.portPresets,
    pluginConfigs: current.pluginConfigs,
  });
}

export function resetOrdinaryConfigBaselineForTests(): void {
  ordinaryBaseline = null;
}
/**
 * Hook: 配置持久化
 * 从后端加载配置、保存配置到后端
 */
export function useConfigPersistence() {
  const setConfig = useAppStore((s) => s.setConfig);
  const setUIState = useSystemStore((s) => s.setUIState);

  const loadConfig = useCallback(async () => {
    const beforeLoad = useAppStore.getState().config;
    try {
      const config = await configService.getConfig();
      if (!config) throw new Error('Configuration is unavailable');
      setConfig(config);
      markOrdinaryConfigSaved(config);
      commitUpdateMode(config.updateCheckMode);
    } catch (err) {
      console.warn('[useConfigPersistence] Failed to load config, using defaults:', err);
      if (ordinaryBaseline === null) markOrdinaryConfigSaved(beforeLoad);
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
   * useEntityEditor drafts are composed against the fresh backend snapshot and
   * committed only after revision CAS; groups/ports/presets retain their own authority.
   */
  const saveConfig = useCallback((patch?: Partial<AppConfig>, fieldOnly = false) => enqueueConfigWrite(async () => {
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        const persisted = await configService.getConfig();
        const { revision } = persisted;
        if (revision === undefined) throw new Error('Backend config revision is missing');
        const state = useAppStore.getState();
        const portPresets = fieldOnly ? persisted.portPresets : await storageService.loadPortPresets();
        const versions: Partial<Record<EntityKey, number>> = {};
        const entities: Partial<Record<EntityKey, unknown>> = {};
        if (!fieldOnly) {
          for (const kind of ENTITY_KEYS) {
            const prepared = prepareEntityCollectionForSave(kind, persisted[kind]);
            versions[kind] = prepared.version;
            entities[kind] = prepared.items;
          }
        }
        const candidate: AppConfig = fieldOnly ? { ...persisted, ...patch } : {
          ...state.config,
          ...patch,
          ...(entities as Partial<AppConfig>),
          portGroups: state.groups,
          portMeta: mergePortMeta(state.ports, persisted.portMeta),
          portPresets,
        };
        const saved = await configService.setConfig(candidate, false, revision);
        if (!saved) continue;
        if (!fieldOnly) {
          const nextRevision = revision + 1;
          const latest = useAppStore.getState().config;
          const ordinaryPatch = { ...candidate } as Partial<AppConfig>;
          for (const kind of ENTITY_KEYS) delete ordinaryPatch[kind];
          if (latest === state.config) {
            useAppStore.getState().setConfig({ ...ordinaryPatch, revision: nextRevision });
          } else {
            useAppStore.getState().setConfig({ revision: nextRevision });
          }
          for (const kind of ENTITY_KEYS) {
            commitEntityEditorDraft(kind, candidate[kind], versions[kind], nextRevision);
          }
          markOrdinaryConfigSaved(candidate);
        }
        if (fieldOnly) markOrdinaryConfigSaved(candidate);
        if (candidate.updateCheckMode !== getCommittedUpdateMode()) {
          commitUpdateMode(candidate.updateCheckMode, true);
        }
        return true;
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
