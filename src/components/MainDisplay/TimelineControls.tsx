import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Link2, Settings2, X } from 'lucide-react';
import { useAppStore } from '../../stores/useAppStore';
import { timelineCoordinator, type DragSyncPolicy } from '../../utils/timeline';
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
    <Link2 size={13} /><span aria-hidden="true">{groupLabel || '\u00a0'}</span>
  </button>;
};

export const TimelineBadge: React.FC<{ tabId: string }> = ({ tabId }) => {
  const { t } = useTranslation();
  const groupId = useTimelineMembership(tabId);
  const groupLabel = useGroupLabel(tabId);
  const groupColor = useSyncExternalStore(timelineCoordinator.subscribe, () => safeCssColor(timelineCoordinator.groupForSlot(tabId)?.color) ?? '');
  if (!groupId) return null;
  return <span className="timeline-badge" style={{ color: groupColor || undefined }} title={t('timeline.title')}><Link2 size={10} />{groupLabel}</span>;
};

const TimelinePanel: React.FC<{ slotId: string }> = ({ slotId }) => {
  const { t } = useTranslation();
  const snapshot = useTimelineSnapshot();
  const tabs = useAppStore(state => state.tabs);
  const ports = useAppStore(state => state.ports);
  const group = snapshot.groups.find(item => item.memberSlots.includes(slotId));
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string[]>(() => group ? [...group.memberSlots] : [slotId]);
  const originalSelection = useRef(selected);
  const [joinExisting, setJoinExisting] = useState(false);
  const [joinGroupId, setJoinGroupId] = useState(snapshot.groups[0]?.id ?? '');
  const [error, setError] = useState('');
  const dialogRef = useRef<HTMLElement>(null);
  const ready = usePluginViewOverlay();
  const sourceIds = group ? [...new Set([...group.mappings.map(mapping => mapping.sourceId),
    ...group.memberSlots.map(slot => timelineCoordinator.participantForSlot(slot)?.sourceId).filter((id): id is string => !!id)])] : [];
  const mappings = sourceIds.map(sourceId => group!.mappings.find(mapping => mapping.sourceId === sourceId)
    ?? { sourceId, sourceTimeMs: 0, groupTimeMs: 0 });
  const selectedSlots = selected.filter(id => tabs.some(tab => tab.id === id));

  useEffect(() => {
    if (!ready) return;
    const previousFocus = document.activeElement;
    dialogRef.current?.querySelector<HTMLElement>('[data-initial-focus]')?.focus();
    return () => { if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true }); };
  }, [ready]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        closePanel();
      } else if (event.key === 'Tab') {
        const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary') ?? [])
          .filter(element => element.getClientRects().length > 0);
        const first = controls[0], last = controls[controls.length - 1];
        if (!first) { event.preventDefault(); return; }
        if (!dialogRef.current?.contains(document.activeElement)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        } else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', listener, true);
    return () => window.removeEventListener('keydown', listener, true);
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
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedSlots.length) return;
    action(() => {
      if (group) {
        // Add first so removing the initiating tab cannot discard the target group.
        for (const id of selectedSlots) timelineCoordinator.addMember(group.id, id);
        for (const id of group.memberSlots) if (!selectedSlots.includes(id)) timelineCoordinator.removeMember(id);
      } else if (joinExisting) {
        if (!snapshot.groups.some(item => item.id === joinGroupId)) return;
        for (const id of selectedSlots) timelineCoordinator.addMember(joinGroupId, id);
      } else {
        const origin = selectedSlots.includes(slotId) ? slotId : selectedSlots[0];
        const anchor = timelineCoordinator.readSlotAnchor(origin);
        const colors = ['#60a5fa', '#f59e0b', '#34d399', '#c084fc', '#fb7185'];
        timelineCoordinator.createGroup({ name: name.trim() || `G${snapshot.groups.length + 1}`, color: colors[snapshot.groups.length % colors.length], memberSlots: selectedSlots, anchor: anchor ?? undefined, originSlotId: origin, referenceSourceId: timelineCoordinator.participantForSlot(origin)?.sourceId });
      }
      closePanel();
    });
  };
  const sourceLabel = (sourceId: string) => tabs.filter(tab => timelineCoordinator.participantForSlot(tab.id)?.sourceId === sourceId).map(tab => tab.title).join(' / ') || sourceId;

  return <div className="modal-overlay timeline-modal-overlay" style={{ visibility: ready ? 'visible' : 'hidden' }} onMouseDown={event => { if (event.target === event.currentTarget) closePanel(); }}>
    <section ref={dialogRef} className="timeline-panel" role="dialog" aria-modal="true" aria-labelledby="timeline-panel-title" aria-describedby="timeline-panel-description">
      <header className="timeline-panel-header">
        <div className="timeline-panel-heading"><span className="timeline-panel-icon"><Link2 size={19} /></span><div>
          <h2 id="timeline-panel-title">{t('timeline.title')}</h2>
          <p id="timeline-panel-description">{t('timeline.description')}</p>
        </div></div>
        <button type="button" className="icon-btn" data-initial-focus title={t('timeline.close')} aria-label={t('timeline.close')} onClick={closePanel}><X size={17} /></button>
      </header>
      <form className="timeline-panel-form" onSubmit={submit}>
        <div className="timeline-panel-body">
          {group ? <div className="timeline-current-group">
            <Link2 size={15} style={{ color: safeCssColor(group.color) ?? undefined }} /><strong>{group.name}</strong>
            <span>{t('timeline.memberCount', { count: group.memberSlots.length })}</span>
          </div> : <div className="timeline-setup">
            {snapshot.groups.length > 0 && <div className="segmented timeline-setup-mode" role="group" aria-label={t('timeline.selectGroup')}>
              <button type="button" className={`segmented-btn${!joinExisting ? ' active' : ''}`} aria-pressed={!joinExisting} onClick={() => setJoinExisting(false)}>{t('timeline.newGroup')}</button>
              <button type="button" className={`segmented-btn${joinExisting ? ' active' : ''}`} aria-pressed={joinExisting} onClick={() => setJoinExisting(true)}>{t('timeline.join')}</button>
            </div>}
            <label className="timeline-field"><span>{t(joinExisting ? 'timeline.selectGroup' : 'timeline.groupName')}</span>
              {joinExisting ? <select className="select" value={joinGroupId} onChange={event => setJoinGroupId(event.target.value)}>
                {snapshot.groups.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select> : <input className="toolbar-input" value={name} placeholder={`G${snapshot.groups.length + 1}`} onChange={event => setName(event.target.value)} />}
            </label>
          </div>}
          <section className="timeline-members-section" aria-labelledby="timeline-members-title">
            <div className="timeline-section-heading"><h3 id="timeline-members-title">{t('timeline.views')}</h3><span>{t('timeline.selectedCount', { count: selectedSlots.length })}</span></div>
            <div className="timeline-member-list">
              {tabs.map(tab => {
                const participant = timelineCoordinator.participantForSlot(tab.id);
                const memberGroup = snapshot.groups.find(item => item.memberSlots.includes(tab.id));
                const portId = tab.kind === 'serial' ? tab.portId : tab.kind === 'plugin' ? tab.boundPortId : null;
                const port = ports.find(item => item.id === portId);
                const checked = selectedSlots.includes(tab.id);
                const unavailable = !participant;
                return <label key={tab.id} className={`timeline-member-row${checked ? ' is-selected' : ''}${unavailable ? ' is-unavailable' : ''}`}>
                  <input type="checkbox" checked={checked} disabled={unavailable && !originalSelection.current.includes(tab.id)} onChange={event => setSelected(current => event.target.checked ? [...current, tab.id] : current.filter(id => id !== tab.id))} />
                  <span className="timeline-member-copy"><strong>{port?.alias ? `${port.alias} · ` : ''}{tab.title}</strong><span>{unavailable ? t('timeline.unsupportedView') : t(tab.kind === 'replay' ? 'timeline.replaySource' : 'timeline.liveSource')}</span></span>
                  {memberGroup && <span className="timeline-member-group" title={memberGroup.name}>{memberGroup.name}</span>}
                </label>;
              })}
            </div>
            <p className="timeline-note">{t('timeline.followHint')}</p>
          </section>
          {group && <details className="timeline-advanced">
            <summary><Settings2 size={14} /><span>{t('timeline.advanced')}</span><ChevronRight size={14} className="timeline-disclosure" /></summary>
            <div className="timeline-advanced-body">
              <label className="timeline-field timeline-policy-field"><span>{t('timeline.dragPolicy')}</span><select className="select" value={group.dragSyncPolicy}
                onChange={event => action(() => timelineCoordinator.setDragSyncPolicy(group.id, event.target.value as DragSyncPolicy))}>
                {(['auto', 'continuous', 'on-release'] as const).map(policy => <option key={policy} value={policy}>{t(`timeline.policy.${policy}`)}</option>)}
              </select></label>
              <section className="timeline-calibration"><h3>{t('timeline.calibration')}</h3><p className="timeline-note">{t('timeline.offsetNote')}</p>
                {mappings.map(mapping => <label className="timeline-offset-row" key={mapping.sourceId}>
                  <span title={mapping.sourceId}>{sourceLabel(mapping.sourceId)}</span><input className="toolbar-input" type="number" step="1" defaultValue={mapping.groupTimeMs - mapping.sourceTimeMs}
                    key={`${mapping.sourceId}:${mapping.sourceTimeMs}:${mapping.groupTimeMs}`} aria-label={`${t('timeline.offset')} ${sourceLabel(mapping.sourceId)}`}
                    onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }}
                    onBlur={event => {
                      const value = Number(event.target.value);
                      if (!event.target.value.trim() || !Number.isFinite(value)) {
                        event.currentTarget.value = String(mapping.groupTimeMs - mapping.sourceTimeMs);
                        return;
                      }
                      if (value === mapping.groupTimeMs - mapping.sourceTimeMs) return;
                      action(() => timelineCoordinator.setMapping(group.id, {
                        ...mapping, sourceTimeMs: 0, groupTimeMs: value,
                        clockEpoch: group.memberSlots.map(slot => timelineCoordinator.participantForSlot(slot)).find(participant => participant?.sourceId === mapping.sourceId)?.clockEpoch,
                      }));
                    }} /><span className="timeline-unit">ms</span>
                </label>)}
                <div className="timeline-calibration-actions"><button type="button" className="btn btn-sm" onClick={alignEvent}>{t('timeline.alignEvents')}</button>
                  <button type="button" className="btn btn-sm" onClick={() => action(() => {
                    const participant = timelineCoordinator.participantForSlot(slotId);
                    const anchor = timelineCoordinator.readSlotAnchor(slotId);
                    if (!participant || !anchor) return;
                    const token = timelineCoordinator.beginNavigation(participant.participantId);
                    if (token) timelineCoordinator.endNavigation(token, anchor);
                  })}>{t('timeline.alignHere')}</button></div>
              </section>
              <section className="timeline-diagnostics"><h3>{t('timeline.results')}</h3>
                {group.members.map(member => <div key={member.slotId} className="timeline-result" title={member.reason}>
                  <span>{tabs.find(tab => tab.id === member.slotId)?.title ?? member.slotId}</span><span>{t(`timeline.status.${member.status ?? (member.state === 'active' ? 'loading' : 'unavailable')}`)}{member.pending || member.inFlight ? ` · ${t('timeline.pending')}` : ''}</span>
                  <small>{member.actualTimeMs != null ? `${clockLabel(member.actualTimeMs)} (${member.deltaMs ?? 0} ms)` : '—'}</small>
                </div>)}
              </section>
              <p className="timeline-note">{t('timeline.clockNote')}</p>
              <button type="button" className="btn btn-sm timeline-delete" onClick={() => action(() => { timelineCoordinator.deleteGroup(group.id); closePanel(); })}>{t('timeline.deleteGroup')}</button>
            </div>
          </details>}
          {error && <p role="alert" className="timeline-error">{error}</p>}
        </div>
        <footer className="timeline-panel-footer">
          <span>{t('timeline.selectedCount', { count: selectedSlots.length })}</span>
          <button type="button" className="btn" onClick={closePanel}>{t('timeline.close')}</button>
          <button type="submit" className="btn btn-primary" disabled={!selectedSlots.length || (!group && joinExisting && !snapshot.groups.some(item => item.id === joinGroupId))}>{t(group ? 'timeline.saveMembers' : joinExisting ? 'timeline.join' : 'timeline.create')}</button>
        </footer>
      </form>
    </section>
  </div>;
};

/** Group controls live behind the existing chain entry, never in an extra workspace toolbar. */
export const TimelineWorkspace: React.FC = () => {
  const slot = useSyncExternalStore(subscribePanel, () => panelSlot);
  return slot ? <TimelinePanel key={slot} slotId={slot} /> : null;
};
