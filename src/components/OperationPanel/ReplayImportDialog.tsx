import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReplayPickedSources } from '../../services/file';
import type { ReplaySessionDescription, ReplayTrackPlan } from '../../utils/replay/replayRuntime';
import { notifyError } from '../../stores/useToastStore';
import { usePluginViewOverlay } from '../shared/usePluginViewOverlay';
import Modal from '../shared/Modal';
import '../../styles/replay-import.css';

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
  const titleId = 'replay-import-title';
  return <Modal
    open
    onClose={onCancel}
    labelledBy={titleId}
    disableEscape={busy}
    dialogClassName="modal-dialog-compact replay-import-dialog animate-slide-up"
    onOverlayClick={busy ? undefined : onCancel}
  >
      <div className="replay-import-header">
        <h3 className="modal-dialog-title replay-import-title" id={titleId}>{t('replay.import')}</h3>
        <p className="replay-import-note">{t('replay.budget')}</p>
        <p className="replay-import-note">{t('replay.identityNotice')}</p>
      </div>
      <div className="replay-import-scroll">
        <table className="replay-import-table">
          <colgroup>
            <col className="replay-import-col-file" />
            <col className="replay-import-col-track" />
            <col className="replay-import-col-order" />
            <col className="replay-import-col-format" />
          </colgroup>
          <thead><tr><th scope="col">{t('replay.file')}</th><th scope="col">{t('replay.track')}</th><th scope="col">{t('replay.order')}</th><th scope="col">{t('replay.format')}</th></tr></thead>
          <tbody>
            {picked.sources.map((source, i) => <tr key={source.sourceId}>
              <td title={source.path}>
                <div className="replay-import-file" title={source.path}>{source.name}</div>
                <div className="replay-import-file-meta">{Math.ceil(source.size / 1024)} KiB</div>
              </td>
              <td><select className="select" aria-label={t('replay.track')} disabled={busy || !!restoring} value={rows[i].track} onChange={event => setRows(previous => previous.map((row, index) => index === i ? { ...row, track: Number(event.target.value) } : row))}>
                {picked.sources.map((track, j) => <option key={track.sourceId} value={j}>{j + 1}: {track.name}</option>)}
              </select></td>
              <td><input className="input replay-import-order" type="number" aria-label={t('replay.order')} min={0} max={15} disabled={busy || !!restoring} value={rows[i].order} onChange={event => setRows(previous => previous.map((row, index) => index === i ? { ...row, order: Number(event.target.value) } : row))} /></td>
              <td><select className="select" aria-label={t('replay.format')} disabled={busy || !!restoring} value={rows[i].format} onChange={event => setRows(previous => previous.map((row, index) => index === i ? { ...row, format: event.target.value as 'text' | 'hex' } : row))}><option value="text">UTF-8</option><option value="hex">HEX / UTF-8</option></select></td>
            </tr>)}
          </tbody>
        </table>
        {!restoring && <label className="replay-import-offset">{t('replay.offset')}
          <input className="input" type="number" min={-840} max={840} step={1} value={offset} disabled={busy} onChange={event => setOffset(Number(event.target.value))} />
        </label>}
        <label className="checkbox-wrapper replay-import-confirm">
          <input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />
          <span>{t('replay.confirmImport')}</span>
        </label>
      </div>
      <div className="replay-import-actions">
        <button type="button" className="btn" onClick={onCancel}>{t('replay.cancel')}</button>
        <button type="button" className="btn btn-primary" disabled={busy || !confirmed || !Number.isInteger(offset) || Math.abs(offset) > 840} onClick={() => { void confirm(); }}>{busy ? t('replay.importing') : t('replay.import')}</button>
      </div>
  </Modal>;
}
