import { useSyncExternalStore } from 'react';
import type {
  AppConfig,
  HighlightRuleSet,
  PortToolConfig,
  ProtocolTemplate,
  SendCommandSet,
  TriggerRule,
} from '../types';
import { useAppStore } from '../stores/useAppStore';
import { useRuleStore } from '../stores/useRuleStore';
import { configService } from '../services/tauri';
import { enqueueConfigWrite } from './configWriteQueue';
import { normalizeCommandOrder } from './commandOrder';
import { jsonEqual as same } from './jsonEqual';

export type EntityKey =
  | 'sendCommandSets'
  | 'highlightRuleSets'
  | 'protocolTemplates'
  | 'triggerRules'
  | 'portToolConfigs';

export interface EntityEditorSnapshot<T = unknown> {
  items: T[];
  version: number;
  dirty: boolean;
  dirtyIds: string[];
  saving: boolean;
  error: string | null;
}

type Entity = { id: string };

interface EditorState {
  kind: EntityKey;
  baseline: Entity[];
  draft: Entity[];
  version: number;
  saving: boolean;
  error: string | null;
  conflicts: Set<string>;
  orderDirty: boolean;
  committed: Entity[];
  savePromise: Promise<boolean> | null;
}

const states = new Map<EntityKey, EditorState>();
const snapshots = new Map<EntityKey, EntityEditorSnapshot>();
const listeners = new Set<() => void>();
let publishingEntityCommit = false;

function publishEntityCommit(kind: EntityKey, items: Entity[], revision?: number): void {
  publishingEntityCommit = true;
  try {
    if (revision !== undefined) useAppStore.getState().setConfig({ [kind]: clone(items), revision } as Partial<AppConfig>);
    setCommitted(kind, items);
  } finally {
    publishingEntityCommit = false;
  }
}

const KEY_SET: readonly EntityKey[] = [
  'sendCommandSets', 'highlightRuleSets', 'protocolTemplates', 'triggerRules', 'portToolConfigs',
];

function clone<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}


function appItems(kind: EntityKey): Entity[] {
  const config = useAppStore.getState().config as unknown as Record<EntityKey, Entity[]>;
  return config[kind] ?? [];
}

function committedItems(kind: EntityKey): Entity[] {
  const state = useRuleStore.getState();
  return clone((state as unknown as Record<EntityKey, Entity[]>)[kind] ?? []);
}

function setCommitted(kind: EntityKey, items: Entity[]): void {
  const state = useRuleStore.getState();
  const next = clone(items);
  switch (kind) {
    case 'sendCommandSets': state.setSendCommandSets(next as SendCommandSet[]); break;
    case 'highlightRuleSets': state.setHighlightRuleSets(next as HighlightRuleSet[]); break;
    case 'protocolTemplates': state.setProtocolTemplates(next as ProtocolTemplate[]); break;
    case 'triggerRules': state.setTriggerRules(next as TriggerRule[]); break;
    case 'portToolConfigs': state.setPortToolConfigs(next as PortToolConfig[]); break;
  }
}

function emit(): void {
  for (const listener of [...listeners]) listener();
}

let externalSubscriptionsInstalled = false;
function installExternalSubscriptions(): void {
  if (externalSubscriptionsInstalled) return;
  externalSubscriptionsInstalled = true;
  useAppStore.subscribe((state, previous) => {
    if (publishingEntityCommit) return;
    for (const kind of KEY_SET) {
      const current = (state.config as unknown as Record<EntityKey, Entity[]>)[kind];
      const prior = (previous.config as unknown as Record<EntityKey, Entity[]>)[kind];
      if (current !== prior && states.has(kind)) syncRemote(kind);
    }
  });
  useRuleStore.subscribe((state, previous) => {
    if (publishingEntityCommit) return;
    for (const kind of KEY_SET) {
      const current = (state as unknown as Record<EntityKey, Entity[]>)[kind];
      const prior = (previous as unknown as Record<EntityKey, Entity[]>)[kind];
      if (current !== prior && states.has(kind)) syncRemote(kind);
    }
  });
}

function changedIds(base: readonly Entity[], draft: readonly Entity[]): Set<string> {
  const a = new Map(base.map(item => [item.id, item]));
  const b = new Map(draft.map(item => [item.id, item]));
  const ids = new Set<string>([...a.keys(), ...b.keys()]);
  return new Set([...ids].filter(id => !same(a.get(id), b.get(id))));
}

