import React from 'react';
import { useTranslation } from 'react-i18next';
import type { PluginManifestView, PluginView } from '../../../types';
import {
  capabilityDelta, effectivePermissions, groupedPermissions, hasTrustedViews, httpUrlScope, initialReviewSelection,
  permissionDelta, reviewablePermissions, serialPortScope, type PermissionReviewIntent, type PluginPermissionDecision,
} from '../../../utils/pluginPermissionReview';
import { useDialogLifecycle } from '../../shared/useDialogLifecycle';
import { usePluginViewOverlay } from '../../shared/usePluginViewOverlay';

export interface PendingPermissionReview {
  plugin: PluginView;
  intent: PermissionReviewIntent;
  preview?: PluginManifestView;
}

function PermissionName({ permission }: { permission: string }) {
  const { t } = useTranslation();
  return <>{t(`plugins.review.permission.${permission}`, { defaultValue: t('plugins.review.unknownPermission') })}</>;
}

function Scope({ manifest, permissions }: { manifest: PluginManifestView; permissions: readonly string[] }) {
  const { t } = useTranslation();
  const serial = permissions.includes('serial:send') || permissions.includes('serial:control');
  const http = permissions.includes('http:request');
  const ports = serialPortScope(manifest);
  const urls = httpUrlScope(manifest);
  if (!serial && !http) return null;
  return <ul className="settings-hint">
    {serial && <li>{ports === null ? t('plugins.review.serialAny') : ports.length === 0 ? t('plugins.review.serialNone')
      : t('plugins.review.serialScope', { scope: ports.join(', ') })}</li>}
    {http && <li>{urls.length === 0 ? t('plugins.review.httpAny') : t('plugins.review.httpScope', { scope: urls.join(', ') })}</li>}
  </ul>;
}

function CapabilityList({ permissions }: { permissions: readonly string[] }) {
  return <>{permissions.map((permission, index) => <React.Fragment key={permission}>
    {index > 0 && ' · '}<PermissionName permission={permission} />
  </React.Fragment>)}</>;
}

function MarketplaceDifference({ diff, installed }: { diff: ReturnType<typeof capabilityDelta>; installed: PluginManifestView }) {
  const { t } = useTranslation();
  if (!diff.added.length && !diff.removed.length && !diff.serialScopeChanged && !diff.httpScopeChanged && !diff.trustChanged) return null;
  return <section aria-label={t('plugins.review.previewMismatch')}>
    <strong>{t('plugins.review.previewMismatch')}</strong>
    <ul className="settings-hint">
      {diff.added.length > 0 && <li>{t('plugins.review.previewAdded')}: <CapabilityList permissions={diff.added} /></li>}
      {diff.removed.length > 0 && <li>{t('plugins.review.previewRemoved')}: <CapabilityList permissions={diff.removed} /></li>}
      {diff.serialScopeChanged && <li>{t('plugins.review.previewSerial')}</li>}
      {diff.httpScopeChanged && <li>{t('plugins.review.previewHttp')}</li>}
      {diff.trustChanged && <li>{t(hasTrustedViews(installed) ? 'plugins.review.previewTrustAdded' : 'plugins.review.previewTrustRemoved')}</li>}
    </ul>
  </section>;
}

