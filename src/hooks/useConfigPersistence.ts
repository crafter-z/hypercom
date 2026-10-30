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
import { readEditorRecovery, recoveryKeys, recoveryRecord, writeEditorRecovery } from '../utils/entityEditorRecovery';

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
      if (await configService.setConfig({ ...persisted, portMeta }, false, persisted.revision)) {
        useAppStore.getState().setConfig({ portMeta, revision: persisted.revision + 1 });
        return;
      }
    }
    throw new Error('Config changed during port metadata save; please try again');
  });
}


/** Group auto-saves share the same queue and CAS boundary as editor saves. */
export function saveCurrentPortGroups(): Promise<void> {
  return enqueueConfigWrite(async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const persisted = await configService.getConfig();
      if (persisted.revision === undefined) throw new Error('Backend config revision is missing');
      const portGroups = useAppStore.getState().groups;
      if (await configService.setConfig({ ...persisted, portGroups }, false, persisted.revision)) {
        useAppStore.getState().setConfig({ portGroups, revision: persisted.revision + 1 });
        return;
      }
    }
    throw new Error('Config changed during port group save; please try again');
  });
}

const ENTITY_KEYS: readonly EntityKey[] = [
  'sendCommandSets', 'highlightRuleSets', 'protocolTemplates', 'triggerRules', 'portToolConfigs',
];

let ordinaryBaseline: AppConfig | null = null;
const NON_ORDINARY = new Set<string>([...ENTITY_KEYS, 'portGroups', 'portMeta', 'portPresets', 'pluginConfigs', 'revision']);
const ORDINARY_KEYS = Object.keys(useAppStore.getInitialState().config).filter(key => !NON_ORDINARY.has(key)) as Array<keyof AppConfig>;
const ordinaryConflicts = new Set<keyof AppConfig>();
let publishingRecovery = false;
let ordinarySubscriptionInstalled = false;
function ordinaryValues(config: AppConfig): Partial<AppConfig> {
  return Object.fromEntries(ORDINARY_KEYS.map(key => [key, config[key]])) as Partial<AppConfig>;
}

interface OrdinaryRecovery { baseline: Partial<AppConfig>; draft: Partial<AppConfig>; conflicts: string[] }
function readOrdinaryRecovery(): OrdinaryRecovery | null {
  const template = useAppStore.getInitialState().config;
  const validValues = (value: unknown): value is Partial<AppConfig> => recoveryRecord(value) &&
    recoveryKeys(value, ORDINARY_KEYS) && ORDINARY_KEYS.every(key => {
      const expected = template[key];
      const field = value[key];
      return Array.isArray(expected)
        ? Array.isArray(field) && field.every(item => typeof item === 'number' && Number.isFinite(item))
        : typeof field === typeof expected && (typeof field !== 'number' || Number.isFinite(field));
    });
  return readEditorRecovery('config', (value): value is OrdinaryRecovery => recoveryRecord(value) &&
    recoveryKeys(value, ['baseline', 'draft', 'conflicts']) && validValues(value.baseline) && validValues(value.draft) &&
    Array.isArray(value.conflicts) && value.conflicts.every(key => typeof key === 'string' && ORDINARY_KEYS.includes(key as keyof AppConfig)));
}

function recordOrdinaryRecovery(): void {
  if (!ordinaryBaseline || publishingRecovery) return;
  const baseline = ordinaryValues(ordinaryBaseline);
  const draft = ordinaryValues(useAppStore.getState().config);
  writeEditorRecovery('config', jsonEqual(baseline, draft) ? null : { baseline, draft, conflicts: [...ordinaryConflicts] });
}
function installOrdinarySubscription(): void {
  if (ordinarySubscriptionInstalled) return;
  ordinarySubscriptionInstalled = true;
  useAppStore.subscribe((state, previous) => {
    if (publishingRecovery || !ordinaryBaseline || state.config === previous.config) return;
    for (const key of ordinaryConflicts) if (!jsonEqual(state.config[key], previous.config[key])) ordinaryConflicts.delete(key);
    recordOrdinaryRecovery();
  });
}

/** Three-way merge into a session draft only. Existing theme/font/power preview
 * hooks may observe it, just as they observe manual edits; this never commits
 * backend runtime settings, entities, plugin grants, metadata or update mode. */
function mergeOrdinary(remote: AppConfig, local: Partial<AppConfig>, baseline: Partial<AppConfig>) {
  const values: Record<string, unknown> = {};
  const conflicts = new Set<keyof AppConfig>();
  for (const key of ORDINARY_KEYS) {
    const changed = !jsonEqual(local[key], baseline[key]);
    if (changed && !jsonEqual(remote[key], baseline[key]) && !jsonEqual(local[key], remote[key])) conflicts.add(key);
    values[key] = changed ? local[key] : remote[key];
  }
  return { values: values as Partial<AppConfig>, conflicts };
}

export function isOrdinaryConfigDirty(): boolean {
  const current = useAppStore.getState().config;
  return ordinaryBaseline !== null && !jsonEqual(ordinaryValues(current), ordinaryValues(ordinaryBaseline));
}

export function markOrdinaryConfigSaved(config: AppConfig = useAppStore.getState().config): void {
  ordinaryBaseline = { ...config };
  for (const key of ordinaryConflicts) if (jsonEqual(useAppStore.getState().config[key], config[key])) ordinaryConflicts.delete(key);
  installOrdinarySubscription();
  recordOrdinaryRecovery();
}

export function discardOrdinaryConfigDraft(): void {
  if (!ordinaryBaseline) return;
  ordinaryConflicts.clear();
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
  recordOrdinaryRecovery();
}

export function resetOrdinaryConfigBaselineForTests(preserveRecovery = false): void {
  ordinaryBaseline = null;
  ordinaryConflicts.clear();
  publishingRecovery = false;
  if (!preserveRecovery) writeEditorRecovery('config', null);
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
      const recovery = readOrdinaryRecovery();
      publishingRecovery = true;
      try {
        setConfig(config);
        ordinaryConflicts.clear();
        markOrdinaryConfigSaved(config);
        // Commit only the disk value before restoring an update-mode draft.
        commitUpdateMode(config.updateCheckMode);
        if (recovery) {
          const merged = mergeOrdinary(config, recovery.draft, recovery.baseline);
          for (const key of recovery.conflicts as Array<keyof AppConfig>) {
            if (!jsonEqual(merged.values[key], config[key])) merged.conflicts.add(key);
          }
          for (const key of merged.conflicts) ordinaryConflicts.add(key);
          setConfig(merged.values);
        }
      } finally { publishingRecovery = false; }
      recordOrdinaryRecovery();
    } catch (err) {
      console.warn('[useConfigPersistence] Failed to load config, using defaults:', err);
      if (ordinaryBaseline === null) {
        ordinaryBaseline = { ...beforeLoad };
        installOrdinarySubscription();
        // Keep any recorded recovery until a real disk baseline can be read.
      }
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
        const ordinary = mergeOrdinary(persisted, { ...state.config, ...patch }, ordinaryBaseline ?? persisted);
        if (!fieldOnly) {
          for (const key of ordinaryConflicts) if (jsonEqual(state.config[key], persisted[key])) ordinaryConflicts.delete(key);
          for (const key of ordinary.conflicts) ordinaryConflicts.add(key);
          if (ordinaryConflicts.size > 0) { recordOrdinaryRecovery(); throw new Error('editor.conflict'); }
        }
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
          ...ordinary.values,
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