function orderChanged(base: readonly Entity[], draft: readonly Entity[]): boolean {
  return base.map(item => item.id).join('\u0000') !== draft.map(item => item.id).join('\u0000');
}

function dirtyIdsOf(state: EditorState): string[] {
  return [...changedIds(state.baseline, state.draft)];
}

function updateSnapshot(kind: EntityKey): void {
  const state = states.get(kind);
  if (!state) return;
  const dirtyIds = dirtyIdsOf(state);
  snapshots.set(kind, {
    items: state.draft,
    version: state.version,
    dirty: dirtyIds.length > 0 || state.orderDirty,
    dirtyIds,
    saving: state.saving,
    error: state.error,
  });
}

function ensure(kind: EntityKey): EditorState {
  installExternalSubscriptions();
  let state = states.get(kind);
  if (state) return state;
  const baseline = clone(appItems(kind));
  const committed = committedItems(kind);
  // During startup the config snapshot and runtime store are populated together.
  // Prefer the committed runtime list when it is intentionally different: it is
  // the only source available before configReady has delivered its first snapshot.
  const draft = clone(committed.length > 0 || baseline.length === 0 ? committed : baseline);
  state = {
    kind,
    baseline,
    draft,
    version: 0,
    saving: false,
    error: null,
    conflicts: new Set(),
    orderDirty: orderChanged(baseline, draft),
    committed: clone(committed),
    savePromise: null,
  };
  states.set(kind, state);
  updateSnapshot(kind);
  return state;
}

/** Merge backend changes without replacing a dirty local draft. */
function syncRemote(kind: EntityKey): EditorState {
  const state = ensure(kind);
  const beforeDraft = clone(state.draft);
  const remote = clone(appItems(kind));
  if (same(remote, state.baseline)) {
    const committed = committedItems(kind);
    if (!same(committed, state.committed) && dirtyIdsOf(state).length === 0) {
      state.draft = clone(committed);
      state.baseline = clone(remote);
      state.committed = clone(committed);
      if (!same(beforeDraft, state.draft)) state.version++;
      state.orderDirty = orderChanged(state.baseline, state.draft);
      updateSnapshot(kind);
      emit();
    }
    return state;
  }

  const localChanges = changedIds(state.baseline, state.draft);
  const oldById = new Map(state.baseline.map(item => [item.id, item]));
  const remoteById = new Map(remote.map(item => [item.id, item]));
  const conflicts = new Set(state.conflicts);
  for (const id of localChanges) {
    if (!same(oldById.get(id), remoteById.get(id))) conflicts.add(id);
  }

  if (localChanges.size === 0 && !state.orderDirty) {
    state.baseline = remote;
    state.draft = clone(remote);
    state.committed = clone(remote);
    state.conflicts.clear();
    setCommitted(kind, remote);
  } else {
    // Keep changed local records, but adopt remote changes for records the user
    // never touched. Remote additions are appended and remote deletions disappear.
    const next: Entity[] = [];
    for (const item of state.draft) {
      const id = item.id;
      if (localChanges.has(id)) {
        next.push(item);
      } else if (remoteById.has(id)) {
        next.push(clone(remoteById.get(id)!));
      }
    }
    const present = new Set(next.map(item => item.id));
    for (const item of remote) if (!present.has(item.id) && !localChanges.has(item.id)) next.push(clone(item));
    state.baseline = remote;
    state.draft = next;
    state.committed = clone(remote);
    state.conflicts = conflicts;
    setCommitted(kind, remote);
  }
  if (!same(beforeDraft, state.draft)) state.version++;
  state.orderDirty = orderChanged(state.baseline, state.draft);
  if (state.conflicts.size > 0) state.error = 'editor.conflict';
  updateSnapshot(kind);
  emit();
  return state;
}

function normalizeItems(kind: EntityKey, items: Entity[]): Entity[] {
  if (kind === 'triggerRules') return items.map(item => ({ ...item, portId: (item as TriggerRule).portId ?? '' }));
  if (kind !== 'sendCommandSets') return clone(items);
  return items.map(item => ({ ...item, commands: normalizeCommandOrder((item as SendCommandSet).commands) }));
}

function invalidHex(value: unknown): boolean {
  if (typeof value !== 'string') return true;
  const compact = value.replace(/[\t\r\n ]/g, '');
  return compact.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(compact);
}

