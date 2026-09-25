import { useCallback, useEffect, useRef, useState } from 'react';
import { notifyError } from '../../../stores/useToastStore';

/** Persisted entity of a rule-set / command-set / tool-config settings page. */
export interface EntityRecord {
  id: string;
}

/**
 * Backend-facing side of one entity collection. Pages wire these to their own
 * store actions and `storageService` methods.
 */
export interface EntityPageOps<T extends EntityRecord> {
  /** Read the whole list from config.json (through `storageService`). */
  load: () => Promise<T[]>;
  /** Current list, read without subscribing — used for post-mutation reads. */
  read: () => T[];
  /** Replace the whole list in the store. */
  replace: (items: T[]) => void;
  /** Append one entity to the store. */
  add: (entity: T) => void;
  /** Drop one entity from the store. */
  drop: (id: string) => void;
  /**
   * Persist one entity. `unknown` (not `void`) because the storage commands
   * resolve with the entity id / path, which the hook has no use for.
   */
  persist: (entity: T) => Promise<unknown>;
  /** Delete one entity in the backend. */
  remove: (id: string) => Promise<unknown>;
}

export interface EntityPageOptions<T extends EntityRecord> {
  /** Live list from the store (subscribed by the page) — drives the auto-save watcher. */
  items: T[];
  ops: EntityPageOps<T>;
  /** Tag for load/del warnings, e.g. `RuleSetAccordion`. */
  label: string;
  /**
   * `> 0` → the collection persists itself `autoSaveDebounceMs` after the last
   * change and flushes on unmount. `0`/omitted → the row's ✓ button is the only
   * write path. This is the *only* sanctioned divergence between entity pages;
   * pages must not hand-roll a second persistence mechanism.
   */
  autoSaveDebounceMs?: number;
}

export interface EntityPage<T extends EntityRecord> {
  expandedId: string | null;
  toggleExpanded: (id: string) => void;
  /** Append an entity and expand it. Auto-saved collections persist it immediately. */
  create: (entity: T) => void;
  /** Persist one entity (the row's ✓). */
  save: (id: string) => Promise<void>;
  /** Drop an entity from the store, then delete it in the backend. */
  remove: (id: string) => Promise<void>;
}

/**
 * Load / dirty-track / save / delete contract shared by every entity page in the
 * settings modal.
 *
 * Five pages (highlight sets, command sets, protocol templates, tool configs,
 * trigger rules) used to carry their own copy of this skeleton, and the copies
 * disagreed: some replaced the store on mount and some skipped the load when the
 * store was non-empty, so whether closing the dialog kept an edit depended on
 * which page you were on. The single contract is:
 *
 *  1. Mount → load the whole list and replace the store, *unless* the user
 *     mutated the store while the load was in flight. An empty backend result
 *     always replaces — skipping it is what used to resurrect entities the user
 *     had deleted (they came back on the next dialog open and got written to
 *     config.json again).
 *  2. Every edit mutates the store immediately (single source of truth: the
 *     whole-list save in `ConfigModal.handleSave` re-reads it).
 *  3. Persistence is either manual (✓ per row) or debounced-auto per
 *     `autoSaveDebounceMs`, never both for one page.
 *  4. Delete = store drop + backend delete; failures always toast.
 *
 * `savedSnapshotRef` is the last known persisted state. It advances only after a
 * write succeeded, so a failed write stays dirty and is retried by the next edit
 * instead of being silently forgotten.
 */
