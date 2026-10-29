import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { eventService, popoutEventService, serialService } from '../../services/tauri';
import type { AvailablePortInfo, CommandEditorSnapshot } from '../../services/tauri';
import { registerEditorParticipant } from '../../utils/editorLeave';
import type { SendCommandSet } from '../../types';

export const POPOUT_COMMAND_EDITOR_ID = 'popout:commands';
const EMPTY_SNAPSHOT: CommandEditorSnapshot = {
  items: [], sessionId: '', version: -1, dirty: false, dirtyIds: [], saving: false, error: null,
};

export interface PopoutSync {
  sets: SendCommandSet[];
  ready: boolean;
  dirty: boolean;
  dirtyIds: ReadonlySet<string>;
  pending: boolean;
  saving: boolean;
  error: string | null;
  replaceSets: (items: SendCommandSet[]) => void;
  save: () => Promise<boolean>;
  discard: () => Promise<boolean>;
  activePortId: string | null;
  ports: AvailablePortInfo[];
  connectedPortIds: ReadonlySet<string>;
  openSetEditor: () => void;
}

/** Main owns drafts. Local text is retained until a matching versioned ACK. */
export function usePopoutSync(): PopoutSync {
  const { t } = useTranslation();
  const [sets, setSets] = useState<SendCommandSet[]>([]);
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);
  const [pending, setPending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activePortId, setActivePortId] = useState<string | null>(null);
  const [ports, setPorts] = useState<AvailablePortInfo[]>([]);
  const [connectedPortIds, setConnectedPortIds] = useState<ReadonlySet<string>>(new Set());
  const authority = useRef(EMPTY_SNAPSHOT);
  const local = useRef<SendCommandSet[]>([]);
  const baseVersion = useRef(-1);
  const baseSession = useRef('');
  const retiredSessions = useRef(new Set<string>());
  const generation = useRef(0);
  const acknowledged = useRef(0);
  const work = useRef<Promise<boolean> | null>(null);
  const operation = useRef<Promise<boolean> | null>(null);
  const alive = useRef(true);

  const receiveSnapshot = useCallback((next: CommandEditorSnapshot) => {
    if (!alive.current || next.sessionId === authority.current.sessionId && next.version < authority.current.version) return;
    if (retiredSessions.current.has(next.sessionId)) return;
    if (authority.current.sessionId && next.sessionId !== authority.current.sessionId) retiredSessions.current.add(authority.current.sessionId);
    authority.current = next;
    setSnapshot(next);
    if (generation.current === acknowledged.current && !work.current) {
      local.current = next.items;
      baseVersion.current = next.version;
      baseSession.current = next.sessionId;
      setSets(next.items);
      setError(next.error);
    }
  }, []);

  const flush = useCallback((): Promise<boolean> => {
    if (work.current) return work.current;
    if (generation.current === acknowledged.current) return Promise.resolve(true);
    setPending(true);
    const run = async () => {
      try {
        while (generation.current !== acknowledged.current) {
          const sentGeneration = generation.current;
          const result = await popoutEventService.requestCommandEditor({
            action: 'replace', items: local.current, version: baseVersion.current, sessionId: baseSession.current,
          });
          receiveSnapshot(result.snapshot);
          if (result.snapshot.sessionId !== authority.current.sessionId) { if (alive.current) setError('editor.conflict'); return false; }
          if (!result.success) {
            if (alive.current) setError(result.error ?? 'editor.saveFailed');
            return false;
          }
          baseVersion.current = result.snapshot.version;
          baseSession.current = result.snapshot.sessionId;
          acknowledged.current = sentGeneration;
          if (generation.current === sentGeneration) {
            // A newer main edit can arrive before this ACK; it wins only after
            // our submitted text has been acknowledged, never while pending.
            local.current = authority.current.items;
            baseVersion.current = authority.current.version;
            baseSession.current = authority.current.sessionId;
            if (alive.current) setSets(local.current);
          }
          if (alive.current) setError(null);
        }
        return true;
      } catch (cause) {
        if (alive.current) setError(cause instanceof Error ? cause.message : String(cause));
        return false;
      }
    };
    const task = run().finally(() => {
      work.current = null;
      if (alive.current) setPending(false);
    });
    work.current = task;
    return task;
  }, [receiveSnapshot]);

  const replaceSets = useCallback((items: SendCommandSet[]) => {
    if (baseVersion.current < 0 || operation.current) return;
    local.current = items;
    generation.current++;
    setSets(items);
    setError(null);
    void flush();
  }, [flush]);

  const finishDraft = useCallback((action: 'save' | 'discard'): Promise<boolean> => {
    if (operation.current) return operation.current;
    setSaving(true);
    const run = async () => {
      try {
        if (action === 'save' && !await flush()) return false;
        if (action === 'discard' && work.current) await work.current;
        const result = await popoutEventService.requestCommandEditor({
          action, version: action === 'discard' ? authority.current.version : baseVersion.current,
          sessionId: action === 'discard' ? authority.current.sessionId : baseSession.current,
        });
        receiveSnapshot(result.snapshot);
        if (result.snapshot.sessionId !== authority.current.sessionId) { if (alive.current) setError('editor.conflict'); return false; }
        if (!result.success) {
          if (alive.current) setError(result.error ?? 'editor.saveFailed');
          return false;
        }
        acknowledged.current = generation.current;
        local.current = authority.current.items;
        baseVersion.current = authority.current.version;
        baseSession.current = authority.current.sessionId;
        if (alive.current) { setSets(local.current); setError(null); }
        return true;
      } catch (cause) {
        if (alive.current) setError(cause instanceof Error ? cause.message : String(cause));
        return false;
      }
    };
    const task = run().finally(() => {
      operation.current = null;
      if (alive.current) setSaving(false);
    });
    operation.current = task;
    return task;
  }, [flush, receiveSnapshot]);
  const save = useCallback(() => finishDraft('save'), [finishDraft]);
  const discard = useCallback(() => finishDraft('discard'), [finishDraft]);

  useEffect(() => registerEditorParticipant(POPOUT_COMMAND_EDITOR_ID, {
    isDirty: () => authority.current.dirty || generation.current !== acknowledged.current || !!work.current || !!operation.current || authority.current.saving,
    save: () => save(),
    discard: async () => { if (!await discard()) throw new Error('editor.saveFailed'); },
    label: () => t('popout.quickSendTitle'),
  }), [save, discard, t]);

  const unresolved = generation.current !== acknowledged.current || pending || saving;
  useEffect(() => {
    void popoutEventService.emitCommandEditorClientState(unresolved)
      .catch(cause => console.debug('[usePopoutSync] client state failed:', cause));
  }, [unresolved]);

  // A single owned listener group: keep late registration cleanup even after a
  // partial failure, and request the first snapshot only when every listener exists.
  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    const retain = (unlisten: () => void) => {
      if (cancelled) unlisten();
      else unlisteners.push(unlisten);
    };
    void Promise.all([
      popoutEventService.onCommandEditorSnapshot(next => { if (!cancelled) receiveSnapshot(next); }).then(retain),
      popoutEventService.onCommandEditorClientLeave(request => {
        if (cancelled) return;
        void (request.action === 'save' ? save() : discard()).then(success => {
          if (!cancelled) return popoutEventService.emitCommandEditorClientResult({
            requestId: request.requestId, success, error: success ? null : 'editor.saveFailed',
          });
        }).catch(cause => console.debug('[usePopoutSync] client leave ACK failed:', cause));
      }).then(retain),
      popoutEventService.onActiveTabChanged(payload => { if (!cancelled) setActivePortId(payload.portId); }).then(retain),
      eventService.onSerialStatus(event => {
        if (cancelled) return;
        setConnectedPortIds(prev => {
          const next = new Set(prev);
          if (event.status === 'connected') next.add(event.port_id);
          else next.delete(event.port_id);
          return next;
        });
      }).then(retain),
      popoutEventService.onPortStatusesSync(items => {
        if (!cancelled) setConnectedPortIds(new Set(items.filter(item => item.status === 'connected').map(item => item.portId)));
      }).then(retain),
    ]).then(async () => {
      if (!cancelled) await popoutEventService.emitRequestSync();
    }).catch(cause => {
      cancelled = true;
      unlisteners.splice(0).forEach(unlisten => unlisten());
      if (alive.current) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      alive.current = false;
      cancelled = true;
      unlisteners.splice(0).forEach(unlisten => unlisten());
      void popoutEventService.emitCommandEditorClientState(false)
        .catch(cause => console.debug('[usePopoutSync] client state cleanup failed:', cause));
    };
  }, [receiveSnapshot, save, discard]);

  useEffect(() => {
    let cancelled = false;
    void serialService.listAvailablePorts().then(list => {
      if (!cancelled) setPorts(list);
    }).catch(cause => console.debug('[usePopoutSync] listAvailablePorts failed:', cause));
    return () => { cancelled = true; };
  }, []);

  const openSetEditor = useCallback(() => {
    void popoutEventService.emitOpenConfig({ page: 'commands' })
      .catch(cause => console.debug('[usePopoutSync] emitOpenConfig failed:', cause));
  }, []);
  const dirtyIds = new Set(snapshot.dirtyIds);
  if (generation.current !== acknowledged.current) {
    for (const item of sets) {
      if (JSON.stringify(item) !== JSON.stringify(snapshot.items.find(candidate => candidate.id === item.id))) dirtyIds.add(item.id);
    }
  }
  return {
    sets, ready: snapshot.version >= 0, dirty: snapshot.dirty || generation.current !== acknowledged.current,
    dirtyIds, pending, saving: saving || snapshot.saving, error: error ?? snapshot.error,
    replaceSets, save, discard, activePortId, ports, connectedPortIds, openSetEditor,
  };
}
