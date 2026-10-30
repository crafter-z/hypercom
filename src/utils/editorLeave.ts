export interface EditorParticipant {
  isDirty: () => boolean;
  save: () => Promise<boolean>;
  discard: () => void | Promise<void>;
  label: () => string;
}

type LeaveAction = 'save' | 'discard' | 'continue';

/** A participant that never settles must not hang close approval forever. */
export const EDITOR_LEAVE_SAVE_TIMEOUT_MS = 15_000;

function withTimeout(action: () => boolean | void | Promise<boolean | void>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>(resolve => {
    timer = setTimeout(() => resolve(false), EDITOR_LEAVE_SAVE_TIMEOUT_MS);
  });
  const work = Promise.resolve().then(action).then(result => result !== false);
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

interface LeaveDialogState { open: boolean; labels: string[]; error: string | null }
interface PendingLeave { ids: string[]; resolve: (allowed: boolean) => void; promise: Promise<boolean>; responding: boolean }

const participants = new Map<string, EditorParticipant>();
const listeners = new Set<() => void>();
let pending: PendingLeave | null = null;
let dialogState: LeaveDialogState = { open: false, labels: [], error: null };

function notify(): void {
  for (const listener of [...listeners]) listener();
}

export function registerEditorParticipant(id: string, participant: EditorParticipant): () => void {
  participants.set(id, participant);
  return () => {
    if (participants.get(id) === participant) participants.delete(id);
  };
}

export function subscribeEditorLeave(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getEditorLeaveDialogState(): LeaveDialogState {
  return dialogState;
}

export function requestEditorLeave(ids?: string[]): Promise<boolean> {
  const selected = ids ? ids.map(id => [id, participants.get(id)] as const).filter((entry): entry is readonly [string, EditorParticipant] => entry[1] !== undefined)
    : [...participants.entries()];
  if (pending) {
    pending.ids = [...new Set([...pending.ids, ...selected.map(([id]) => id)])];
    dialogState = { ...dialogState, labels: [...new Set(pending.ids.map(id => participants.get(id)).filter(participant => participant?.isDirty()).map(participant => participant!.label()))] };
    notify();
    return pending.promise;
  }
  const dirty = selected.filter(([, participant]) => participant.isDirty());
  if (dirty.length === 0) return Promise.resolve(true);
  let resolve!: (allowed: boolean) => void;
  const promise = new Promise<boolean>(done => { resolve = done; });
  pending = { ids: selected.map(([id]) => id), resolve, promise, responding: false };
  dialogState = { open: true, labels: dirty.map(([, participant]) => participant.label()), error: null };
  notify();
  return promise;
}

export async function respondEditorLeave(action: LeaveAction): Promise<void> {
  const active = pending;
  if (!active || active.responding) return;
  active.responding = true;
  const selected = active.ids.map(id => participants.get(id)).filter((participant): participant is EditorParticipant => participant !== undefined);
  if (action === 'continue') {
    pending = null;
    dialogState = { open: false, labels: [], error: null };
    notify();
    active.resolve(false);
    return;
  }
  try {
    if (action === 'save') {
      for (const participant of selected) {
        if (participant.isDirty() && !(await withTimeout(() => participant.save()))) throw new Error('editor.saveFailed');
        if (pending !== active) return;
      }
    } else {
      for (const participant of selected) {
        if (participant.isDirty() && !(await withTimeout(() => participant.discard()))) throw new Error('editor.saveFailed');
        if (pending !== active) return;
      }
    }
    if (active.ids.some(id => participants.get(id)?.isDirty())) throw new Error('editor.saveFailed');
  } catch (error) {
    if (pending !== active) return;
    dialogState = { ...dialogState, open: true, error: error instanceof Error ? error.message : 'editor.saveFailed' };
    active.responding = false;
    notify();
    return;
  }
  pending = null;
  dialogState = { open: false, labels: [], error: null };
  notify();
  active.resolve(true);
}

/**
 * Escape hatch for a stuck approval: the user explicitly gives up every unsaved
 * edit, so the pending request is resolved as "allowed" without another save
 * attempt. Best-effort participant discard still runs so drafts do not survive
 * into the next session; failures are ignored because the user already accepted
 * the loss.
 */
export async function forceDiscardEditorLeave(): Promise<boolean> {
  const active = pending;
  if (!active) return true;
  active.responding = true;
  const selected = active.ids
    .map(id => participants.get(id))
    .filter((participant): participant is EditorParticipant => participant !== undefined);
  for (const participant of selected) {
    // Best effort only: both a thrown error and a promise that never settles
    // must not re-block an explicit force-close. Keep this scoped to active.ids.
    try { void Promise.resolve(participant.discard()).catch(() => {}); } catch { /* accepted loss */ }
  }
  pending = null;
  dialogState = { open: false, labels: [], error: null };
  notify();
  active.resolve(true);
  return true;
}
