import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReplayPickedSources } from '../../services/file';
import type { ReplaySessionDescription, ReplayTrackPlan } from '../../utils/replay/replayRuntime';
import { notifyError } from '../../stores/useToastStore';
import { usePluginViewOverlay } from '../shared/usePluginViewOverlay';
import Modal from '../shared/Modal';
import '../../styles/replay-import.css';

const STANDARD_UTC_OFFSETS = [
  -720, -660, -600, -570, -540, -480, -420, -360, -300, -240, -210, -180, -120, -60,
  0, 60, 120, 180, 210, 240, 270, 300, 330, 345, 360, 390, 420, 480, 525, 540, 570,
  600, 630, 660, 720, 765, 780, 840,
];

export function formatUtcOffset(minutes: number): string {
  const sign = minutes >= 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `UTC${sign}${hh}:${mm}`;
}

export interface ReplayImportDialogProps { picked: ReplayPickedSources; busy: boolean; onConfirm(plans: ReplayTrackPlan[]): Promise<void>; onCancel(): void; restoring?: ReplaySessionDescription }
/** Explicit track/shard order, format and legacy clock confirmation before parsing. */
export default function ReplayImportDialog({ picked, busy, onConfirm, onCancel, restoring }: ReplayImportDialogProps) {
  const { t } = useTranslation();
  const localOffset = useMemo(() => -new Date().getTimezoneOffset(), []);
  const [offset, setOffset] = useState(localOffset);
  const [confirmed, setConfirmed] = useState(false);
  const [rows, setRows] = useState(() => picked.sources.map((source, i) => ({ sourceId: source.sourceId, track: i, order: i, format: 'text' as 'text' | 'hex' })));
  const overlayReady = usePluginViewOverlay(true);
  const isSingleFile = picked.sources.length === 1;
  const tzOptions = useMemo(() => {
    if (STANDARD_UTC_OFFSETS.includes(localOffset)) return STANDARD_UTC_OFFSETS;
    return [...STANDARD_UTC_OFFSETS, localOffset].sort((a, b) => a - b);
  }, [localOffset]);

  const confirm = async () => {
    const plans: ReplayTrackPlan[] = [];
    try {
      if (restoring) {
        for (const track of restoring.tracks) plans.push({ title: track.title, options: track.options, sourceIds: track.files.map(file => { const source = picked.sources.find(item => item.path === file.path && item.fingerprint === file.fingerprint); if (!source) throw new Error(t('replay.error.sourceMissing')); return source.sourceId; }) });
      } else for (const track of [...new Set(rows.map(row => row.track))]) {
        const members = rows.filter(row => row.track === track).sort((a, b) => a.order - b.order);
        if (members.some(member => member.format !== members[0].format)) { notifyError(t('replay.formatMismatch')); return; }
        plans.push({ title: picked.sources[track].name, options: { encoding: 'UTF-8', format: members[0].format, timezoneOffsetMinutes: offset }, sourceIds: members.map(row => row.sourceId) });
      }
      await onConfirm(plans);
    } catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) notifyError(error); }
  };
  if (!overlayReady) return null;
  const titleId = 'replay-import-title';
  const canSubmit = !busy && (isSingleFile || confirmed) && Number.isInteger(offset) && Math.abs(offset) <= 840;
  return <Modal
    open
    onClose={onCancel}
    labelledBy={titleId}
    disableEscape={busy}
    dialogClassName={`modal-dialog-compact replay-import-dialog${isSingleFile ? ' replay-import-single' : ''} animate-slide-up`}
    onOverlayClick={busy ? undefined : onCancel}
  >
      <div className="replay-import-header">
        <h3 className="modal-dialog-title replay-import-title" id={titleId}>{t('replay.import')}</h3>
        <p className="replay-import-note">{t('replay.budget')}</p>
        {!isSingleFile && <p className="replay-import-note">{t('replay.identityNotice')}</p>}
      </div>
      <div className="replay-import-scroll">
        <table className="replay-import-table">
          <colgroup>
            <col className="replay-import-col-file" />
            {!isSingleFile && <col className="replay-import-col-track" />}
            {!isSingleFile && <col className="replay-import-col-order" />}
            <col className="replay-import-col-format" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">{t('replay.file')}</th>
              {!isSingleFile && <th scope="col">{t('replay.track')}</th>}
              {!isSingleFile && <th scope="col">{t('replay.order')}</th>}
              <th scope="col">{t('replay.format')}</th>
            </tr>
          </thead>
          <tbody>
            {picked.sources.map((source, i) => <tr key={source.sourceId}>
              <td title={source.path}>
                <div className="replay-import-file" title={source.path}>{source.name}</div>
                <div className="replay-import-file-meta">{Math.ceil(source.size / 1024)} KiB</div>
              </td>
              {!isSingleFile && (
                <td><select className="select" aria-label={t('replay.track')} disabled={busy || !!restoring} value={rows[i].track} onChange={event => setRows(previous => previous.map((row, index) => index === i ? { ...row, track: Number(event.target.value) } : row))}>
                  {picked.sources.map((track, j) => <option key={track.sourceId} value={j}>{j + 1}: {track.name}</option>)}
                </select></td>
              )}
              {!isSingleFile && (
                <td><input className="input replay-import-order" type="number" aria-label={t('replay.order')} min={0} max={15} disabled={busy || !!restoring} value={rows[i].order} onChange={event => setRows(previous => previous.map((row, index) => index === i ? { ...row, order: Number(event.target.value) } : row))} /></td>
              )}
              <td><select className="select" aria-label={t('replay.format')} disabled={busy || !!restoring} value={rows[i].format} onChange={event => setRows(previous => previous.map((row, index) => index === i ? { ...row, format: event.target.value as 'text' | 'hex' } : row))}><option value="text">UTF-8</option><option value="hex">HEX / UTF-8</option></select></td>
            </tr>)}
          </tbody>
        </table>
        {!restoring && (
          <label className="replay-import-offset">
            <span>{t('replay.offset')}</span>
            <select
              className="select replay-import-tz-select"
              aria-label={t('replay.offset')}
              value={offset}
              disabled={busy}
              onChange={event => setOffset(Number(event.target.value))}
            >
              {tzOptions.map(minutes => (
                <option key={minutes} value={minutes}>
                  {formatUtcOffset(minutes)}{minutes === localOffset ? ` (${t('replay.localTimezone')})` : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        {!isSingleFile && (
          <label className="checkbox-wrapper replay-import-confirm">
            <input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />
            <span>{t('replay.confirmImport')}</span>
          </label>
        )}
      </div>
      <div className="replay-import-actions">
        <button type="button" className="btn" onClick={onCancel}>{t('replay.cancel')}</button>
        <button type="button" className="btn btn-primary" disabled={!canSubmit} onClick={() => { void confirm(); }}>{busy ? t('replay.importing') : t('replay.import')}</button>
      </div>
  </Modal>;
}