export function useEntityPage<T extends EntityRecord>(
  options: EntityPageOptions<T>,
): EntityPage<T> {
  const { items, ops, label, autoSaveDebounceMs = 0 } = options;
  // Read the ops through a ref: pages build the object inline, and re-binding
  // the load effect (or the window-free watchers) on every render would be a
  // needless re-subscription.
  const opsRef = useRef(ops);
  opsRef.current = ops;

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const savedSnapshotRef = useRef<T[]>([]);

  const markPersisted = useCallback((entities: readonly T[]) => {
    const byId = new Map(savedSnapshotRef.current.map((e) => [e.id, e]));
    for (const entity of entities) byId.set(entity.id, { ...entity });
    savedSnapshotRef.current = [...byId.values()];
  }, []);

  const forgetPersisted = useCallback((id: string) => {
    savedSnapshotRef.current = savedSnapshotRef.current.filter((e) => e.id !== id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const atMount = opsRef.current.read();
    // The backend list, once known — the reference point for "what is
    // persisted". Immer keeps array references stable until a mutation, so
    // `read() === atMount` is an exact "the user has not touched this" test.
    let persisted: T[] | null = null;
    opsRef.current
      .load()
      .then((loaded) => {
        persisted = loaded;
        if (!cancelled && opsRef.current.read() === atMount) opsRef.current.replace(loaded);
      })
      .catch((e) => {
        console.warn(`[${label}] load failed:`, e);
        notifyError(e);
      })
      .finally(() => {
        // On failure the store still holds the app-startup entities, which came
        // from the same config.json — treat that as the persisted baseline so an
        // edit made during the failed load is not silently absorbed.
        savedSnapshotRef.current = (persisted ?? atMount).map((e) => ({ ...e }));
        if (!cancelled) setHydrated(true);
      });
    return () => {
      cancelled = true;
    };
  }, [label]);

  const persistChanged = useCallback(() => {
    const liveOps = opsRef.current;
    const list = liveOps.read();
    const before = new Map(savedSnapshotRef.current.map((e) => [e.id, e]));
    const changed = list.filter((e) => {
      const prev = before.get(e.id);
      return !prev || JSON.stringify(prev) !== JSON.stringify(e);
    });
    if (changed.length === 0) return;
    Promise.all(
      changed.map((e) =>
        liveOps.persist(e).catch((err) => {
          notifyError(err);
          throw err;
        }),
      ),
    )
      .then(() => markPersisted(changed))
      .catch(() => {
        // Per-entity failures were toasted; the snapshot stays behind so the
        // next edit retries them.
      });
  }, [markPersisted]);

  // Debounced auto-save. `hydrated` gates the first run so the mount load itself
  // never triggers a redundant write.
  useEffect(() => {
    if (autoSaveDebounceMs <= 0 || !hydrated) return;
    const timer = setTimeout(persistChanged, autoSaveDebounceMs);
    return () => clearTimeout(timer);
  }, [items, hydrated, autoSaveDebounceMs, persistChanged]);

  // Unmount flush — deliberately its own effect: putting the flush in the
  // debounce effect's cleanup would run it on every keystroke and defeat the
  // debounce. An edit inside the debounce window must survive the dialog closing
  // (which unmounts this page).
  const persistChangedRef = useRef(persistChanged);
  persistChangedRef.current = persistChanged;
  useEffect(() => {
    if (autoSaveDebounceMs <= 0) return;
    return () => persistChangedRef.current();
  }, [autoSaveDebounceMs]);

  const toggleExpanded = useCallback((id: string) => {
    setExpandedId((current) => (current === id ? null : id));
  }, []);

  const create = useCallback(
    (entity: T) => {
      const liveOps = opsRef.current;
      liveOps.add(entity);
      setExpandedId(entity.id);
      // An auto-saved collection must not rely on the debounce window (or on the
      // unmount-flush ordering) for a brand-new row to reach disk.
      if (autoSaveDebounceMs > 0) {
        liveOps
          .persist(entity)
          .then(() => markPersisted([entity]))
          .catch((e) => notifyError(e));
      }
    },
    [autoSaveDebounceMs, markPersisted],
  );

  const save = useCallback(
    async (id: string) => {
      const liveOps = opsRef.current;
      const entity = liveOps.read().find((e) => e.id === id);
      if (!entity) return;
      try {
        await liveOps.persist(entity);
        // Advance the baseline so the auto-save watcher does not re-write what
        // the user just saved by hand.
        markPersisted([entity]);
      } catch (e) {
        notifyError(e);
      }
    },
    [markPersisted],
  );

  const remove = useCallback(
    async (id: string) => {
      const liveOps = opsRef.current;
      liveOps.drop(id);
      forgetPersisted(id);
      try {
        await liveOps.remove(id);
      } catch (e) {
        console.error(`[${label}] delete failed:`, e);
        notifyError(e);
      }
    },
    [forgetPersisted, label],
  );

  return { expandedId, toggleExpanded, create, save, remove };
}
