export interface EditorParticipant {
  isDirty: () => boolean;
  save: () => Promise<boolean>;
  discard: () => void | Promise<void>;
  label: () => string;
}

type LeaveAction = 'save' | 'discard' | 'continue';
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
        if (participant.isDirty() && !(await participant.save())) throw new Error('editor.saveFailed');
      }
    } else {
      for (const participant of selected) await participant.discard();
    }
    if (active.ids.some(id => participants.get(id)?.isDirty())) throw new Error('editor.saveFailed');
  } catch (error) {
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
