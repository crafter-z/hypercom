export type TimelinePhase = 'preview' | 'commit';
export type TimelineMode = 'browse' | 'live' | 'playback';
export type DragSyncPolicy = 'auto' | 'continuous' | 'on-release';
export type TimelineStatus =
  | 'exact'
  | 'nearest'
  | 'before-range'
  | 'after-range'
  | 'no-time'
  | 'filtered'
  | 'held'
  | 'loading'
  | 'unsupported'
  | 'unavailable'
  | 'slow'
  | 'error';
export interface TimelineAnchor {
  timeMs: number;
  recordKey?: string;
}
export interface TimelineMapping {
  sourceId: string;
  sourceTimeMs: number;
  groupTimeMs: number;
  clockEpoch?: string;
}
export interface TimelineCapabilities {
  preview: 'bounded' | 'commit-only';
  canDrive: boolean;
}
export interface TimelineAvailability {
  available: boolean;
  visible?: boolean;
  reason?: string;
  startTimeMs?: number;
  endTimeMs?: number;
}
export interface TimelineSeekRequest {
  groupId: string;
  navigationEpoch: number;
  gestureId: string;
  requestSeq: number;
  phase: TimelinePhase;
  mappingRevision: number;
  participantGeneration: number;
  sourceGeneration: number;
  timeMs: number;
  signal: AbortSignal;
  isCurrent: () => boolean;
}
export interface TimelineSeekResult {
  status: TimelineStatus;
  actualTimeMs: number | null;
  recordKey?: string;
  deltaMs?: number;
}
export interface TimelineParticipant {
  participantId: string;
  slotId: string;
  sourceId: string;
  sourceKind: 'live' | 'replay' | 'custom';
  generation: number;
  sourceGeneration: number;
  clockId: string;
  clockEpoch?: string;
  capabilities: TimelineCapabilities;
  availability?: TimelineAvailability;
  readAnchor: () => TimelineAnchor | null;
  seek: (
    request: TimelineSeekRequest,
  ) => Promise<TimelineSeekResult> | TimelineSeekResult;
  setGrouped?: (grouped: boolean) => void;
  /** Host-authorized same-clock LIVE tail follow, revoked outside LIVE or for offset targets. */
  setLiveFollow?: (enabled: boolean) => void;
  onUserNavigation?: () => void;
}
export interface TimelineNavigationToken {
  groupId: string;
  participantId: string;
  participantGeneration: number;
  navigationEpoch: number;
  gestureId: string;
}
export interface TimelineGroupDescriptor {
  id: string;
  name: string;
  color: string;
  memberSlots: string[];
  mappings: TimelineMapping[];
  referenceSourceId?: string;
  dragSyncPolicy: DragSyncPolicy;
}
export interface TimelineMemberSnapshot {
  slotId: string;
  participantId?: string;
  sourceId?: string;
  state: 'active' | 'temporarilyDetached' | 'unavailable';
  reason?: string;
  status?: TimelineStatus;
  actualTimeMs?: number | null;
  deltaMs?: number;
  pending: boolean;
  inFlight: boolean;
  preview: 'continuous' | 'throttled' | 'on-release';
}
export interface TimelineGroupSnapshot extends TimelineGroupDescriptor {
  mode: TimelineMode;
  committedAnchor: TimelineAnchor | null;
  previewAnchor: TimelineAnchor | null;
  navigationEpoch: number;
  mappingRevision: number;
  ownerParticipantId: string | null;
  members: TimelineMemberSnapshot[];
}
export interface TimelineSnapshot {
  revision: number;
  groups: TimelineGroupSnapshot[];
}
export interface TimelineParticipantHandle {
  participantId: string;
  dispose(): void;
  setAvailability(value: TimelineAvailability): void;
  updateCapabilities(value: TimelineCapabilities): void;
  updateSourceGeneration(generation: number, clockEpoch?: string): void;
}
export interface TimelinePersistedState {
  version: 1;
  groups: TimelineGroupDescriptor[];
}
export function toGroupTime(timeMs: number, mapping?: TimelineMapping): number {
  return mapping
    ? mapping.groupTimeMs + (timeMs - mapping.sourceTimeMs)
    : timeMs;
}
export function toSourceTime(
  timeMs: number,
  mapping?: TimelineMapping,
): number {
  return mapping
    ? mapping.sourceTimeMs + (timeMs - mapping.groupTimeMs)
    : timeMs;
}
export function serialSourceId(portId: string): string {
  return `serial:${portId}`;
}
export const HOST_CLOCK_ID = 'host-epoch-ms';
export const TIMELINE_BUDGET = Object.freeze({
  previewHz: 15,
  slowPreviewHz: 5,
  batchMs: 4,
  frameFraction: 0.25,
  frameMs: 1000 / 60,
  pressureFrames: 3,
  previewSlowMs: 150,
  commitSlowMs: 2000,
  controlPerBatch: 4,
});
