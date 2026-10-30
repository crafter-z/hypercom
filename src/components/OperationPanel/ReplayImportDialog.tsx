import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReplayPickedSources } from '../../services/file';
import type { ReplaySessionDescription, ReplayTrackPlan } from '../../utils/replay/replayRuntime';
import { notifyError } from '../../stores/useToastStore';
import { usePluginViewOverlay } from '../shared/usePluginViewOverlay';

export interface ReplayImportDialogProps { picked: ReplayPickedSources; busy: boolean; onConfirm(plans: ReplayTrackPlan[]): Promise<void>; onCancel(): void; restoring?: ReplaySessionDescription }
/** Explicit track/shard order, format and legacy clock confirmation before parsing. */
export default function ReplayImportDialog({ picked, busy, onConfirm, onCancel, restoring }: ReplayImportDialogProps) {
  const { t } = useTranslation();
  const [offset, setOffset] = useState(-new Date().getTimezoneOffset());
  const [confirmed, setConfirmed] = useState(false);
  const [rows, setRows] = useState(() => picked.sources.map((source, i) => ({ sourceId: source.sourceId, track: i, order: i, format: 'text' as 'text' | 'hex' })));
  const overlayReady = usePluginViewOverlay(true);
  const confirm = async () => {
    const plans: ReplayTrackPlan[] = [];
    try {
    if (restoring) {
      for (const track of restoring.tracks) plans.push({ title: track.title, options: track.options, sourceIds: track.files.map(file => { const source = picked.sources.find(item => item.path === file.path && item.fingerprint === file.fingerprint); if (!source) throw new Error('Original replay source is missing or changed'); return source.sourceId; }) });
    } else for (const track of [...new Set(rows.map(row => row.track))]) {
      const members = rows.filter(row => row.track === track).sort((a, b) => a.order - b.order);
      if (members.some(member => member.format !== members[0].format)) { notifyError(t('replay.formatMismatch')); return; }
      plans.push({ title: picked.sources[track].name, options: { encoding: 'UTF-8', format: members[0].format, timezoneOffsetMinutes: offset }, sourceIds: members.map(row => row.sourceId) });
    }
    await onConfirm(plans); } catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) notifyError(error); }
  };
  if (!overlayReady) return null;
  return <div className="modal-overlay" role="presentation" onKeyDown={event => { if (event.key === 'Escape') onCancel(); }}>
    <div className="modal" role="dialog" aria-modal="true" aria-label={t('replay.import')} style={{ width: 760, maxWidth: '95vw', maxHeight: '85vh', overflow: 'auto', padding: 20 }}>
      <h3>{t('replay.import')}</h3>
      <p>{t('replay.budget')}</p><p>{t('replay.identityNotice')}</p>
      <table style={{ width: '100%' }}><thead><tr><th>{t('replay.file')}</th><th>{t('replay.track')}</th><th>{t('replay.order')}</th><th>{t('replay.format')}</th></tr></thead><tbody>
        {picked.sources.map((source, i) => <tr key={source.sourceId}><td title={source.path}>{source.name} ({Math.ceil(source.size / 1024)} KiB)</td><td><select disabled={busy || !!restoring} value={rows[i].track} onChange={event => setRows(previous => previous.map((row, index) => index === i ? { ...row, track: Number(event.target.value) } : row))}>
          {picked.sources.map((track, j) => <option key={track.sourceId} value={j}>{j + 1}: {track.name}</option>)}
        </select></td><td><input type="number" min={0} max={15} disabled={busy || !!restoring} value={rows[i].order} style={{ width: 50 }} onChange={event => setRows(previous => previous.map((row, index) => index === i ? { ...row, order: Number(event.target.value) } : row))} /></td><td><select disabled={busy || !!restoring} value={rows[i].format} onChange={event => setRows(previous => previous.map((row, index) => index === i ? { ...row, format: event.target.value as 'text' | 'hex' } : row))}><option value="text">UTF-8</option><option value="hex">HEX / UTF-8</option></select></td></tr>)}
      </tbody></table>
      {!restoring && <label>{t('replay.offset')} <input type="number" min={-840} max={840} step={1} value={offset} disabled={busy} onChange={event => setOffset(Number(event.target.value))} /></label>}
      <p><label><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} /> {t('replay.confirmImport')}</label></p>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><button className="btn" onClick={onCancel}>{t('replay.cancel')}</button><button className="btn btn-primary" disabled={busy || !confirmed || !Number.isInteger(offset) || Math.abs(offset) > 840} onClick={() => { void confirm(); }}>{busy ? t('replay.importing') : t('replay.import')}</button></div>
    </div>
  </div>;
}
