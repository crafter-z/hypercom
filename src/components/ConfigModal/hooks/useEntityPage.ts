import { useCallback, useState } from 'react';
import type { EntityKey } from '../../../utils/entityEditor';
import {
  discardEntityDraft,
  insertEntityDraft,
  removeEntityDraft,
  reorderEntityDraft,
  saveEntityDraft,
  updateEntityDraft,
  useEntityEditor,
} from '../../../utils/entityEditor';

export interface EntityPage<T extends { id: string }> {
  items: T[];
  expandedId: string | null;
  toggleExpanded: (id: string) => void;
  create: (entity: T, beforeId?: string) => void;
  update: (id: string, patch: Partial<T>) => void;
  remove: (id: string) => void;
  reorder: (ids: string[]) => void;
  save: (id?: string) => Promise<boolean>;
  discard: (id?: string) => void;
  dirty: boolean;
  isDirty: (id: string) => boolean;
  saving: boolean;
  error: string | null;
}

const expandedByKind = new Map<EntityKey, string | null>();

export function useEntityPage<T extends { id: string }>({ kind }: { kind: EntityKey }): EntityPage<T> {
  const snapshot = useEntityEditor<T>(kind);
  const [expandedId, setExpandedId] = useState<string | null>(() => expandedByKind.get(kind) ?? null);

  const toggleExpanded = useCallback((id: string) => {
    setExpandedId(current => {
      const next = current === id ? null : id;
      expandedByKind.set(kind, next);
      return next;
    });
  }, [kind]);
  const create = useCallback((entity: T, beforeId?: string) => {
    insertEntityDraft(kind, entity, beforeId);
    expandedByKind.set(kind, entity.id);
    setExpandedId(entity.id);
  }, [kind]);
  const update = useCallback((id: string, patch: Partial<T>) => updateEntityDraft(kind, id, patch), [kind]);
  const remove = useCallback((id: string) => {
    removeEntityDraft(kind, id);
    setExpandedId(current => {
      const next = current === id ? null : current;
      expandedByKind.set(kind, next);
      return next;
    });
  }, [kind]);
  const reorder = useCallback((ids: string[]) => reorderEntityDraft(kind, ids), [kind]);
  const save = useCallback((id?: string) => saveEntityDraft(kind, id), [kind]);
  const discard = useCallback((id?: string) => discardEntityDraft(kind, id), [kind]);
  const isDirty = useCallback((id: string) => snapshot.dirtyIds.includes(id), [snapshot.dirtyIds]);

  return {
    items: snapshot.items,
    expandedId,
    toggleExpanded,
    create,
    update,
    remove,
    reorder,
    save,
    discard,
    dirty: snapshot.dirty,
    isDirty,
    saving: snapshot.saving,
    error: snapshot.error,
  };
}
