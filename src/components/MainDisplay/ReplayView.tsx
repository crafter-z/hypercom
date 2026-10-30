import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReplayTabItem, TerminalState } from '../../types';
import { TerminalViewportManager } from '../../utils/terminal/viewportManager';
import type { TerminalSource } from '../../utils/terminal/TerminalSource';
import { getReplaySession, getReplayRevision, subscribeReplay, replaySourceId, getReplayTransport, getReplayTimeRange, getReplayDisplayTime, toggleReplayTransport, seekReplayTransport, pauseReplayAtGroup, selectReplaySegment } from '../../utils/replay/replayRuntime';
import { timelineCoordinator } from '../../utils/timeline/coordinator';
import { formatTimelineTime } from '../../utils/timeFormat';
import { notifyError } from '../../stores/useToastStore';
import TerminalView from './TerminalView';
import { useLogReplay } from './hooks/useLogReplay';
import ReplayImportDialog from '../OperationPanel/ReplayImportDialog';

const pendingDisposals = new WeakMap<TerminalViewportManager, ReturnType<typeof setTimeout>>();
export interface ReplayViewProps { tab: ReplayTabItem; hidden?: boolean }
/** A shell over the shared TRX terminal, never a second renderer or a fake port. */
export default function ReplayView({ tab, hidden }: ReplayViewProps) {
  const { t } = useTranslation();
  useSyncExternalStore(subscribeReplay, getReplayRevision);
  useSyncExternalStore(timelineCoordinator.subscribe, timelineCoordinator.getSnapshot);
  const session = getReplaySession(tab.sessionId), track = session?.tracks.get(tab.trackId);
  const replayImport = useLogReplay(session?.description);
  const segmentIndex = track?.description.selectedSegment ?? -1;
  const [config, setConfig] = useState<TerminalState>({ scrollLocked: false, showTimestamp: true, displayFormat: 'string', encoding: 'UTF-8', connectedAt: null });
  const source = useMemo<TerminalSource | undefined>(() => {
    if (!track) return undefined;
    const document = track.document;
    if (document.segments.length <= 1) return document;
    const segment = document.segments[segmentIndex];
    const firstSeq = segment?.firstSeq ?? document.firstSeq, lastSeq = segment?.lastSeq ?? document.lastSeq;
    return { length: Math.max(0, lastSeq - firstSeq + 1), firstSeq, lastSeq, version: segmentIndex + 2,
      getBySeq: seq => seq >= firstSeq && seq <= lastSeq ? document.getBySeq(seq) : null,
      snapshot: (from = firstSeq, to = lastSeq) => document.snapshot(Math.max(firstSeq, from), Math.min(lastSeq, to)),
      getTimeMs: seq => document.getTimeMs(seq) };
  }, [track, segmentIndex]);
  const sourceId = replaySourceId(tab.sessionId, tab.trackId) + (segmentIndex >= 0 ? `:segment-${segmentIndex}` : '');
  const manager = useMemo(() => source ? new TerminalViewportManager(sourceId, { maxLines: 1 }, { source, display: { encoding: 'UTF-8', displayFormat: track?.description.options.format === 'hex' ? 'hex' : 'string' } }) : undefined, [source, sourceId, track]);
  useEffect(() => {
    if (!manager) return;
    clearTimeout(pendingDisposals.get(manager)); pendingDisposals.delete(manager);
    return () => { pendingDisposals.set(manager, setTimeout(() => { pendingDisposals.delete(manager); manager.dispose(); }, 0)); };
  }, [manager]);
  useEffect(() => { setConfig(previous => ({ ...previous, displayFormat: track?.description.options.format === 'hex' ? 'hex' : 'string' })); }, [track]);
  const clock = getReplayTransport(tab.id), snapshot = clock?.getSnapshot();
  // Union range is computed from documents and explicit mappings, independent
  // of a currently mounted participant or viewport geometry.
  const range = getReplayTimeRange(tab.id);
  const displayTime = getReplayDisplayTime(tab.id);
  const group = timelineCoordinator.groupForSlot(tab.id);
  const eventAligned = group?.mappings.some(mapping => mapping.groupTimeMs === 0 && mapping.sourceTimeMs !== 0) ?? false;
  const canPlay = !!clock && !!range && !!track?.document.knownTimeCount;
  if (!session || !track || !manager) return <div style={{ display: hidden ? 'none' : 'flex', flexDirection: 'column', minHeight: 0, padding: 20 }}>
    <p>{t('replay.missing')}</p><button className="btn" disabled={!session || replayImport.isPicking} onClick={() => { void replayImport.startImport().catch(notifyError); }}>{t('replay.import')}</button>
    {replayImport.picked && <ReplayImportDialog picked={replayImport.picked} busy={replayImport.isImporting} onConfirm={replayImport.confirmImport} onCancel={replayImport.cancelImport} restoring={session?.description} />}
  </div>;
  return <div style={{ display: hidden ? 'none' : 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
    <div className="terminal-filter-bar" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <span>{t('replay.readOnly')}</span><span title={t('replay.coverage')}>{track.document.length} / {track.document.length - track.document.knownTimeCount} / {track.document.segments.length}</span>
      <button className="btn btn-sm" disabled={!canPlay} onClick={() => { try { toggleReplayTransport(tab.id); } catch (error) { notifyError(error); } }}>{snapshot?.playing ? t('replay.pause') : t('replay.play')}</button>
      <select aria-label={t('terminal.replay.speedTooltip')} value={snapshot?.speed ?? 1} disabled={!canPlay} onChange={event => clock?.setSpeed(Number(event.target.value))}>{[0.25, 0.5, 1, 2, 4, 16].map(speed => <option value={speed} key={speed}>{speed}×</option>)}</select>
      <button className="btn btn-sm" disabled={!canPlay} onClick={() => range && seekReplayTransport(tab.id, range.start)}>{t('replay.start')}</button>
      <input type="range" aria-label={t('replay.track')} min={range?.start ?? 0} max={range?.end ?? 0} value={displayTime ?? range?.start ?? 0} step={1} disabled={!canPlay} onChange={event => seekReplayTransport(tab.id, Number(event.target.value))} />
      <button className="btn btn-sm" disabled={!canPlay} onClick={() => range && seekReplayTransport(tab.id, range.end)}>{t('replay.end')}</button>
      <output data-testid="replay-time">{track.document.knownTimeCount ? formatTimelineTime(displayTime, eventAligned) : '—'}</output>
      {!track.document.knownTimeCount && <span>{t('replay.noTime')}</span>}
      {track.document.segments.length > 1 && <label>{t('replay.segments')} <select aria-label={t('replay.segment')} value={segmentIndex} onChange={event => { pauseReplayAtGroup(session, tab.id); const value = Number(event.target.value); selectReplaySegment(tab.sessionId, tab.trackId, value < 0 ? undefined : value); }}><option value={-1}>—</option>{track.document.segments.map((segment, i) => <option key={segment.id} value={i}>{i + 1}: {segment.startTimeMs === null ? '—' : new Date(segment.startTimeMs).toISOString()} — {segment.endTimeMs === null ? '—' : new Date(segment.endTimeMs).toISOString()}</option>)}</select></label>}
    </div>
    <TerminalView tabId={tab.id} sourceId={sourceId} timelineEnabled={track.document.knownTimeCount > 0 && (track.document.segments.length <= 1 || segmentIndex >= 0)} timelineClockId={`replay:${tab.sessionId}${segmentIndex >= 0 ? `:segment-${segmentIndex}` : ''}`} manager={manager} terminalConfig={config} onTerminalConfigChange={patch => setConfig(previous => ({ ...previous, ...patch }))} onUserNavigation={() => pauseReplayAtGroup(session, tab.id)} hidden={hidden} />
  </div>;
}
