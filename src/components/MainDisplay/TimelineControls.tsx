import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Link2, Unlink, X } from 'lucide-react';
import { useAppStore } from '../../stores/useAppStore';
import { notifyError } from '../../stores/useToastStore';
import { timelineCoordinator, type DragSyncPolicy, type TimelineGroupSnapshot } from '../../utils/timeline';
import { usePluginViewOverlay } from '../shared/usePluginViewOverlay';
import { safeCssColor } from '../../utils/cssColor';
import { formatTimelineTime as clockLabel } from '../../utils/timeFormat';
import './TimelineControls.css';

let panelSlot: string | null = null;
const panelListeners = new Set<() => void>();
export function openTimelinePanel(slotId: string): void {
  panelSlot = slotId;
  panelListeners.forEach(listener => listener());
}
function closePanel(): void { panelSlot = null; panelListeners.forEach(listener => listener()); }
const subscribePanel = (listener: () => void) => { panelListeners.add(listener); return () => { panelListeners.delete(listener); }; };
export function useTimelineSnapshot() {
  return useSyncExternalStore(timelineCoordinator.subscribe, timelineCoordinator.getSnapshot);
}
/** Stable primitive snapshot: row rendering and source scroll never redraw a terminal shell. */
export function useTimelineMembership(slotId?: string): string | null {
  return useSyncExternalStore(timelineCoordinator.subscribe, () => slotId ? timelineCoordinator.groupForSlot(slotId)?.id ?? null : null);
}

function useGroupLabel(tabId: string): string {
  return useSyncExternalStore(timelineCoordinator.subscribe, () => {
    const groups = timelineCoordinator.getSnapshot().groups;
    const index = groups.findIndex(group => group.memberSlots.includes(tabId));
    return index >= 0 ? `G${index + 1}` : '';
  });
}

export const TimelineButton: React.FC<{ tabId: string }> = ({ tabId }) => {
  const { t } = useTranslation();
  const groupId = useTimelineMembership(tabId);
  const groupLabel = useGroupLabel(tabId);
  const groupColor = useSyncExternalStore(timelineCoordinator.subscribe, () => safeCssColor(timelineCoordinator.groupForSlot(tabId)?.color) ?? '');
  return <button type="button" className={`icon-btn timeline-entry${groupId ? ' active' : ''}`}
    style={{ color: groupColor || undefined }} aria-label={t('timeline.manage')} title={t('timeline.manage')} onClick={() => openTimelinePanel(tabId)}>
    <Link2 size={13} />{groupId && <span>{groupLabel}</span>}
  </button>;
};

export const TimelineBadge: React.FC<{ tabId: string }> = ({ tabId }) => {
  const groupId = useTimelineMembership(tabId);
  const groupLabel = useGroupLabel(tabId);
  const groupColor = useSyncExternalStore(timelineCoordinator.subscribe, () => safeCssColor(timelineCoordinator.groupForSlot(tabId)?.color) ?? '');
  if (!groupId) return null;
  return <span className="timeline-badge" style={{ color: groupColor || undefined }} title={groupId}><Link2 size={10} />{groupLabel}</span>;
};

function run(action: () => void): void { try { action(); } catch (error) { notifyError(error); } }

const TimelineGroupBar: React.FC<{ group: TimelineGroupSnapshot }> = ({ group }) => {
  const { t } = useTranslation();
  const tabs = useAppStore(state => state.tabs);
  const [target, setTarget] = useState('');
  const deferred = group.members.filter(member => member.preview === 'on-release').length;
  const eventAligned = group.mappings.some(mapping => mapping.groupTimeMs === 0 && mapping.sourceTimeMs !== 0);
  return <div className="timeline-group-controls">
    <span className="chip">{t(`timeline.mode.${group.mode}`)}</span>
    <output className="timeline-time" aria-live="off">{t(group.previewAnchor ? 'timeline.preview' : 'timeline.committed')} {clockLabel((group.previewAnchor ?? group.committedAnchor)?.timeMs, eventAligned)}</output>
    {group.previewAnchor && <span className="timeline-pending">{t('timeline.previewCounts', { count: group.members.length - deferred, deferred })}</span>}
    <button type="button" className="btn btn-sm" onClick={() => run(() => timelineCoordinator.setMode(group.id, 'live'))}>{t('timeline.returnLive')}</button>
    <button type="button" className="btn btn-sm" onClick={() => group.memberSlots[0] && openTimelinePanel(group.memberSlots[0])}>{t('timeline.members')}</button>
    <label>{t('timeline.dragPolicy')} <select className="select" value={group.dragSyncPolicy}
      onChange={event => run(() => timelineCoordinator.setDragSyncPolicy(group.id, event.target.value as DragSyncPolicy))}>
      {(['auto', 'continuous', 'on-release'] as const).map(policy => <option key={policy} value={policy}>{t(`timeline.policy.${policy}`)}</option>)}
    </select></label>
    <form className="timeline-time-form" onSubmit={event => { event.preventDefault(); if (target.trim() && Number.isFinite(Number(target))) run(() => timelineCoordinator.seek(group.id, Number(target))); }}>
      <input className="toolbar-input" type="number" step="1" value={target} placeholder={t('timeline.targetMs')} aria-label={t('timeline.targetMs')} onChange={event => setTarget(event.target.value)} />
      <button className="btn btn-sm" type="submit">{t('timeline.seek')}</button>
    </form>
    <details className="timeline-results"><summary>{t('timeline.results')}</summary><div>
      {group.members.map(member => <span key={member.slotId} className="timeline-result" title={member.reason}>
        {tabs.find(tab => tab.id === member.slotId)?.title ?? member.slotId} · {t(`timeline.status.${member.status ?? (member.state === 'active' ? 'loading' : 'unavailable')}`)}
        {member.pending || member.inFlight ? ` · ${t('timeline.pending')}` : ''}
        {member.actualTimeMs != null ? ` · ${clockLabel(member.actualTimeMs)} (${member.deltaMs ?? 0} ms)` : ''}
      </span>)}
    </div></details>
  </div>;
};