function validateEntity(kind: EntityKey, item: Entity): string | null {
  if (!item.id || typeof item.id !== 'string') return 'editor.invalidEntity';
  const value = item as Record<string, unknown>;
  if (typeof value.name !== 'string' || !value.name.trim()) return 'editor.invalidEntity';
  if (kind === 'highlightRuleSets') {
    for (const rule of ((value.rules as Array<Record<string, unknown>> | undefined) ?? [])) {
      if (rule.isRegex && (typeof rule.pattern !== 'string' || rule.pattern.length > 200)) return 'editor.invalidRegex';
      if (rule.isRegex) { try { new RegExp(String(rule.pattern)); } catch { return 'editor.invalidRegex'; } }
    }
  } else if (kind === 'sendCommandSets') {
    for (const command of ((value.commands as Array<Record<string, unknown>> | undefined) ?? [])) {
      if (command.type === 'hex' && invalidHex(command.content)) return 'editor.invalidHex';
    }
  } else if (kind === 'protocolTemplates') {
    if (invalidHex(value.headerBytes) || invalidHex(value.footerBytes)) return 'editor.invalidHex';
    if (!Number.isInteger(value.lengthFieldOffset) || Number(value.lengthFieldOffset) < 0) return 'editor.invalidProtocol';
    if (!Number.isInteger(value.checksumOffset) || Number(value.checksumOffset) < 0) return 'editor.invalidProtocol';
  } else if (kind === 'triggerRules') {
    if ((value.matchType === 'regex' || value.isRegex) && (typeof value.pattern !== 'string' || value.pattern.length > 200)) return 'editor.invalidRegex';
    if (value.matchType === 'regex' || value.isRegex) { try { new RegExp(String(value.pattern)); } catch { return 'editor.invalidRegex'; } }
    if (value.matchType === 'hex' && invalidHex(value.pattern)) return 'editor.invalidHex';
    if (value.actionIsHex && invalidHex(value.actionContent)) return 'editor.invalidHex';
  }
  return null;
}

export function validateEntityDraft(kind: EntityKey, items: readonly Entity[]): string | null {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) return 'editor.invalidEntity';
    seen.add(item.id);
    const error = validateEntity(kind, item);
    if (error) return error;
  }
  return null;
}

function remoteConflict(state: EditorState, remote: Entity[], ids: Set<string>): Set<string> {
  const old = new Map(state.baseline.map(item => [item.id, item]));
  const next = new Map(remote.map(item => [item.id, item]));
  const conflicts = new Set(state.conflicts);
  for (const id of ids) if (!same(old.get(id), next.get(id))) conflicts.add(id);
  return conflicts;
}

/** Compose one collection on top of a freshly read backend snapshot. */
export function composeEntityCollection(kind: EntityKey, remote: readonly Entity[], local: readonly Entity[], baseline: readonly Entity[], entityId?: string): Entity[] {
  const base = new Map(baseline.map(item => [item.id, item]));
  const draft = new Map(local.map(item => [item.id, item]));
  const remoteById = new Map(remote.map(item => [item.id, item]));
  const changed = changedIds(baseline, local);
  if (entityId !== undefined) {
    const result = remote.map(item => clone(item));
    const localItem = draft.get(entityId);
    const remoteIndex = result.findIndex(item => item.id === entityId);
    if (localItem) {
      const normalized = clone(localItem);
      if (remoteIndex >= 0) result[remoteIndex] = normalized;
      else result.push(normalized);
    } else if (remoteIndex >= 0 && (base.has(entityId) || changed.has(entityId))) {
      result.splice(remoteIndex, 1);
    }
    return normalizeItems(kind, result);
  }

  // Preserve local ordering for touched collections. Unchanged remote records are
  // adopted in place; records created by another writer append deterministically.
  const result: Entity[] = [];
  const seen = new Set<string>();
  for (const item of local) {
    const remoteItem = remoteById.get(item.id);
    if (changed.has(item.id)) {
      if (remoteItem || !base.has(item.id)) result.push(clone(item));
    } else if (remoteItem) {
      result.push(clone(remoteItem));
    }
    seen.add(item.id);
  }
  for (const item of remote) if (!seen.has(item.id) && !changed.has(item.id)) result.push(clone(item));
  return normalizeItems(kind, result);
}

function markFailure(state: EditorState, error: string): void {
  state.error = error;
  state.saving = false;
  state.savePromise = null;
  updateSnapshot(state.kind);
  emit();
}