/** One review binds a proposed change to the package that was actually installed. */
export function PluginPermissionDialog({ review, working, onCancel, onApply }: {
  review: PendingPermissionReview;
  working: boolean;
  onCancel: () => void;
  onApply: (decision: PluginPermissionDecision) => void;
}) {
  const { t } = useTranslation();
  const { plugin, intent, preview } = review;
  const manifest = plugin.manifest;
  const [selected, setSelected] = React.useState(() => initialReviewSelection(plugin, intent === 'install'));
  const [trustWeb, setTrustWeb] = React.useState(false);
  const ready = usePluginViewOverlay();
  const ref = React.useRef<HTMLDivElement>(null);
  const cancelRef = React.useRef<HTMLButtonElement>(null);
  const titleId = React.useId();
  const descriptionId = React.useId();
  useDialogLifecycle({ open: ready, dialogRef: ref, initialFocusRef: cancelRef, onClose: onCancel, disableEscape: working });
  if (!ready || !manifest) return null;
  const editable = intent !== 'enable';
  const previous = effectivePermissions(plugin);
  const declared = reviewablePermissions(plugin);
  const displayed = editable ? declared : previous;
  const previewDiff = preview ? capabilityDelta(preview, manifest) : null;
  const technicalPermissions = [...new Set([...displayed, ...(previewDiff?.added ?? []), ...(previewDiff?.removed ?? [])])];
  const delta = permissionDelta(previous, selected);
  const needsTrust = hasTrustedViews(manifest) && plugin.trustedWebGranted !== true;
  const staysDisabled = intent !== 'manage' && needsTrust && !trustWeb;
  const noChange = intent === 'manage' && !trustWeb && !delta.added.length && !delta.removed.length;

  return <div className="modal-overlay" role="presentation" onClick={event => { event.stopPropagation(); if (!working) onCancel(); }}>
    <div ref={ref} tabIndex={-1} className="modal-dialog-compact plugin-permission-dialog animate-slide-up" role="dialog" aria-modal="true"
      aria-labelledby={titleId} aria-describedby={descriptionId} onClick={event => event.stopPropagation()}>
      <h3 id={titleId} className="modal-dialog-title">{t('plugins.review.title', { name: manifest.name })}</h3>
      <p><strong>{manifest.name}</strong> · {t('plugins.version', { version: manifest.version })} · {plugin.id}</p>
      <p id={descriptionId} className="settings-hint">{t(`plugins.review.intent.${intent}`)}</p>
      {previewDiff && <MarketplaceDifference diff={previewDiff} installed={manifest} />}
      {displayed.length === 0 && <p className="settings-hint">{t(editable ? 'plugins.noPermissions' : 'plugins.review.noGrants')}</p>}
      {groupedPermissions(displayed).map(({ group, permissions }) => <section key={group}>
        <strong>{t(`plugins.review.group.${group}`)}</strong>
        <div>
          {permissions.map(permission => editable ? <label key={permission} className="plugin-perm-item">
            <input type="checkbox" checked={selected.includes(permission)} disabled={working} onChange={event => {
              const checked = event.target.checked;
              setSelected(current => checked ? [...current, permission] : current.filter(candidate => candidate !== permission));
            }} />
            <PermissionName permission={permission} />
          </label> : <div key={permission} className="settings-hint"><PermissionName permission={permission} /></div>)}
        </div>
        <Scope manifest={manifest} permissions={permissions} />
      </section>)}
      {needsTrust && <section>
        <strong>{t('plugins.trustedWebTitle')}</strong>
        <p className="settings-hint">{t('plugins.trustedWebDescription')}</p>
        <ul className="settings-hint">
          <li>{t('plugins.trustedWebNetwork')}</li>
          <li>{t('plugins.trustedWebFiles')}</li>
          <li>{t('plugins.trustedWebClipboard')}</li>
          <li>{t('plugins.trustedWebStorage')}</li>
        </ul>
        <label className="plugin-perm-item">
          <input type="checkbox" checked={trustWeb} disabled={working} onChange={event => setTrustWeb(event.target.checked)} />
          {t('plugins.trustedWebAccept')}
        </label>
      </section>}
      {editable && <section className="settings-hint" aria-live="polite">
        {delta.added.length > 0 && <p>{t('plugins.review.willGrant')}: <CapabilityList permissions={delta.added} /></p>}
        {delta.removed.length > 0 && <p>{t('plugins.review.willRevoke')}: <CapabilityList permissions={delta.removed} /></p>}
        {trustWeb && <p>{t('plugins.review.willTrust')}</p>}
        {!delta.added.length && !delta.removed.length && !trustWeb && <p>{t('plugins.review.noChanges')}</p>}
      </section>}
      {staysDisabled && <p className="settings-hint">{t('plugins.review.trustRequired')}</p>}
      {(technicalPermissions.length > 0 || needsTrust || previewDiff?.trustChanged) && <details>
        <summary>{t('plugins.review.advanced')}</summary>
        <div className="plugin-permission-dialog-list">
          {technicalPermissions.map(permission => <code key={permission}>{permission}</code>)}
          {(needsTrust || previewDiff?.trustChanged) && <code>trusted-web</code>}
        </div>
      </details>}
      <div className="plugin-permission-dialog-actions">
        <button ref={cancelRef} className="btn" disabled={working} onClick={onCancel}>{t(intent === 'install' ? 'plugins.permissionPromptLater' : 'plugins.trustedWebCancel')}</button>
        <button className="btn btn-primary" disabled={working || staysDisabled || noChange}
          onClick={() => onApply({ plugin, intent, permissions: selected, trustWeb })}>{t(intent === 'manage' ? 'plugins.review.save' : 'plugins.review.applyAndEnable')}</button>
      </div>
    </div>
  </div>;
}