const TimelinePanel: React.FC<{ slotId: string }> = ({ slotId }) => {
  const { t } = useTranslation();
  const snapshot = useTimelineSnapshot();
  const tabs = useAppStore(state => state.tabs);
  const ports = useAppStore(state => state.ports);
  const group = snapshot.groups.find(item => item.memberSlots.includes(slotId));
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string[]>([slotId]);
  const [joinGroupId, setJoinGroupId] = useState(group?.id ?? snapshot.groups[0]?.id ?? '');
  const [error, setError] = useState('');
  const ready = usePluginViewOverlay();
  const sourceIds = group ? [...new Set([...group.mappings.map(mapping => mapping.sourceId),
    ...group.memberSlots.map(slot => timelineCoordinator.participantForSlot(slot)?.sourceId).filter((id): id is string => !!id)])] : [];
  const mappings = sourceIds.map(sourceId => group!.mappings.find(mapping => mapping.sourceId === sourceId)
    ?? { sourceId, sourceTimeMs: 0, groupTimeMs: 0 });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => { if (event.key === 'Escape') closePanel(); };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
  const action = (work: () => void) => { try { work(); setError(''); } catch (cause) { setError(String(cause)); } };
  const alignEvent = () => action(() => {
    if (!group) return;
    const sources = new Set<string>();
    for (const member of group.memberSlots) {
      const participant = timelineCoordinator.participantForSlot(member);
      const anchor = timelineCoordinator.readSlotAnchor(member);
      if (!participant || !anchor || sources.has(participant.sourceId)) continue;
      sources.add(participant.sourceId);
      timelineCoordinator.setMapping(group.id, { sourceId: participant.sourceId, sourceTimeMs: anchor.timeMs, groupTimeMs: 0, clockEpoch: participant.clockEpoch });
    }
    timelineCoordinator.seek(group.id, 0);
  });
  return <div className="modal-overlay timeline-modal-overlay" style={{ visibility: ready ? 'visible' : 'hidden' }} onMouseDown={event => { if (event.target === event.currentTarget) closePanel(); }}>
    <section className="modal timeline-panel" role="dialog" aria-modal="true" aria-label={t('timeline.manage')}>
      <header><h3><Link2 size={18} /> {t('timeline.manage')}</h3><button className="icon-btn" title={t('timeline.close')} onClick={closePanel}><X size={16} /></button></header>
      <p className="timeline-note">{t('timeline.clockNote')}</p>
      <div className="timeline-member-list">
        {tabs.map(tab => {
          const participant = timelineCoordinator.participantForSlot(tab.id);
          const memberGroup = snapshot.groups.find(item => item.memberSlots.includes(tab.id));
          const member = memberGroup?.members.find(item => item.slotId === tab.id);
          const portId = tab.kind === 'serial' ? tab.portId : tab.kind === 'plugin' ? tab.boundPortId : null;
          const port = ports.find(item => item.id === portId);
          return <div key={tab.id} className="timeline-member-row">
            <label><input type="checkbox" checked={selected.includes(tab.id)} onChange={event => setSelected(current => event.target.checked ? [...current, tab.id] : current.filter(id => id !== tab.id))} />
              <strong>{port?.alias ? `${port.alias} · ` : ''}{tab.title}</strong> <span>{portId ?? ''} · {t(tab.kind === 'replay' ? 'timeline.replaySource' : 'timeline.liveSource')}</span>
            </label>
            <span className="timeline-member-state">{memberGroup?.name ?? ''} {participant ? '' : t('timeline.unsupportedView')}</span>
            {memberGroup && <>
              <button className="btn btn-sm" onClick={() => action(() => timelineCoordinator.setDetached(tab.id, member?.state !== 'temporarilyDetached'))}>{t(member?.state === 'temporarilyDetached' ? 'timeline.rejoin' : 'timeline.detach')}</button>
              <button className="icon-btn" title={t('timeline.leave')} onClick={() => action(() => timelineCoordinator.removeMember(tab.id))}><Unlink size={13} /></button>
            </>}
          </div>;
        })}
      </div>
      <div className="timeline-create-row"><input className="toolbar-input" value={name} placeholder={t('timeline.groupName')} aria-label={t('timeline.groupName')} onChange={event => setName(event.target.value)} />
        <button className="btn btn-sm" disabled={!selected.length} onClick={() => action(() => {
          const origin = selected.includes(slotId) ? slotId : selected[0];
          const anchor = timelineCoordinator.readSlotAnchor(origin);
          const colors = ['#60a5fa', '#f59e0b', '#34d399', '#c084fc', '#fb7185'];
          const id = timelineCoordinator.createGroup({ name: name.trim() || `G${snapshot.groups.length + 1}`, color: colors[snapshot.groups.length % colors.length], memberSlots: selected, anchor: anchor ?? undefined, originSlotId: origin, referenceSourceId: timelineCoordinator.participantForSlot(origin)?.sourceId });
          setJoinGroupId(id);
        })}>{t('timeline.create')}</button>
      </div>
      <div className="timeline-create-row"><select className="select" value={joinGroupId} onChange={event => setJoinGroupId(event.target.value)} aria-label={t('timeline.join')}>
        <option value="">{t('timeline.selectGroup')}</option>{snapshot.groups.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select><button className="btn btn-sm" disabled={!joinGroupId || !selected.length} onClick={() => action(() => {
        for (const id of selected) timelineCoordinator.addMember(joinGroupId, id);
      })}>{t('timeline.join')}</button></div>
      {group && <>
        <h4>{group.name} · {t('timeline.calibration')}</h4>
        <p className="timeline-note">{t('timeline.offsetNote')}</p>
        <button className="btn btn-sm" onClick={alignEvent}>{t('timeline.alignEvents')}</button>
        {mappings.map(mapping => <label className="timeline-offset-row" key={mapping.sourceId}>
          <span>{mapping.sourceId}</span><input className="toolbar-input" type="number" step="1" defaultValue={mapping.groupTimeMs - mapping.sourceTimeMs}
            key={`${mapping.sourceId}:${group.mappingRevision}`} aria-label={`${t('timeline.offset')} ${mapping.sourceId}`}
            onBlur={event => { const value = Number(event.target.value); if (event.target.value.trim() && Number.isFinite(value)) action(() => timelineCoordinator.setMapping(group.id, { ...mapping, sourceTimeMs: 0, groupTimeMs: value, clockEpoch: group.memberSlots.map(slot => timelineCoordinator.participantForSlot(slot)).find(participant => participant?.sourceId === mapping.sourceId)?.clockEpoch })); }} /> ms
        </label>)}
        <button className="btn btn-sm" onClick={() => action(() => {
          const participant = timelineCoordinator.participantForSlot(slotId);
          const anchor = timelineCoordinator.readSlotAnchor(slotId);
          if (!participant || !anchor) return;
          const token = timelineCoordinator.beginNavigation(participant.participantId);
          if (token) timelineCoordinator.endNavigation(token, anchor);
        })}>{t('timeline.alignHere')}</button>
        <button className="btn btn-sm" onClick={() => action(() => timelineCoordinator.deleteGroup(group.id))}>{t('timeline.deleteGroup')}</button>
      </>}
      {error && <p role="alert" className="timeline-error">{error}</p>}
    </section>
  </div>;
};

export const TimelineWorkspace: React.FC = () => {
  const { t } = useTranslation();
  const snapshot = useTimelineSnapshot();
  const activeTabId = useAppStore(state => state.activeTabId);
  const [selected, setSelected] = useState('');
  const slot = useSyncExternalStore(subscribePanel, () => panelSlot);
  const focusGroup = snapshot.groups.find(group => group.memberSlots.includes(activeTabId ?? ''));
  useEffect(() => { if (focusGroup) setSelected(focusGroup.id); }, [focusGroup?.id]);
  const group = snapshot.groups.find(item => item.id === selected) ?? focusGroup ?? snapshot.groups[0];
  return <>
    {group && <aside className="timeline-workspace-bar" aria-label={t('timeline.manage')}>
      <label><Link2 size={14} /> {t('timeline.title')} <select className="select" aria-label={t('timeline.selectGroup')} value={group.id} onChange={event => setSelected(event.target.value)}>
        {snapshot.groups.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label><TimelineGroupBar group={group} />
    </aside>}
    {slot && <TimelinePanel key={slot} slotId={slot} />}
  </>;
};