async function performSave(kind: EntityKey, id: string | undefined): Promise<boolean> {
  const state = syncRemote(kind);
  const local = clone(state.draft);
  const baseline = clone(state.baseline);
  const localChanged = changedIds(baseline, local);
  const validation = id === undefined ? validateEntityDraft(kind, local) : (() => {
    const item = local.find(entry => entry.id === id);
    return item ? validateEntity(kind, item) : null;
  })();
  if (validation) { markFailure(state, validation); return false; }

  state.saving = true;
  state.error = null;
  updateSnapshot(kind);
  emit();
  try {
    const persisted = await configService.getConfig();
    if (persisted.revision === undefined) throw new Error('Backend config revision is missing');
    const remote: Entity[] = clone(persisted[kind]);
    const conflicts = remoteConflict(state, remote, id === undefined ? localChanged : new Set([id]));
    const blockedByExistingConflict = id === undefined
      ? state.conflicts.size > 0
      : state.conflicts.has(id);
    if (blockedByExistingConflict || conflicts.size > 0) {
      state.conflicts = conflicts;
      throw new Error('editor.conflict');
    }
    const candidate = composeEntityCollection(kind, remote, local, baseline, id);
    const saved = await configService.setConfig(
      { ...persisted, [kind]: candidate },
      false,
      persisted.revision,
    );
    if (!saved) throw new Error('editor.conflict');

    const nextRevision = (persisted.revision ?? 0) + 1;
    const retainedDraft = composeEntityCollection(kind, candidate, clone(state.draft), baseline);
    state.baseline = clone(candidate);
    state.draft = retainedDraft;
    state.committed = clone(candidate);
    state.conflicts.clear();
    state.orderDirty = orderChanged(state.baseline, state.draft);
    state.error = null;
    state.saving = false;
    state.savePromise = null;
    publishEntityCommit(kind, candidate, nextRevision);
    updateSnapshot(kind);
    emit();
    return true;

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    markFailure(state, message === 'editor.conflict' ? 'editor.conflict' : 'editor.saveFailed');
    return false;
  }
}

/** Prepare a collection against a freshly read config for an atomic full save. */
export function prepareEntityCollectionForSave(kind: EntityKey, remote: readonly Entity[]): { items: Entity[]; version: number } {
  const state = syncRemote(kind);
  const local = clone(state.draft);
  const baseline = clone(state.baseline);
  const conflicts = remoteConflict(state, remote as Entity[], changedIds(baseline, local));
  if (conflicts.size > 0) {
    state.conflicts = conflicts;
    state.error = 'editor.conflict';
    updateSnapshot(kind);
    emit();
    throw new Error('editor.conflict');
  }
  const validation = validateEntityDraft(kind, local);
  if (validation) {
    state.error = validation;
    updateSnapshot(kind);
    emit();
    throw new Error(validation);
  }
  return { items: composeEntityCollection(kind, remote, local, baseline), version: state.version };
}


export function getEntityEditorSnapshot<T = unknown>(kind: EntityKey): EntityEditorSnapshot<T> {
  ensure(kind);
  if (!snapshots.has(kind)) updateSnapshot(kind);
  return snapshots.get(kind)! as EntityEditorSnapshot<T>;
}

