import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { eventService, popoutEventService, serialService } from '../../services/tauri';
import type { AvailablePortInfo, CommandEditorAction, CommandEditorSnapshot } from '../../services/tauri';
import { registerEditorParticipant } from '../../utils/editorLeave';
import type { SendCommandSet } from '../../types';
import { readEditorRecovery, recoverableEntityCollection, recoveryKeys, recoveryRecord, writeEditorRecovery } from '../../utils/entityEditorRecovery';
import { jsonEqual } from '../../utils/jsonEqual';

export const POPOUT_COMMAND_EDITOR_ID = 'popout:commands';

function changedSetIds(previous: SendCommandSet[], next: SendCommandSet[]): string[] {
  const before = new Map(previous.map(item => [item.id, JSON.stringify(item)]));
  const after = new Map(next.map(item => [item.id, JSON.stringify(item)]));
  return [...new Set([...before.keys(), ...after.keys()])].filter(id => before.get(id) !== after.get(id));
}
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
  conflict: boolean;
  replaceSets: (items: SendCommandSet[]) => void;
  save: () => Promise<boolean>;
  discard: () => Promise<boolean>;
  overwriteHost: () => Promise<boolean>;
  reloadHost: () => Promise<boolean>;
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
  const [clientId] = useState(() => crypto.randomUUID());
  const clientSequence = useRef(0);
  const clientChallenge = useRef<string | undefined>();
  const boundHostSession = useRef('');
  const syncRequestId = useRef('');
  const hostProbePending = useRef(false);
  const restoredPending = useRef(false);
  const local = useRef<SendCommandSet[]>([]);
  const baseVersion = useRef(-1);
  const baseSession = useRef('');
  const retiredSessions = useRef(new Set<string>());
  const generation = useRef(0);
  const acknowledged = useRef(0);
  const work = useRef<Promise<boolean> | null>(null);
  const operation = useRef<Promise<boolean> | null>(null);
  const alive = useRef(true);
  const listenersReady = useRef(false);
  /** Command-set ids changed by this panel since the last acknowledged save/discard. */
  const affected = useRef(new Set<string>());
  const hasPanelEdits = useRef(false);
  const pendingBaseline = useRef<SendCommandSet[] | null>(null);
  const recoveryNeedsResolution = useRef(false);
  const recordPending = useCallback(() => {
    writeEditorRecovery('pending-commands', generation.current !== acknowledged.current ? {
      baseline: pendingBaseline.current ?? authority.current.items, draft: local.current,
    } : null);
  }, []);

  const overwrite = useRef(false);
  // Even every record is still an attributed edit, not permission to discard
  // unrelated main-window work. An explicit empty list denotes order-only work.
  const outgoingIds = useCallback((): string[] => [...affected.current], []);

  const reportClientState = useCallback((unresolved: boolean) => {
    const state = { clientId, sessionId: authority.current.sessionId, sequence: ++clientSequence.current, unresolved };
    void popoutEventService.emitCommandEditorClientState(state)
      .catch(cause => console.debug('[usePopoutSync] client state failed:', cause));
    return state;
  }, [clientId]);
  const requestSync = useCallback((probeHost = false, resetUndo = false) => {
    const requestId = crypto.randomUUID();
    syncRequestId.current = requestId;
    hostProbePending.current = probeHost || !authority.current.sessionId;
    return popoutEventService.emitRequestSync({
      clientId, sessionId: probeHost ? '' : authority.current.sessionId, sequence: ++clientSequence.current,
      syncRequestId: requestId, ...(resetUndo ? { resetUndo: true } : {}),
      ...(!probeHost && clientChallenge.current ? { challengeId: clientChallenge.current } : {}),
    }).catch(cause => { if (syncRequestId.current === requestId) hostProbePending.current = false; throw cause; });
  }, [clientId]);

  const receiveSnapshot = useCallback((next: CommandEditorSnapshot) => {
    if (boundHostSession.current && next.clientProtocol !== 2) return;
    if (next.clientId && next.clientId !== clientId) return;
    if (next.clientProtocol === 2 && next.sessionId === boundHostSession.current && (!next.clientId || next.challengeId)) return;
    if (!alive.current || next.sessionId === authority.current.sessionId && next.version < authority.current.version) return;
    if (retiredSessions.current.has(next.sessionId)) return;
    const hostChanged = next.sessionId !== authority.current.sessionId;
    const correlated = !!next.syncRequestId && next.syncRequestId === syncRequestId.current;
    if (next.clientProtocol === 2 && hostChanged && !correlated) {
      // UUIDs have no direction. An unsolicited old host must not retire today's
      // host merely by arriving first/high-version; probe the live main instead.
      if (listenersReady.current && !hostProbePending.current) void requestSync(true)
        .catch(cause => console.debug('[usePopoutSync] host probe failed:', cause));
      return;
    }
    if (correlated) hostProbePending.current = false;
    if (authority.current.sessionId && hostChanged) retiredSessions.current.add(authority.current.sessionId);
    authority.current = next;
    if (hostChanged) clientChallenge.current = undefined;
    if (next.challengeId) clientChallenge.current = next.challengeId;
    if (next.clientId === clientId && !next.challengeId) { boundHostSession.current = next.sessionId; clientChallenge.current = undefined; }
    if ((hostChanged || next.challengeId) && listenersReady.current) void requestSync().catch(cause => console.debug('[usePopoutSync] host handshake failed:', cause));
    setSnapshot(next);
    // Main may have reloaded after the last dirty-state message. Snapshot replay
    // is the handshake at which its newly registered participant must hear us.
    if (generation.current === acknowledged.current && !work.current) {
      local.current = next.items;
      baseVersion.current = next.version;
      baseSession.current = next.sessionId;
      setSets(next.items);
      setError(next.error);
    }
    if (!restoredPending.current && (next.clientProtocol !== 2 || next.clientId === clientId && !next.challengeId)) {
      restoredPending.current = true;
      const recovered = readEditorRecovery('pending-commands', (value): value is { baseline: SendCommandSet[]; draft: SendCommandSet[] } =>
        recoveryRecord(value) && recoveryKeys(value, ['baseline', 'draft']) &&
        recoverableEntityCollection('sendCommandSets', value.baseline) && recoverableEntityCollection('sendCommandSets', value.draft));
      if (recovered && !jsonEqual(recovered.draft, next.items)) {
        // Retain text, never replay it automatically over today's host/runtime.
        pendingBaseline.current = recovered.baseline;
        local.current = recovered.draft;
        generation.current++;
        affected.current = new Set(changedSetIds(recovered.baseline, recovered.draft));
        hasPanelEdits.current = true;
        recoveryNeedsResolution.current = true;
        setSets(recovered.draft);
        setError('editor.conflict');
      } else if (recovered) writeEditorRecovery('pending-commands', null);
    }
    reportClientState(generation.current !== acknowledged.current || !!work.current || !!operation.current);
  }, [reportClientState, requestSync, clientId]);

  const flush = useCallback((): Promise<boolean> => {
    if (work.current) return work.current;
    if (recoveryNeedsResolution.current && !overwrite.current) { setError('editor.conflict'); return Promise.resolve(false); }
    if (generation.current === acknowledged.current) return Promise.resolve(true);
    setPending(true);
    const run = async () => {
      try {
        while (generation.current !== acknowledged.current) {
          const sentGeneration = generation.current;
          const ids = outgoingIds();
          const payload: CommandEditorAction = {
            action: 'replace', items: local.current, version: baseVersion.current, sessionId: baseSession.current, clientId,
            ids, ...(overwrite.current ? { overwrite: true } : {}),
          };
          const result = await popoutEventService.requestCommandEditor(payload);
          if (!alive.current) return false;
          receiveSnapshot(result.snapshot);
          if (result.snapshot.sessionId !== authority.current.sessionId) { if (alive.current) setError('editor.conflict'); return false; }
          if (!result.success) {
            if (alive.current) setError(result.error ?? 'editor.saveFailed');
            return false;
          }
          overwrite.current = false;
          baseVersion.current = result.snapshot.version;
          baseSession.current = result.snapshot.sessionId;
          acknowledged.current = sentGeneration;
          recoveryNeedsResolution.current = false;
          if (generation.current === sentGeneration) {
            pendingBaseline.current = null;
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
      if (alive.current) { recordPending(); setPending(false); }
    });
    work.current = task;
    return task;
  }, [receiveSnapshot]);

  const replaceSets = useCallback((items: SendCommandSet[]) => {
    if (baseVersion.current < 0 || operation.current || authority.current.clientProtocol === 2 &&
      (authority.current.clientId !== clientId || !!authority.current.challengeId)) return;
    // Cache every id this panel edits so a later discard can be attributed.
    if (generation.current === acknowledged.current) pendingBaseline.current = local.current;
    for (const id of changedSetIds(local.current, items)) affected.current.add(id);
    hasPanelEdits.current = true;
    local.current = items;
    generation.current++;
    recordPending();
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
        if (!alive.current) return false;
        const ids = action === 'discard' ? outgoingIds() : [];
        const payload: CommandEditorAction = {
          action, version: action === 'discard' ? authority.current.version : baseVersion.current,
          sessionId: action === 'discard' ? authority.current.sessionId : baseSession.current, clientId,
          ...(action === 'discard' ? { ids } : {}),
        };
        const result = await popoutEventService.requestCommandEditor(payload);
        if (!alive.current) return false;
        receiveSnapshot(result.snapshot);
        if (result.snapshot.sessionId !== authority.current.sessionId) { if (alive.current) setError('editor.conflict'); return false; }
        if (!result.success) {
          if (alive.current) setError(result.error ?? 'editor.saveFailed');
          return false;
        }
        acknowledged.current = generation.current;
        affected.current.clear();
        hasPanelEdits.current = false;
        recoveryNeedsResolution.current = false;
        pendingBaseline.current = null;
        recordPending();
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

  /** Conflict escape hatch: resend the full local draft on the latest host version. */
  const overwriteHost = useCallback(async (): Promise<boolean> => {
    if (operation.current) return operation.current;
    if (authority.current.version < 0) return false;
    if (work.current) await work.current;
    baseVersion.current = authority.current.version;
    baseSession.current = authority.current.sessionId;
    setError(null);
    overwrite.current = true;
    generation.current++;
    return flush();
  }, [flush]);

  /** Conflict escape hatch: drop local text and adopt the host draft snapshot. */
  const reloadHost = useCallback(async (): Promise<boolean> => {
    if (operation.current) return operation.current;
    if (work.current) await work.current;
    if (!authority.current.sessionId) return false;
    affected.current.clear();
    hasPanelEdits.current = false;
    generation.current = acknowledged.current;
    recoveryNeedsResolution.current = false;
    pendingBaseline.current = null;
    recordPending();
    local.current = authority.current.items;
    baseVersion.current = authority.current.version;
    baseSession.current = authority.current.sessionId;
    setSets(local.current);
    setError(null);
    // Release the old panel undo attribution too; the retained host draft is
    // now our new starting point, not something a future discard owns.
    try { await requestSync(false, true); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false; }
    return true;
  }, [requestSync]);

  useEffect(() => registerEditorParticipant(POPOUT_COMMAND_EDITOR_ID, {
    // Host-only drafts survive this WebView; closing it must not force their
    // discard after this panel's own work has already been resolved.
    isDirty: () => hasPanelEdits.current || generation.current !== acknowledged.current || !!work.current || !!operation.current,
    save: () => save(),
    discard: async () => { if (!await discard()) throw new Error('editor.saveFailed'); },
    label: () => t('popout.quickSendTitle'),
  }), [save, discard, t]);

  const unresolved = generation.current !== acknowledged.current || pending || saving;
  useEffect(() => { reportClientState(unresolved); }, [unresolved, reportClientState]);

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
        if (cancelled || request.clientId && request.clientId !== clientId ||
          request.sessionId && request.sessionId !== authority.current.sessionId) return;
        const hostSession = authority.current.sessionId;
        void (request.action === 'save' ? save() : discard()).then(success => {
          if (cancelled || hostSession !== authority.current.sessionId) return;
          const state = reportClientState(generation.current !== acknowledged.current || !!work.current || !!operation.current);
          return popoutEventService.emitCommandEditorClientResult({
            ...(request.clientId ? state : {}), // legacy callers keep their old ACK shape
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
      if (!cancelled) { listenersReady.current = true; await requestSync(); }
    }).catch(cause => {
      cancelled = true;
      unlisteners.splice(0).forEach(unlisten => unlisten());
      if (alive.current) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      alive.current = false;
      listenersReady.current = false;
      cancelled = true;
      unlisteners.splice(0).forEach(unlisten => unlisten());
      reportClientState(false);
    };
  }, [receiveSnapshot, save, discard, requestSync, reportClientState, clientId]);

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
  const conflict = (error ?? snapshot.error) === 'editor.conflict';
  return {
    sets, ready: snapshot.version >= 0 && (snapshot.clientProtocol !== 2 || snapshot.clientId === clientId && !snapshot.challengeId), dirty: snapshot.dirty || generation.current !== acknowledged.current,
    dirtyIds, pending, saving: saving || snapshot.saving, error: error ?? snapshot.error, conflict,
    replaceSets, save, discard, overwriteHost, reloadHost, activePortId, ports, connectedPortIds, openSetEditor,
  };
}
