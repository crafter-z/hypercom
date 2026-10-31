import {
  getViewportManager,
  type TerminalViewportManager,
} from '../terminal/viewportManager';
import { TimelineCoordinator, timelineCoordinator } from './coordinator';
import {
  HOST_CLOCK_ID,
  serialSourceId,
  type TimelineAnchor,
  type TimelineNavigationToken,
  type TimelineParticipantHandle,
} from './types';
export interface TrxTimelineAdapterOptions {
  slotId: string;
  portId?: string;
  manager?: TerminalViewportManager;
  participantId?: string;
  coordinator?: TimelineCoordinator;
  visible?: boolean;
  sourceId?: string;
  sourceKind?: 'live' | 'replay';
  clockId?: string;
  onUserNavigation?: () => void;
}
export interface TrxTimelineAdapterHandle extends TimelineParticipantHandle {
  readAnchor(): TimelineAnchor | null;
  beginNavigation(): TimelineNavigationToken | null;
  updateNavigation(
    token: TimelineNavigationToken,
    anchor: TimelineAnchor,
  ): void;
  endNavigation(token: TimelineNavigationToken, anchor?: TimelineAnchor): void;
  cancelNavigation(token: TimelineNavigationToken): void;
  refreshSource(): void;
}
let generation = 0;
export function createTrxTimelineAdapter(
  options: TrxTimelineAdapterOptions,
): TrxTimelineAdapterHandle {
  const coordinator = options.coordinator ?? timelineCoordinator;
  if (!options.manager && !options.portId)
    throw new Error('A TRX manager or real port is required');
  if (!options.sourceId && !options.portId)
    throw new Error('A replay adapter requires an explicit source identity');
  const manager = options.manager ?? getViewportManager(options.portId!);
  const instance = ++generation;
  const participantId =
    options.participantId ?? `trx:${options.slotId}:${instance}`;
  let handle: TimelineParticipantHandle | undefined;
  let sourceGeneration = manager.sourceGeneration;
  let clockEpoch = manager.readTimelineAnchor()?.clockEpoch;
  let disposed = false;
  const refreshSource = () => {
    const current = manager.sourceGeneration;
    const anchor = manager.readTimelineAnchor();
    const epoch = anchor
      ? anchor.clockEpoch
      : current !== sourceGeneration
        ? undefined
        : clockEpoch;
    if (current !== sourceGeneration || epoch !== clockEpoch) {
      sourceGeneration = current;
      clockEpoch = epoch;
      handle?.updateSourceGeneration(sourceGeneration, clockEpoch);
    }
  };
  const readAnchor = (): TimelineAnchor | null => {
    refreshSource();
    const anchor = manager.readTimelineAnchor();
    return anchor && anchor.timeMs !== null && Number.isFinite(anchor.timeMs)
      ? { timeMs: anchor.timeMs, recordKey: anchor.recordKey }
      : null;
  };
  handle = coordinator.registerParticipant({
    participantId,
    slotId: options.slotId,
    sourceId: options.sourceId ?? serialSourceId(options.portId!),
    sourceKind: options.sourceKind ?? 'live',
    generation: instance,
    sourceGeneration,
    clockId: options.clockId ?? HOST_CLOCK_ID,
    clockEpoch,
    capabilities: { preview: 'bounded', canDrive: true },
    availability: { available: true, visible: options.visible ?? true },
    readAnchor,
    seek: async (request) => {
      refreshSource();
      if (!request.isCurrent() || disposed)
        return { status: 'unavailable', actualTimeMs: null };
      return manager.seekTimeline(request);
    },
    setGrouped: (grouped) => manager.setTimelineGrouped(grouped),
    setLiveFollow: (enabled) => manager.setTimelineLiveFollow(enabled),
    onUserNavigation: options.onUserNavigation,
  });
  const unsubscribe = manager.subscribeReadouts(refreshSource);
  return {
    ...handle,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      handle?.dispose();
    },
    readAnchor,
    refreshSource,
    beginNavigation: () => {
      refreshSource();
      return coordinator.beginNavigation(participantId);
    },
    updateNavigation: (token, anchor) => {
      refreshSource();
      coordinator.updateNavigation(token, anchor);
    },
    endNavigation: (token, anchor) => {
      refreshSource();
      coordinator.endNavigation(token, anchor);
    },
    cancelNavigation: (token) => coordinator.cancelNavigation(token),
  };
}