export function subscribeEntityEditor(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function replaceEntityDraft<T extends Entity>(kind: EntityKey, items: T[], expectedVersion?: number): void {
  const state = syncRemote(kind);
  if (expectedVersion !== undefined && expectedVersion !== state.version) {
    state.error = 'editor.conflict';
    updateSnapshot(kind);
    emit();
    throw new Error('editor.conflict');
  }
  state.draft = clone(items);
  state.version++;
  state.error = null;
  state.orderDirty = orderChanged(state.baseline, state.draft);
  updateSnapshot(kind);
  emit();
}

export function updateEntityDraft<T extends Entity>(kind: EntityKey, id: string, patch: Partial<T>): void {
  const state = syncRemote(kind);
  if (!state.draft.some(item => item.id === id)) return;
  state.draft = state.draft.map(item => item.id === id ? { ...item, ...clone(patch), id } : item);
  state.version++;
  state.error = null;
  state.orderDirty = orderChanged(state.baseline, state.draft);
  updateSnapshot(kind);
  emit();
}

export function insertEntityDraft<T extends Entity>(kind: EntityKey, entity: T, beforeId?: string): void {
  const state = syncRemote(kind);
  const next = state.draft.filter(item => item.id !== entity.id);
  const index = beforeId ? next.findIndex(item => item.id === beforeId) : -1;
  next.splice(index < 0 ? next.length : index, 0, clone(entity));
  state.draft = next;
  state.version++;
  state.error = null;
  state.orderDirty = orderChanged(state.baseline, state.draft);
  updateSnapshot(kind);
  emit();
}

export function removeEntityDraft(kind: EntityKey, id: string): void {
  const state = syncRemote(kind);
  state.draft = state.draft.filter(item => item.id !== id);
  state.version++;
  state.error = null;
  state.orderDirty = orderChanged(state.baseline, state.draft);
  updateSnapshot(kind);
  emit();
}

export function reorderEntityDraft(kind: EntityKey, ids: string[]): void {
  const state = syncRemote(kind);
  const byId = new Map(state.draft.map(item => [item.id, item]));
  if (ids.length !== byId.size || new Set(ids).size !== byId.size || ids.some(id => !byId.has(id))) return;
  state.draft = ids.map(id => byId.get(id)!);
  state.version++;
  state.error = null;
  state.orderDirty = orderChanged(state.baseline, state.draft);
  updateSnapshot(kind);
  emit();
}

export function saveEntityDraft(kind: EntityKey, id?: string): Promise<boolean> {
  const state = syncRemote(kind);
  if (state.savePromise) return state.savePromise;
  const promise = enqueueConfigWrite(() => performSave(kind, id));
  state.savePromise = promise;
  return promise;
}

export function discardEntityDraft(kind: EntityKey, id?: string): void {
  const state = syncRemote(kind);
  if (id === undefined) state.draft = clone(state.baseline);
  else {
    const baselineItem = state.baseline.find(item => item.id === id);
    const index = state.draft.findIndex(item => item.id === id);
    if (baselineItem) {
      const replacement = clone(baselineItem);
      if (index >= 0) state.draft = state.draft.map((item, itemIndex) => itemIndex === index ? replacement : item);
      else {
        const baselineIndex = state.baseline.findIndex(item => item.id === id);
        const beforeId = state.baseline[baselineIndex + 1]?.id;
        const insertAt = beforeId ? state.draft.findIndex(item => item.id === beforeId) : state.draft.length;
        const next = [...state.draft];
        next.splice(insertAt < 0 ? next.length : insertAt, 0, replacement);
        state.draft = next;
      }
    } else if (index >= 0) {
      state.draft = state.draft.filter(item => item.id !== id);
    }
  }
  state.version++;
  if (id !== undefined) state.conflicts.delete(id);
  else state.conflicts.clear();
  state.error = null;
  state.orderDirty = orderChanged(state.baseline, state.draft);
  updateSnapshot(kind);
  emit();
}

/** Adopt a known backend snapshot after restore/import without fabricating a save. */
export function adoptEntityEditorBaselineFromConfig(config: AppConfig = useAppStore.getState().config): void {
  const source = config as unknown as Record<EntityKey, Entity[]>;
  for (const kind of KEY_SET) {
    const state = states.get(kind);
    if (!state) continue;
    const items = clone(source[kind] ?? []);
    state.baseline = items;
    state.draft = clone(items);
    state.committed = clone(items);
    state.conflicts.clear();
    state.error = null;
    state.orderDirty = false;
    setCommitted(kind, items);
    updateSnapshot(kind);
  }
  emit();
}
export function listDirtyEntityKinds(): EntityKey[] {
  return KEY_SET.filter(kind => getEntityEditorSnapshot(kind).dirty);
}


/** Mark a full-config candidate as persisted, retaining edits made while it was in flight. */
export function commitEntityEditorDraft(kind: EntityKey, persisted: Entity[], expectedVersion?: number, revision?: number): void {
  const state = ensure(kind);
  const oldBaseline = clone(state.baseline);
  const oldDraft = clone(state.draft);
  const noLateEdits = expectedVersion === undefined || expectedVersion === state.version;
  state.baseline = clone(persisted);
  state.draft = noLateEdits ? clone(persisted) : composeEntityCollection(kind, persisted, oldDraft, oldBaseline);
  state.committed = clone(persisted);
  state.conflicts.clear();
  state.orderDirty = orderChanged(state.baseline, state.draft);
  state.error = null;
  publishEntityCommit(kind, persisted, revision);
  updateSnapshot(kind);
  emit();
}

export function resetEntityEditorForTests(): void {
  states.clear();
  snapshots.clear();
  emit();
}

export function useEntityEditor<T = unknown>(kind: EntityKey): EntityEditorSnapshot<T> {
  return useSyncExternalStore(
    subscribeEntityEditor,
    () => getEntityEditorSnapshot<T>(kind),
    () => getEntityEditorSnapshot<T>(kind),
  );
}

