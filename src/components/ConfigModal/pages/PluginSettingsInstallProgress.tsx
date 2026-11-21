import React from 'react';
import { useTranslation } from 'react-i18next';
import type { PluginInstallCancelResult, PluginInstallProgress } from '../../../services/plugin';
import { useDialogLifecycle } from '../../shared/useDialogLifecycle';
import { usePluginViewOverlay } from '../../shared/usePluginViewOverlay';

export interface DirectoryInstallPanelState {
  requestId: string;
  progress: PluginInstallProgress | null;
  cancel: PluginInstallCancelResult | 'none' | 'pending' | 'failed';
}

export function canCancelDirectoryInstall(state: DirectoryInstallPanelState): boolean {
  return state.progress !== null && state.progress.phase !== 'committing' &&
    (state.cancel === 'none' || state.cancel === 'failed');
}

export function PluginSettingsInstallProgress({ state, onCancel }: {
  state: DirectoryInstallPanelState;
  onCancel: () => void;
}) {
  const { t, i18n } = useTranslation();
  const ready = usePluginViewOverlay();
  const dialogRef = React.useRef<HTMLDivElement>(null);
  const titleId = React.useId();
  const statusId = React.useId();
  const canCancel = canCancelDirectoryInstall(state);
  useDialogLifecycle({ open: ready, dialogRef, onClose: onCancel, disableEscape: !canCancel });
  if (!ready) return null;
  const phase = state.progress?.phase ?? 'waiting';
  const cancelling = state.cancel === 'pending' || state.cancel === 'accepted';
  const publishing = phase === 'committing' || state.cancel === 'tooLate';
  const status = t(publishing ? 'plugins.installProgress.committing'
    : cancelling ? 'plugins.installProgress.cancelling'
    : state.cancel === 'notFound' ? 'plugins.installProgress.finishing'
    : `plugins.installProgress.${phase}`);
  const bytes = (value: number): string => value.toLocaleString(i18n?.resolvedLanguage);
  const copying = state.progress?.phase === 'copying' ? state.progress : null;
  const detail = copying ? t('plugins.installProgress.amount', { copied: bytes(copying.copiedBytes), total: bytes(copying.totalBytes) }) : undefined;
  return <div className="modal-overlay" role="presentation" onClick={event => event.stopPropagation()}>
    <div ref={dialogRef} className="modal-dialog-compact plugin-permission-dialog" tabIndex={-1}
      role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={statusId}>
      <h3 id={titleId}>{t('plugins.installProgress.title')}</h3>
      <p id={statusId} role="status">{status}</p>
      {copying ? <>
        <progress aria-label={t('plugins.installProgress.copying')} aria-valuetext={detail}
          max={Math.max(1, copying.totalBytes)} value={copying.copiedBytes} />
        <p>{detail}</p>
        <p className="settings-hint">{t('plugins.installProgress.space', { available: bytes(copying.availableBytes) })}</p>
      </> : <progress aria-label={status} />}
      {state.cancel === 'failed' && !publishing && <p role="alert">{t('plugins.installProgress.cancelFailed')}</p>}
      <div className="plugin-permission-dialog-actions">
        <button className="btn" disabled={!canCancel} onClick={onCancel}>{t('plugins.trustedWebCancel')}</button>
      </div>
    </div>
  </div>;
}
