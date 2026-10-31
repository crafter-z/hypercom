import { TimelineScheduler, type TimelineSchedulerOptions } from './scheduler';
import {
  HOST_CLOCK_ID,
  TIMELINE_BUDGET,
  toGroupTime,
  toSourceTime,
  type TimelineAnchor,
  type TimelineAvailability,
  type TimelineCapabilities,
  type TimelineGroupDescriptor,
  type TimelineGroupSnapshot,
  type TimelineMapping,
  type TimelineMemberSnapshot,
  type TimelineMode,
  type TimelineNavigationToken,
  type TimelineParticipant,
  type TimelineParticipantHandle,
  type TimelinePersistedState,
  type TimelinePhase,
  type TimelineSeekResult,
  type TimelineSnapshot,
  type DragSyncPolicy,
} from './types';
interface Group {
  lastLiveCommit?: number;
  referenceClock?: { id: string; epoch?: string };
  descriptor: TimelineGroupDescriptor;
  mode: TimelineMode;
  committed: TimelineAnchor | null;
  preview: TimelineAnchor | null;
  epoch: number;
  mappingRevision: number;
  owner: string | null;
  gestureId: string;
  ended: boolean;
  detached: Set<string>;
  results: Map<string, TimelineSeekResult>;
  tiers: Map<string, TimelineMemberSnapshot['preview']>;
  unconfirmedSources: Set<string>;
}
export interface CreateTimelineGroup {
  id?: string;
  name: string;
  color?: string;
  memberSlots?: string[];
  dragSyncPolicy?: DragSyncPolicy;
  anchor?: TimelineAnchor;
  referenceSourceId?: string;
  originSlotId?: string;
}
const finite = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n);
let unique = 0;
const uid = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${++unique}`;
export class TimelineCoordinator {
  private groups = new Map<string, Group>();
  private participants = new Map<string, TimelineParticipant>();
  private slots = new Map<string, string>();
  private listeners = new Set<() => void>();
  private revision = 0;
  private sequence = 0;
  private snapshot: TimelineSnapshot = { revision: 0, groups: [] };
  private restoring = false;
  private liveTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private costs = new Map<string, number>();
  readonly scheduler: TimelineScheduler;
  constructor(options: TimelineSchedulerOptions = {}) {
    this.scheduler = new TimelineScheduler({
      ...options,
      changed: () => {
        options.changed?.();
        if (this.scheduler.previewsPaused) {
          for (const group of this.groups.values()) {
            if (!group.owner && group.mode !== 'live') continue;
            for (const slot of group.descriptor.memberSlots) {
              group.tiers.set(slot, 'on-release');
              const participant = this.participantForSlot(slot);
              if (participant)
                this.scheduler.dropPendingPreview(participant.participantId);
            }
          }
        }
        this.publish();
      },
    });
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = (): TimelineSnapshot => this.snapshot;
  groupForSlot(slotId: string): TimelineGroupSnapshot | undefined {
    return this.snapshot.groups.find((g) => g.memberSlots.includes(slotId));
  }
  participantForSlot(slotId: string): TimelineParticipant | undefined {
    const id = this.slots.get(slotId);
    return id ? this.participants.get(id) : undefined;
  }
  readSlotAnchor(slotId: string): TimelineAnchor | null {
    return this.participantForSlot(slotId)?.readAnchor() ?? null;
  }
  registerParticipant(adapter: TimelineParticipant): TimelineParticipantHandle {
    if (
      !adapter.participantId ||
      !adapter.slotId ||
      !adapter.sourceId ||
      !finite(adapter.generation) ||
      !finite(adapter.sourceGeneration)
    )
      throw new Error('Invalid timeline participant identity');
    const previous = this.participantForSlot(adapter.slotId);
    if (previous) this.unregister(previous);
    const duplicate = this.participants.get(adapter.participantId);
    if (duplicate) this.unregister(duplicate);
    const participant = {
      ...adapter,
      capabilities: { ...adapter.capabilities },
      availability: { available: true, visible: true, ...adapter.availability },
    };
    this.participants.set(participant.participantId, participant);
    this.slots.set(participant.slotId, participant.participantId);
    const group = this.findGroup(participant.slotId);
    if (group) {
      this.rememberReference(group, participant);
      this.stopUnsupportedLive(group);
    }
    participant.setGrouped?.(!!group);
    this.publish();
    this.realign(participant.slotId);
    const current = () =>
      this.participants.get(participant.participantId) === participant;
    return {
      participantId: participant.participantId,
      dispose: () => {
        if (current()) this.unregister(participant);
      },
      setAvailability: (value: TimelineAvailability) => {
        if (!current()) return;
        participant.availability = { ...participant.availability, ...value };
        const enabled =
          value.available && participant.availability.visible !== false;
        this.scheduler.setEnabled(participant.participantId, enabled);
        if (enabled) this.realign(participant.slotId);
        this.publish();
      },
      updateCapabilities: (value: TimelineCapabilities) => {
        if (!current()) return;
        participant.capabilities = { ...value };
        // Sorting a table away from time order revokes an active driving lease.
        // Advance its epoch as well, so false -> true never revives the old token.
        const group = this.findGroup(participant.slotId);
        if (!value.canDrive && group?.owner === participant.participantId)
          this.invalidateGroup(group);
        this.publish();
      },
      updateSourceGeneration: (generation: number, clockEpoch?: string) => {
        if (!current() || !finite(generation)) return;
        if (
          generation === participant.sourceGeneration &&
          clockEpoch === participant.clockEpoch
        )
          return;
        const group = this.findGroup(participant.slotId);
        if (clockEpoch !== participant.clockEpoch)
          group?.unconfirmedSources.add(participant.sourceId);
        participant.sourceGeneration = generation;
        participant.clockEpoch = clockEpoch;
        group?.results.delete(participant.slotId);
        this.invalidateParticipant(participant);
        this.realign(participant.slotId);
        this.publish();
      },
    };
  }
  private unregister(participant: TimelineParticipant): void {
    const group = this.findGroup(participant.slotId);
    group?.results.delete(participant.slotId);
    group?.tiers.delete(participant.slotId);
    this.invalidateParticipant(participant);
    this.scheduler.remove(participant.participantId);
    this.costs.delete(participant.participantId);
    this.participants.delete(participant.participantId);
    if (this.slots.get(participant.slotId) === participant.participantId)
      this.slots.delete(participant.slotId);
    participant.setLiveFollow?.(false);
    participant.setGrouped?.(false);
    this.publish();
  }
  private invalidateParticipant(participant: TimelineParticipant): void {
    this.scheduler.invalidate(participant.participantId);
    const group = this.findGroup(participant.slotId);
    if (group?.owner === participant.participantId) this.invalidateGroup(group);
  }
  createGroup(input: CreateTimelineGroup): string {
    const id = input.id ?? uid('timeline');
    if (this.groups.has(id)) throw new Error('Timeline group already exists');
    if (input.anchor && !finite(input.anchor.timeMs))
      throw new Error('Invalid timeline anchor');
    const group: Group = {
      descriptor: {
        id,
        name: input.name,
        color: input.color ?? '#60a5fa',
        memberSlots: [],
        mappings: [],
        dragSyncPolicy: input.dragSyncPolicy ?? 'auto',
        referenceSourceId: input.referenceSourceId,
      },
      mode: 'browse',
      committed: input.anchor ? { ...input.anchor } : null,
      preview: null,
      epoch: 0,
      mappingRevision: 0,
      owner: null,
      gestureId: uid('gesture'),
      ended: true,
      detached: new Set(),
      results: new Map(),
      tiers: new Map(),
      unconfirmedSources: new Set(),
    };
    this.groups.set(id, group);
    const wasRestoring = this.restoring;
    this.restoring = true;
    for (const slot of input.memberSlots ?? []) this.addMember(id, slot);
    this.restoring = wasRestoring;
    if (!this.restoring && !group.committed) {
      for (const slot of group.descriptor.memberSlots) {
        const p = this.participantForSlot(slot);
        const anchor = p?.readAnchor();
        if (anchor && finite(anchor.timeMs)) {
          group.committed = {
            ...anchor,
            timeMs: toGroupTime(
              anchor.timeMs,
              this.mapping(group, p!.sourceId),
            ),
          };
          break;
        }
      }
    }
    if (group.committed)
      this.broadcast(
        group,
        group.committed,
        'commit',
        input.originSlotId
          ? this.participantForSlot(input.originSlotId)?.participantId
          : undefined,
      );
    this.publish();
    return id;
  }
  addMember(groupId: string, slotId: string): void {
    const group = this.requireGroup(groupId);
    if (this.findGroup(slotId) === group) return;
    this.removeMember(slotId);
    group.descriptor.memberSlots.push(slotId);
    const participant = this.participantForSlot(slotId);
    if (participant) this.rememberReference(group, participant);
    this.stopUnsupportedLive(group);
    participant?.setGrouped?.(true);
    this.realign(slotId);
    this.publish();
  }
  removeMember(slotId: string): void {
    const group = this.findGroup(slotId);
    if (!group) return;
    const p = this.participantForSlot(slotId);
    if (p) {
      this.scheduler.invalidate(p.participantId);
      if (group.owner === p.participantId) this.invalidateGroup(group);
      p.setLiveFollow?.(false);
      p.setGrouped?.(false);
    }
    group.descriptor.memberSlots = group.descriptor.memberSlots.filter(
      (s) => s !== slotId,
    );
    group.detached.delete(slotId);
    group.results.delete(slotId);
    group.tiers.delete(slotId);
    this.publish();
  }
  deleteGroup(id: string): void {
    const group = this.groups.get(id);
    if (!group) return;
    for (const slot of [...group.descriptor.memberSlots])
      this.removeMember(slot);
    this.groups.delete(id);
    this.publish();
  }
  setDetached(slotId: string, detached: boolean): void {
    const g = this.findGroup(slotId);
    if (!g) return;
    const p = this.participantForSlot(slotId);
    if (detached) {
      g.detached.add(slotId);
      if (p) this.scheduler.invalidate(p.participantId);
      if (g.owner === p?.participantId) this.invalidateGroup(g);
    } else {
      g.detached.delete(slotId);
      this.realign(slotId);
    }
    this.publish();
  }
  setDragSyncPolicy(id: string, policy: DragSyncPolicy): void {
    if (!['auto', 'continuous', 'on-release'].includes(policy)) return;
    this.requireGroup(id).descriptor.dragSyncPolicy = policy;
    this.publish();
  }
  setMapping(id: string, mapping: TimelineMapping): void {
    if (
      !finite(mapping.sourceTimeMs) ||
      !finite(mapping.groupTimeMs) ||
      !mapping.sourceId
    )
      throw new Error('Invalid timeline mapping');
    const g = this.requireGroup(id);
    this.invalidateGroup(g);
    g.descriptor.mappings = [
      ...g.descriptor.mappings.filter((m) => m.sourceId !== mapping.sourceId),
      { ...mapping },
    ];
    g.unconfirmedSources.delete(mapping.sourceId);
    g.mappingRevision++;
    if (g.committed) this.broadcast(g, g.committed, 'commit');
    this.publish();
  }
  /** The Pin control and transport share one LIVE eligibility check. */
  canSetLive(id: string): boolean {
    const g = this.groups.get(id);
    return !!g && this.supportsLive(g);
  }
  private supportsLive(g: Group): boolean {
    const members = g.descriptor.memberSlots
      .map((slot) => this.participantForSlot(slot))
      .filter((p): p is TimelineParticipant => !!p);
    return members.length > 0 && members.every(
      (p) => p.sourceKind === 'live' && p.clockId === HOST_CLOCK_ID,
    );
  }
  private stopUnsupportedLive(g: Group): void {
    if (g.mode !== 'live' || this.supportsLive(g)) return;
    this.invalidateGroup(g);
    g.mode = 'browse';
  }
  /** Existing scroll-lock Pin toggles group transport, never independent tail-follow. */
  toggleSlotFollow(slotId: string): void {
    const g = this.findGroup(slotId);
    if (g) this.setMode(g.descriptor.id, g.mode === 'live' ? 'browse' : 'live');
  }
  setMode(id: string, mode: TimelineMode): void {
    const g = this.requireGroup(id);
    const members = g.descriptor.memberSlots
      .map((s) => this.participantForSlot(s))
      .filter((p): p is TimelineParticipant => !!p);
    if (mode === 'live' && !this.supportsLive(g))
      throw new Error('LIVE requires compatible live sources');
    if (
      mode === 'playback' &&
      (!members.length || members.some((p) => p.sourceKind !== 'replay'))
    )
      throw new Error('PLAYBACK requires replay-only sources');
    this.invalidateGroup(g);
    g.mode = mode;
    if (mode === 'live') this.updateLiveGroup(g, 'commit');
    this.scheduleLive();
    this.publish();
  }
  private liveReference(g: Group, members = g.descriptor.memberSlots
    .map(slot => this.participantForSlot(slot))
    .filter((participant): participant is TimelineParticipant => !!participant)): TimelineParticipant | undefined {
    return members.find(participant => participant.sourceId === g.descriptor.referenceSourceId)
      ?? members.find(participant => participant.clockId === HOST_CLOCK_ID && participant.sourceKind === 'live');
  }
  private updateLiveGroup(g: Group, phase: TimelinePhase): void {
    const members = g.descriptor.memberSlots
      .map((s) => this.participantForSlot(s))
      .filter((p): p is TimelineParticipant => !!p);
    const reference = this.liveReference(g, members);
    if (!reference) return;
    const timeMs = toGroupTime(Date.now(), this.mapping(g, reference.sourceId));
    g.committed = { timeMs };
    g.preview = null;
    const commitFallback =
      phase === 'commit' ||
      Date.now() - (g.lastLiveCommit ?? -Infinity) >= 1000;
    for (const participant of members) {
      const deferred =
        participant.capabilities.preview === 'commit-only' ||
        g.tiers.get(participant.slotId) === 'on-release';
      if (!deferred || commitFallback)
        this.queue(g, participant, g.committed, deferred ? 'commit' : phase);
    }
    if (commitFallback) g.lastLiveCommit = Date.now();
  }
  private scheduleLive(): void {
    const hasLiveReference =
      !this.disposed &&
      [...this.groups.values()].some(
        (group) =>
          group.mode === 'live' &&
          group.descriptor.memberSlots.some((slot) => {
            const participant = this.participantForSlot(slot);
            return (
              participant?.sourceKind === 'live' &&
              participant.clockId === HOST_CLOCK_ID
            );
          }),
      );
    if (!hasLiveReference) {
      if (this.liveTimer !== undefined) clearTimeout(this.liveTimer);
      this.liveTimer = undefined;
      return;
    }
    if (this.liveTimer !== undefined) return;
    this.liveTimer = setTimeout(() => {
      this.liveTimer = undefined;
      if (this.disposed) return;
      for (const g of this.groups.values())
        if (g.mode === 'live') this.updateLiveGroup(g, 'preview');
      this.publish();
      this.scheduleLive();
    }, 1000 / TIMELINE_BUDGET.previewHz);
  }
  beginNavigation(participantId: string): TimelineNavigationToken | null {
    const p = this.participants.get(participantId);
    if (
      !p ||
      !p.capabilities.canDrive ||
      p.availability?.available === false ||
      p.availability?.visible === false
    )
      return null;
    const g = this.findGroup(p.slotId);
    if (!g || g.detached.has(p.slotId) || !this.compatible(g, p)) return null;
    this.invalidateGroup(g);
    g.mode = 'browse';
    g.owner = participantId;
    g.gestureId = uid('gesture');
    g.ended = false;
    g.tiers.clear();
    this.scheduler.beginGesture(g.descriptor.id);
    for (const slot of g.descriptor.memberSlots)
      this.participantForSlot(slot)?.onUserNavigation?.();
    this.publish();
    return {
      groupId: g.descriptor.id,
      participantId,
      participantGeneration: p.generation,
      navigationEpoch: g.epoch,
      gestureId: g.gestureId,
    };
  }
  updateNavigation(
    token: TimelineNavigationToken,
    anchor: TimelineAnchor,
  ): void {
    const pair = this.validateToken(token);
    if (!pair || !finite(anchor.timeMs)) return;
    const [g, p] = pair;
    g.preview = {
      ...anchor,
      timeMs: toGroupTime(anchor.timeMs, this.mapping(g, p.sourceId)),
    };
    this.broadcast(g, g.preview, 'preview', p.participantId);
    this.publish();
  }
  endNavigation(token: TimelineNavigationToken, anchor?: TimelineAnchor): void {
    const pair = this.validateToken(token);
    if (!pair) return;
    const [g, p] = pair;
    const final = anchor ?? p.readAnchor();
    // Anchor sampling can synchronously publish a new source/clock generation.
    // Never let that reentrant invalidation commit the lease we just sampled.
    if (!this.validateToken(token)) return;
    if (final && finite(final.timeMs)) {
      g.committed = {
        ...final,
        timeMs: toGroupTime(final.timeMs, this.mapping(g, p.sourceId)),
      };
      g.preview = null;
      this.broadcast(g, g.committed, 'commit', p.participantId);
      g.results.set(p.slotId, {
        status: 'exact',
        actualTimeMs: final.timeMs,
        recordKey: final.recordKey,
        deltaMs: 0,
      });
    }
    g.ended = true;
    g.owner = null;
    this.scheduler.endGesture(g.descriptor.id);
    this.publish();
  }
  cancelNavigation(token: TimelineNavigationToken): void {
    const pair = this.validateToken(token);
    if (!pair) return;
    const [g] = pair;
    this.invalidateGroup(g);
    this.publish();
  }
  seek(groupId: string, timeMs: number, phase: TimelinePhase = 'commit'): void {
    if (!finite(timeMs)) return;
    const g = this.requireGroup(groupId);
    if (phase === 'commit') {
      this.invalidateGroup(g);
      g.mode = 'browse';
      for (const slot of g.descriptor.memberSlots)
        this.participantForSlot(slot)?.onUserNavigation?.();
      g.committed = { timeMs };
      g.preview = null;
    } else g.preview = { timeMs };
    this.broadcast(g, { timeMs }, phase);
    this.publish();
  }
  realign(slotId: string): void {
    const g = this.findGroup(slotId);
    const p = this.participantForSlot(slotId);
    const anchor = g?.preview ?? g?.committed;
    if (!this.restoring && g && p && anchor)
      this.queue(g, p, anchor, g.preview ? 'preview' : 'commit');
  }
  private broadcast(
    g: Group,
    anchor: TimelineAnchor,
    phase: TimelinePhase,
    skip?: string,
  ): void {
    for (const slot of g.descriptor.memberSlots) {
      const p = this.participantForSlot(slot);
      if (p && p.participantId !== skip) this.queue(g, p, anchor, phase);
    }
  }
  private queue(
    g: Group,
    p: TimelineParticipant,
    anchor: TimelineAnchor,
    phase: TimelinePhase,
  ): void {
    if (g.detached.has(p.slotId) || !this.compatible(g, p)) return;
    const available =
      p.availability?.available !== false && p.availability?.visible !== false;
    if (!available) {
      this.scheduler.invalidate(p.participantId);
      return;
    }
    let tier =
      g.tiers.get(p.slotId) ??
      ((g.mode !== 'live' && g.descriptor.dragSyncPolicy === 'on-release') ||
      p.capabilities.preview !== 'bounded' ||
      (g.mode !== 'live' &&
        g.descriptor.dragSyncPolicy === 'auto' &&
        !this.costs.has(p.participantId))
        ? 'on-release'
        : g.descriptor.dragSyncPolicy === 'auto' &&
            (this.costs.get(p.participantId) ?? 0) > TIMELINE_BUDGET.batchMs
          ? 'throttled'
          : 'continuous');
    if (this.scheduler.previewsPaused) tier = 'on-release';
    g.tiers.set(p.slotId, tier);
    if (phase === 'preview' && tier === 'on-release') return;
    const epoch = g.epoch,
      mappingRevision = g.mappingRevision,
      generation = p.generation,
      sourceGeneration = p.sourceGeneration,
      clockEpoch = p.clockEpoch,
      seq = ++this.sequence;
    const target = toSourceTime(anchor.timeMs, this.mapping(g, p.sourceId));
    const valid = () =>
      this.groups.get(g.descriptor.id) === g &&
      g.epoch === epoch &&
      g.mappingRevision === mappingRevision &&
      this.participants.get(p.participantId) === p &&
      p.generation === generation &&
      p.sourceGeneration === sourceGeneration &&
      p.clockEpoch === clockEpoch &&
      !g.detached.has(p.slotId) &&
      this.findGroup(p.slotId) === g;
    this.scheduler.enqueue(p.participantId, {
      phase,
      epoch,
      sequence: seq,
      valid,
      run: async (signal) => {
        if (!valid() || signal.aborted) return;
        const result = await p.seek({
          groupId: g.descriptor.id,
          navigationEpoch: epoch,
          gestureId: g.gestureId,
          requestSeq: seq,
          phase,
          mappingRevision,
          participantGeneration: generation,
          sourceGeneration,
          timeMs: target,
          signal,
          isCurrent: () => valid() && !signal.aborted,
        });
        if (!valid() || signal.aborted) return;
        g.results.set(p.slotId, {
          ...result,
          deltaMs:
            result.actualTimeMs === null
              ? undefined
              : toGroupTime(result.actualTimeMs, this.mapping(g, p.sourceId)) -
                anchor.timeMs,
        });
        this.publish();
      },
      slow: () => {
        if (!valid()) return;
        g.tiers.set(p.slotId, 'on-release');
        this.scheduler.dropPendingPreview(p.participantId);
        g.results.set(p.slotId, {
          status: 'slow',
          actualTimeMs: g.results.get(p.slotId)?.actualTimeMs ?? null,
        });
        this.publish();
      },
      settled: (elapsed, error) => {
        if (!valid()) return;
        if (!error) this.costs.set(p.participantId, elapsed);
        if (error)
          g.results.set(p.slotId, { status: 'error', actualTimeMs: null });
        if (phase === 'preview' && elapsed > TIMELINE_BUDGET.batchMs) {
          const old = g.tiers.get(p.slotId);
          const next =
            old === 'on-release' ||
            old === 'throttled' ||
            elapsed >= TIMELINE_BUDGET.previewSlowMs
              ? 'on-release'
              : 'throttled';
          g.tiers.set(p.slotId, next);
          if (next === 'on-release')
            this.scheduler.dropPendingPreview(p.participantId);
          this.scheduler.setPreviewInterval(
            p.participantId,
            1000 / TIMELINE_BUDGET.slowPreviewHz,
          );
        }
        this.publish();
      },
    });
    if (tier === 'throttled')
      this.scheduler.setPreviewInterval(
        p.participantId,
        1000 / TIMELINE_BUDGET.slowPreviewHz,
      );
  }
  private rememberReference(g: Group, p: TimelineParticipant): void {
    if (
      g.referenceClock ||
      (g.descriptor.referenceSourceId &&
        g.descriptor.referenceSourceId !== p.sourceId)
    )
      return;
    g.descriptor.referenceSourceId ??= p.sourceId;
    g.referenceClock = { id: p.clockId, epoch: p.clockEpoch };
  }
  private compatible(g: Group, p: TimelineParticipant): boolean {
    const m = this.mapping(g, p.sourceId);
    if (m) return m.clockEpoch === p.clockEpoch;
    if (g.unconfirmedSources.has(p.sourceId)) return false;
    const peers = g.descriptor.memberSlots
      .map((s) => this.participantForSlot(s))
      .filter((x): x is TimelineParticipant => !!x);
    const ref =
      peers.find((x) => x.sourceId === g.descriptor.referenceSourceId) ??
      peers[0];
    const clock =
      g.referenceClock ??
      (ref ? { id: ref.clockId, epoch: ref.clockEpoch } : undefined);
    return (
      !clock ||
      (!!clock.id && clock.id === p.clockId && clock.epoch === p.clockEpoch)
    );
  }
  private mapping(g: Group, sourceId: string): TimelineMapping | undefined {
    return g.descriptor.mappings.find((m) => m.sourceId === sourceId);
  }
  private findGroup(slot: string): Group | undefined {
    return [...this.groups.values()].find((g) =>
      g.descriptor.memberSlots.includes(slot),
    );
  }
  private requireGroup(id: string): Group {
    const g = this.groups.get(id);
    if (!g) throw new Error('Unknown timeline group');
    return g;
  }
  private invalidateGroup(g: Group): void {
    this.scheduler.endGesture(g.descriptor.id);
    g.epoch++;
    g.gestureId = uid('gesture');
    g.owner = null;
    g.preview = null;
    g.ended = true;
    for (const slot of g.descriptor.memberSlots) {
      const p = this.participantForSlot(slot);
      if (p) this.scheduler.invalidate(p.participantId);
    }
  }
  private validateToken(
    t: TimelineNavigationToken,
  ): [Group, TimelineParticipant] | null {
    const g = this.groups.get(t.groupId),
      p = this.participants.get(t.participantId);
    return g &&
      p &&
      !g.ended &&
      g.owner === t.participantId &&
      g.epoch === t.navigationEpoch &&
      g.gestureId === t.gestureId &&
      p.generation === t.participantGeneration
      ? [g, p]
      : null;
  }
  exportState(): TimelinePersistedState {
    return {
      version: 1,
      groups: [...this.groups.values()].map((g) => ({
        ...g.descriptor,
        memberSlots: [...g.descriptor.memberSlots],
        mappings: g.descriptor.mappings.map((m) => ({ ...m })),
      })),
    };
  }
  restoreState(value: unknown, validSlots?: ReadonlySet<string>): void {
    if (
      !value ||
      typeof value !== 'object' ||
      (value as TimelinePersistedState).version !== 1 ||
      !Array.isArray((value as TimelinePersistedState).groups)
    )
      return;
    for (const id of [...this.groups.keys()]) this.deleteGroup(id);
    const seen = new Set<string>();
    this.restoring = true;
    for (const raw of (value as TimelinePersistedState).groups.slice(0, 64)) {
      if (
        !raw ||
        typeof raw.id !== 'string' ||
        !raw.id ||
        typeof raw.name !== 'string' ||
        !Array.isArray(raw.memberSlots) ||
        this.groups.has(raw.id)
      )
        continue;
      const slots = raw.memberSlots
        .filter(
          (s): s is string =>
            typeof s === 'string' &&
            !!s &&
            (!validSlots || validSlots.has(s)) &&
            !seen.has(s),
        )
        .slice(0, 256);
      slots.forEach((s) => seen.add(s));
      this.createGroup({
        id: raw.id,
        name: raw.name.slice(0, 200),
        color: typeof raw.color === 'string' ? raw.color : undefined,
        memberSlots: slots,
        dragSyncPolicy: ['auto', 'continuous', 'on-release'].includes(
          raw.dragSyncPolicy,
        )
          ? raw.dragSyncPolicy
          : 'auto',
        referenceSourceId:
          typeof raw.referenceSourceId === 'string'
            ? raw.referenceSourceId
            : undefined,
      });
      const g = this.requireGroup(raw.id);
      g.committed = null;
      g.mode = 'browse';
      g.descriptor.mappings = Array.isArray(raw.mappings)
        ? raw.mappings
            .filter(
              (m) =>
                m &&
                typeof m.sourceId === 'string' &&
                finite(m.sourceTimeMs) &&
                finite(m.groupTimeMs),
            )
            .map((m) => ({
              sourceId: m.sourceId,
              sourceTimeMs: m.sourceTimeMs,
              groupTimeMs: m.groupTimeMs,
              clockEpoch:
                typeof m.clockEpoch === 'string' ? m.clockEpoch : undefined,
            }))
        : [];
      this.invalidateGroup(g);
    }
    this.restoring = false;
    this.publish();
  }
  private publish(): void {
    this.scheduleLive();
    this.snapshot = {
      revision: ++this.revision,
      groups: [...this.groups.values()].map((g) => {
        const reference = this.liveReference(g);
        const referenceOffset = reference ? toGroupTime(0, this.mapping(g, reference.sourceId)) : undefined;
        return {
          ...g.descriptor,
          memberSlots: [...g.descriptor.memberSlots],
          mappings: g.descriptor.mappings.map((m) => ({ ...m })),
          mode: g.mode,
          committedAnchor: g.committed ? { ...g.committed } : null,
          previewAnchor: g.preview ? { ...g.preview } : null,
          navigationEpoch: g.epoch,
          mappingRevision: g.mappingRevision,
          ownerParticipantId: g.owner,
          members: g.descriptor.memberSlots.map((slotId) => {
            const p = this.participantForSlot(slotId),
              result = g.results.get(slotId);
            p?.setLiveFollow?.(g.mode === 'live' && !this.restoring
              && p.sourceKind === 'live' && p.clockId === HOST_CLOCK_ID
              && !g.detached.has(slotId) && p.availability?.available !== false && p.availability?.visible !== false
              && this.compatible(g, p) && toGroupTime(0, this.mapping(g, p.sourceId)) === referenceOffset);
            return {
              slotId,
              participantId: p?.participantId,
              sourceId: p?.sourceId,
              state: g.detached.has(slotId)
                ? 'temporarilyDetached'
                : !p ||
                    p.availability?.available === false ||
                    p.availability?.visible === false ||
                    !this.compatible(g, p)
                  ? 'unavailable'
                  : 'active',
              reason:
                p?.availability?.reason ??
                (!p
                  ? 'adapter-unavailable'
                  : !this.compatible(g, p)
                    ? 'mapping-required'
                    : undefined),
              ...result,
              ...(p
                ? this.scheduler.state(p.participantId)
                : { pending: false, inFlight: false }),
              preview: this.scheduler.previewsPaused
                ? 'on-release'
                : (g.tiers.get(slotId) ??
                  (g.descriptor.dragSyncPolicy === 'on-release' ||
                  p?.capabilities.preview !== 'bounded'
                    ? 'on-release'
                    : 'continuous')),
            } as TimelineMemberSnapshot;
          }),
        };
      }),
    };
    for (const listener of this.listeners) listener();
  }
  dispose(): void {
    this.disposed = true;
    if (this.liveTimer) clearTimeout(this.liveTimer);
    this.liveTimer = undefined;
    this.scheduler.dispose();
    for (const p of this.participants.values()) {
      p.setLiveFollow?.(false);
      p.setGrouped?.(false);
    }
    this.participants.clear();
    this.slots.clear();
    this.groups.clear();
    this.publish();
    this.listeners.clear();
  }
}
export const timelineCoordinator = new TimelineCoordinator();
