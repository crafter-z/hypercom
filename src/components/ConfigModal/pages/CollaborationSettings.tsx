import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Check, Copy, Globe, KeyRound, Lock, Play, PlugZap, Radio, RefreshCw,
  RotateCcw, ShieldAlert, Square, Trash2, Unplug,
} from 'lucide-react';
import { useAppStore } from '../../../stores/useAppStore';
import {
  controlService,
  eventService,
  type CollaborationStatusDto,
  type InvitePreviewDto,
  type RemoteClientDto,
  type RemoteInviteDto,
  type RemoteProfileSummaryDto,
} from '../../../services/tauri';
import type { RemoteRole } from '../../../types';
import { isRemotePort } from '../../../utils/portCapabilities';
import { writeClipboardText } from '../../../utils/clipboard';
import { notifyError, notifySuccess } from '../../../stores/useToastStore';
import { SegmentedControl } from '../../shared/SegmentedControl';
import ConfirmDialog from '../../shared/ConfirmDialog';

const MCP_SNIPPET = JSON.stringify(
  {
    mcpServers: {
      hypercom: {
        command: 'hypercomctl',
        args: ['mcp'],
      },
    },
  },
  null,
  2,
);

const CLI_LOAN_SNIPPET = 'hypercomctl loan COM9 --reason "flash" -- esptool.py --port {port} write_flash 0x0 firmware.bin';

function formatExpiry(expiresAtMs: number | undefined, neverLabel: string, expiredLabel: string): string {
  if (!expiresAtMs) return neverLabel;
  const remainingSec = Math.round((expiresAtMs - Date.now()) / 1000);
  if (remainingSec <= 0) return expiredLabel;
  if (remainingSec < 60) return `${remainingSec}s`;
  const mins = Math.floor(remainingSec / 60);
  const secs = remainingSec % 60;
  return `${mins}m ${secs}s`;
}

function suggestProfileId(preview: InvitePreviewDto): string {
  const base = (preview.label || preview.serverId || 'remote-host')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return base || 'remote-host';
}

const CollaborationSettings: React.FC = () => {
  const { t } = useTranslation();
  const ports = useAppStore((s) => s.ports);
  const localPorts = useMemo(() => ports.filter((p) => !isRemotePort(p)), [ports]);

  const [status, setStatus] = useState<CollaborationStatusDto | null>(null);
  const [clients, setClients] = useState<RemoteClientDto[]>([]);
  const [profiles, setProfiles] = useState<RemoteProfileSummaryDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Card 1: leases
  const [reclaimingPort, setReclaimingPort] = useState<string | null>(null);

  // Card 2: remote host server + invite generator
  const [listenAddr, setListenAddr] = useState('127.0.0.1:7372');
  const [advertiseAddr, setAdvertiseAddr] = useState('');
  const [hostActionBusy, setHostActionBusy] = useState(false);
  const [inviteLabel, setInviteLabel] = useState('');
  const [invitePorts, setInvitePorts] = useState<string[]>([]);
  const [inviteRole, setInviteRole] = useState<RemoteRole>('observe');
  const [inviteAllowLoan, setInviteAllowLoan] = useState(false);
  const [inviteTtlSecs, setInviteTtlSecs] = useState(300);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [generatedInvite, setGeneratedInvite] = useState<RemoteInviteDto | null>(null);
  const [confirmRevokeClient, setConfirmRevokeClient] = useState<RemoteClientDto | null>(null);

  // Card 3: pair remote host + saved profiles
  const [inviteInput, setInviteInput] = useState('');
  const [preview, setPreview] = useState<InvitePreviewDto | null>(null);
  const [inspectBusy, setInspectBusy] = useState(false);
  const [profileId, setProfileId] = useState('');
  const [labelOverride, setLabelOverride] = useState('');
  const [pairBusy, setPairBusy] = useState(false);
  const [profileBusyId, setProfileBusyId] = useState<string | null>(null);
  const [confirmRemoveProfile, setConfirmRemoveProfile] = useState<RemoteProfileSummaryDto | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [collab, remoteClients, remoteProfiles] = await Promise.all([
        controlService.getCollaborationStatus(),
        controlService.remoteHostListClients().catch(() => [] as RemoteClientDto[]),
        controlService.remoteClientListProfiles().catch(() => [] as RemoteProfileSummaryDto[]),
      ]);
      setStatus(collab);
      setClients(remoteClients);
      setProfiles(remoteProfiles);
    } catch (err) {
      notifyError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadAll();
    let unlistenHosts: (() => void) | undefined;
    let unlistenLoan: (() => void) | undefined;
    if (typeof eventService?.onRemoteHostsChanged === 'function') {
      void eventService.onRemoteHostsChanged(() => {
        if (!cancelled) void loadAll();
      }).then((fn) => {
        if (cancelled) fn();
        else unlistenHosts = fn;
      }).catch(() => {});
    }
    if (typeof eventService?.onSerialToolLoan === 'function') {
      void eventService.onSerialToolLoan(() => {
        if (!cancelled) void loadAll();
      }).then((fn) => {
        if (cancelled) fn();
        else unlistenLoan = fn;
      }).catch(() => {});
    }
    return () => {
      cancelled = true;
      unlistenHosts?.();
      unlistenLoan?.();
    };
  }, [loadAll]);

  const copyText = async (key: string, text: string) => {
    try {
      await writeClipboardText(text);
      setCopiedKey(key);
      setTimeout(() => {
        setCopiedKey((cur) => (cur === key ? null : cur));
      }, 1500);
    } catch (err) {
      notifyError(err);
    }
  };

  const handleReclaimLease = async (portId: string) => {
    setReclaimingPort(portId);
    try {
      const res = await controlService.reclaimPortLoan(portId);
      if (res.error) notifyError(res.error);
      else notifySuccess('collaboration.loan.reclaimed');
      await loadAll();
    } catch (err) {
      notifyError(err);
    } finally {
      setReclaimingPort((cur) => (cur === portId ? null : cur));
    }
  };

  const handleToggleHost = async () => {
    if (hostActionBusy) return;
    setHostActionBusy(true);
    try {
      if (status?.remote.enabled) {
        await controlService.remoteHostStop();
        notifySuccess('collaboration.host.stoppedToast');
      } else {
        await controlService.remoteHostStart({
          listen: listenAddr.trim() || '127.0.0.1:7372',
          advertise: advertiseAddr.trim() || undefined,
        });
        notifySuccess('collaboration.host.startedToast');
      }
      await loadAll();
    } catch (err) {
      notifyError(err);
    } finally {
      setHostActionBusy(false);
    }
  };

  const toggleInvitePort = (portId: string) => {
    setInvitePorts((prev) =>
      prev.includes(portId) ? prev.filter((p) => p !== portId) : [...prev, portId],
    );
  };

  const handleGenerateInvite = async () => {
    if (inviteBusy) return;
    setInviteBusy(true);
    try {
      const invite = await controlService.remoteHostCreateInvite({
        label: inviteLabel.trim() || 'remote-client',
        ports: invitePorts,
        role: inviteRole,
        allowLoan: inviteRole === 'control' && inviteAllowLoan,
        ttlSecs: inviteTtlSecs,
      });
      setGeneratedInvite(invite);
      notifySuccess('collaboration.invite.generatedToast');
    } catch (err) {
      notifyError(err);
    } finally {
      setInviteBusy(false);
    }
  };

  const handleRevokeClient = async () => {
    const target = confirmRevokeClient;
    setConfirmRevokeClient(null);
    if (!target) return;
    try {
      await controlService.remoteHostRevokeClient(target.clientId);
      notifySuccess('collaboration.clients.revokedToast');
      await loadAll();
    } catch (err) {
      notifyError(err);
    }
  };

  const handleInspectInvite = async () => {
    if (!inviteInput.trim() || inspectBusy) return;
    setInspectBusy(true);
    try {
      const inspected = await controlService.remoteClientInspectInvite(inviteInput.trim());
      setPreview(inspected);
      if (!profileId.trim()) {
        setProfileId(suggestProfileId(inspected));
      }
      if (!labelOverride.trim() && inspected.label) {
        setLabelOverride(inspected.label);
      }
    } catch (err) {
      setPreview(null);
      notifyError(err);
    } finally {
      setInspectBusy(false);
    }
  };

  const handlePairAndConnect = async () => {
    if (!inviteInput.trim() || !profileId.trim() || pairBusy) return;
    setPairBusy(true);
    try {
      const summary = await controlService.remoteClientPair({
        profileId: profileId.trim(),
        labelOverride: labelOverride.trim() || undefined,
        inviteJson: inviteInput.trim(),
      });
      await controlService.remoteClientConnect(summary.id);
      notifySuccess('collaboration.client.pairedToast');
      setInviteInput('');
      setPreview(null);
      setProfileId('');
      setLabelOverride('');
      await loadAll();
    } catch (err) {
      notifyError(err);
      await loadAll();
    } finally {
      setPairBusy(false);
    }
  };

  const handleProfileConnectToggle = async (profile: RemoteProfileSummaryDto) => {
    if (profileBusyId === profile.id) return;
    setProfileBusyId(profile.id);
    try {
      if (profile.status === 'connected' || profile.status === 'connecting') {
        await controlService.remoteClientDisconnect(profile.id);
      } else {
        await controlService.remoteClientConnect(profile.id);
      }
      await loadAll();
    } catch (err) {
      notifyError(err);
      await loadAll();
    } finally {
      setProfileBusyId((cur) => (cur === profile.id ? null : cur));
    }
  };

  const handleRemoveProfile = async () => {
    const target = confirmRemoveProfile;
    setConfirmRemoveProfile(null);
    if (!target) return;
    setProfileBusyId(target.id);
    try {
      await controlService.remoteClientRemoveProfile(target.id);
      notifySuccess('collaboration.client.removedToast');
      await loadAll();
    } catch (err) {
      notifyError(err);
    } finally {
      setProfileBusyId((cur) => (cur === target.id ? null : cur));
    }
  };

  const roleOptions: Array<{ value: RemoteRole; label: string }> = [
    { value: 'observe', label: t('collaboration.role.observe') },
    { value: 'write', label: t('collaboration.role.write') },
    { value: 'control', label: t('collaboration.role.control') },
  ];

  const inviteJsonText = generatedInvite ? JSON.stringify(generatedInvite, null, 2) : '';

  return (
    <div className="config-page collaboration-settings">
      <div className="config-page-top-bar">
        <p className="config-page-summary">{t('collaboration.summary')}</p>
        <button
          type="button"
          className="btn btn-sm"
          disabled={loading}
          onClick={() => { void loadAll(); }}
        >
          <RefreshCw size={13} className={loading ? 'spin-icon' : undefined} aria-hidden="true" />
          {t('collaboration.refresh')}
        </button>
      </div>

      {/* Card 1: Local CLI & Agent Collaboration */}
      <section className="collab-card">
        <div className="collab-card-header">
          <div className="collab-card-title-row">
            <Radio size={15} className="collab-card-icon" aria-hidden="true" />
            <h3>{t('collaboration.local.title')}</h3>
          </div>
          <span className={`collab-status-pill ${status?.localRunning ? 'is-live' : 'is-off'}`}>
            {status?.localRunning ? t('collaboration.status.running') : t('collaboration.status.stopped')}
          </span>
        </div>

        <div className="collab-meta-grid">
          <div className="collab-meta-item">
            <span className="collab-meta-label">{t('collaboration.local.endpoint')}</span>
            <code className="collab-code">{status?.localEndpoint || '—'}</code>
          </div>
          <div className="collab-meta-item">
            <span className="collab-meta-label">{t('collaboration.local.clients')}</span>
            <span className="collab-meta-value">{status?.localClients ?? 0}</span>
          </div>
        </div>

        <div className="collab-subblock">
          <div className="collab-subblock-header">
            <span className="collab-subblock-title">
              <Lock size={13} aria-hidden="true" />
              {t('collaboration.leases.title')}
            </span>
          </div>
          {status && status.activeLoans.length > 0 ? (
            <div className="collab-table-wrap">
              <table className="collab-table">
                <thead>
                  <tr>
                    <th>{t('collaboration.leases.port')}</th>
                    <th>{t('collaboration.leases.holder')}</th>
                    <th>{t('collaboration.leases.reason')}</th>
                    <th>{t('collaboration.leases.expires')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {status.activeLoans.map((loan) => (
                    <tr key={loan.leaseId}>
                      <td><code>{loan.portId}</code></td>
                      <td>{loan.holder}</td>
                      <td>{loan.reason || '—'}</td>
                      <td>{formatExpiry(loan.expiresAtMs, t('collaboration.leases.never'), t('collaboration.leases.expired'))}</td>
                      <td className="collab-table-action">
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          disabled={reclaimingPort === loan.portId}
                          onClick={() => { void handleReclaimLease(loan.portId); }}
                        >
                          <RotateCcw size={12} aria-hidden="true" />
                          {t('collaboration.leases.reclaim')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="collab-empty-hint">{t('collaboration.leases.empty')}</p>
          )}
        </div>

        <details className="collab-details">
          <summary className="collab-details-summary">{t('collaboration.snippets.title')}</summary>
          <div className="collab-snippets">
            <div className="collab-snippet-block">
              <div className="collab-snippet-header">
                <span>{t('collaboration.snippets.mcpTitle')}</span>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => { void copyText('mcp', MCP_SNIPPET); }}
                >
                  {copiedKey === 'mcp' ? <Check size={12} /> : <Copy size={12} />}
                  {copiedKey === 'mcp' ? t('collaboration.copied') : t('collaboration.copy')}
                </button>
              </div>
              <pre className="collab-pre">{MCP_SNIPPET}</pre>
            </div>
            <div className="collab-snippet-block">
              <div className="collab-snippet-header">
                <span>{t('collaboration.snippets.cliTitle')}</span>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => { void copyText('cli', CLI_LOAN_SNIPPET); }}
                >
                  {copiedKey === 'cli' ? <Check size={12} /> : <Copy size={12} />}
                  {copiedKey === 'cli' ? t('collaboration.copied') : t('collaboration.copy')}
                </button>
              </div>
              <pre className="collab-pre">{CLI_LOAN_SNIPPET}</pre>
            </div>
          </div>
        </details>
      </section>

      {/* Card 2: Remote Host Server (Lab side) */}
      <section className="collab-card">
        <div className="collab-card-header">
          <div className="collab-card-title-row">
            <KeyRound size={15} className="collab-card-icon" aria-hidden="true" />
            <h3>{t('collaboration.host.title')}</h3>
          </div>
          <span className={`collab-status-pill ${status?.remote.enabled ? 'is-live' : 'is-off'}`}>
            {status?.remote.enabled ? t('collaboration.status.running') : t('collaboration.status.stopped')}
          </span>
        </div>

        <div className="collab-form-grid">
          <label className="collab-field">
            <span>{t('collaboration.host.listenLabel')}</span>
            <input
              type="text"
              className="input"
              value={listenAddr}
              disabled={Boolean(status?.remote.enabled)}
              placeholder="127.0.0.1:7372 (LAN: 0.0.0.0:7372)"
              onChange={(e) => setListenAddr(e.target.value)}
            />
          </label>
          <label className="collab-field">
            <span>{t('collaboration.host.advertiseLabel')}</span>
            <input
              type="text"
              className="input"
              value={advertiseAddr}
              disabled={Boolean(status?.remote.enabled)}
              placeholder={t('collaboration.host.advertisePlaceholder')}
              onChange={(e) => setAdvertiseAddr(e.target.value)}
            />
          </label>
          <div className="collab-field-action">
            <button
              type="button"
              className={`btn btn-sm ${status?.remote.enabled ? 'btn-danger' : 'btn-primary'}`}
              disabled={hostActionBusy}
              onClick={() => { void handleToggleHost(); }}
            >
              {status?.remote.enabled ? <Square size={12} /> : <Play size={12} />}
              {status?.remote.enabled ? t('collaboration.host.stop') : t('collaboration.host.start')}
            </button>
          </div>
        </div>

        {status?.remote.enabled && (
          <div className="collab-meta-grid collab-host-live-meta">
            <div className="collab-meta-item">
              <span className="collab-meta-label">{t('collaboration.host.endpoint')}</span>
              <code className="collab-code">{status.remote.endpoint}</code>
            </div>
            <div className="collab-meta-item">
              <span className="collab-meta-label">{t('collaboration.host.connectedClients')}</span>
              <span className="collab-meta-value">{status.remoteClients}</span>
            </div>
            <div className="collab-meta-item collab-meta-item-wide">
              <span className="collab-meta-label">{t('collaboration.host.fingerprint')}</span>
              <div className="collab-copy-inline">
                <code className="collab-code collab-code-wrap">{status.remote.certificateSha256}</code>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => { void copyText('fp', status.remote.certificateSha256); }}
                >
                  {copiedKey === 'fp' ? <Check size={12} /> : <Copy size={12} />}
                  {copiedKey === 'fp' ? t('collaboration.copied') : t('collaboration.copy')}
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="collab-subblock">
          <div className="collab-subblock-header">
            <span className="collab-subblock-title">{t('collaboration.invite.title')}</span>
          </div>
          <div className="collab-invite-form">
            <div className="collab-form-row">
              <label className="collab-field">
                <span>{t('collaboration.invite.labelField')}</span>
                <input
                  type="text"
                  className="input"
                  value={inviteLabel}
                  placeholder={t('collaboration.invite.labelPlaceholder')}
                  onChange={(e) => setInviteLabel(e.target.value)}
                />
              </label>
              <label className="collab-field collab-field-ttl">
                <span>{t('collaboration.invite.ttl')}</span>
                <select
                  className="select"
                  value={inviteTtlSecs}
                  onChange={(e) => setInviteTtlSecs(Number(e.target.value))}
                >
                  <option value={300}>5m</option>
                  <option value={900}>15m</option>
                  <option value={3600}>60m</option>
                </select>
              </label>
            </div>

            <div className="collab-form-row collab-role-row">
              <div className="collab-field">
                <span>{t('collaboration.invite.role')}</span>
                <SegmentedControl<RemoteRole>
                  aria-label={t('collaboration.invite.role')}
                  value={inviteRole}
                  options={roleOptions}
                  onChange={(role) => {
                    setInviteRole(role);
                    if (role !== 'control') setInviteAllowLoan(false);
                  }}
                />
              </div>
              <label className="checkbox-wrapper collab-allow-loan">
                <input
                  type="checkbox"
                  disabled={inviteRole !== 'control'}
                  checked={inviteRole === 'control' && inviteAllowLoan}
                  onChange={(e) => setInviteAllowLoan(e.target.checked)}
                />
                {t('collaboration.invite.allowLoan')}
              </label>
            </div>

            <div className="collab-field">
              <span>{t('collaboration.invite.ports')}</span>
              {localPorts.length > 0 ? (
                <div className="collab-port-checks">
                  {localPorts.map((port) => (
                    <label key={port.id} className="checkbox-wrapper collab-port-check">
                      <input
                        type="checkbox"
                        checked={invitePorts.includes(port.id)}
                        onChange={() => toggleInvitePort(port.id)}
                      />
                      <span>{port.alias ? `${port.id} (${port.alias})` : port.id}</span>
                    </label>
                  ))}
                </div>
              ) : (
                <span className="collab-empty-hint">{t('collaboration.invite.noLocalPorts')}</span>
              )}
            </div>

            <div>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={!status?.remote.enabled || inviteBusy}
                title={!status?.remote.enabled ? t('collaboration.invite.requireHostRunning') : undefined}
                onClick={() => { void handleGenerateInvite(); }}
              >
                {t('collaboration.invite.generate')}
              </button>
            </div>

            {generatedInvite && (
              <div className="collab-snippet-block">
                <div className="collab-snippet-header">
                  <span>{t('collaboration.invite.resultLabel')}</span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => { void copyText('invite', inviteJsonText); }}
                  >
                    {copiedKey === 'invite' ? <Check size={12} /> : <Copy size={12} />}
                    {copiedKey === 'invite' ? t('collaboration.copied') : t('collaboration.copy')}
                  </button>
                </div>
                <pre className="collab-pre">{inviteJsonText}</pre>
              </div>
            )}
          </div>
        </div>

        <div className="collab-subblock">
          <div className="collab-subblock-header">
            <span className="collab-subblock-title">{t('collaboration.clients.title')}</span>
          </div>
          {clients.length > 0 ? (
            <div className="collab-list">
              {clients.map((client) => (
                <div key={client.clientId} className="collab-list-row">
                  <div className="collab-list-main">
                    <div className="collab-list-title">
                      <strong>{client.label}</strong>
                      <span className={`port-item-badge remote-role role-${client.permissions.role}`}>
                        {t(`collaboration.role.${client.permissions.role}`)}
                      </span>
                      {client.permissions.allowLoan && (
                        <span className="port-item-badge">{t('collaboration.invite.allowLoan')}</span>
                      )}
                      {client.revoked && (
                        <span className="collab-status-pill is-revoked">{t('collaboration.clients.revoked')}</span>
                      )}
                    </div>
                    <div className="collab-list-meta">
                      <code>{client.clientId}</code>
                      <span>·</span>
                      <span>
                        {client.permissions.ports.length > 0
                          ? client.permissions.ports.join(', ')
                          : t('collaboration.clients.allPorts')}
                      </span>
                    </div>
                  </div>
                  {!client.revoked && (
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      onClick={() => setConfirmRevokeClient(client)}
                    >
                      {t('collaboration.clients.revoke')}
                    </button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="collab-empty-hint">{t('collaboration.clients.empty')}</p>
          )}
        </div>
      </section>

      {/* Card 3: Paired Remote Hosts (Office side) */}
      <section className="collab-card">
        <div className="collab-card-header">
          <div className="collab-card-title-row">
            <Globe size={15} className="collab-card-icon" aria-hidden="true" />
            <h3>{t('collaboration.client.title')}</h3>
          </div>
        </div>

        <div className="collab-subblock">
          <div className="collab-subblock-header">
            <span className="collab-subblock-title">{t('collaboration.pair.title')}</span>
          </div>
          <textarea
            className="input collab-invite-textarea"
            rows={4}
            value={inviteInput}
            placeholder={t('collaboration.pair.placeholder')}
            onChange={(e) => {
              setInviteInput(e.target.value);
              setPreview(null);
            }}
          />
          <div className="collab-pair-actions">
            <button
              type="button"
              className="btn btn-sm"
              disabled={!inviteInput.trim() || inspectBusy}
              onClick={() => { void handleInspectInvite(); }}
            >
              {t('collaboration.pair.inspect')}
            </button>
          </div>

          {preview && (
            <div className="collab-preview-box">
              <div className="collab-meta-grid">
                <div className="collab-meta-item">
                  <span className="collab-meta-label">{t('collaboration.pair.previewEndpoint')}</span>
                  <code className="collab-code">{preview.endpoint}</code>
                </div>
                <div className="collab-meta-item">
                  <span className="collab-meta-label">{t('collaboration.pair.previewRole')}</span>
                  <span>{preview.role ? t(`collaboration.role.${preview.role}`) : 'observe'}</span>
                </div>
                <div className="collab-meta-item collab-meta-item-wide">
                  <span className="collab-meta-label">{t('collaboration.pair.previewFingerprint')}</span>
                  <code className="collab-code collab-code-wrap">{preview.certificateSha256}</code>
                </div>
                <div className="collab-meta-item collab-meta-item-wide">
                  <span className="collab-meta-label">{t('collaboration.pair.previewPorts')}</span>
                  <span>
                    {preview.ports.length > 0
                      ? preview.ports.join(', ')
                      : t('collaboration.clients.allPorts')}
                  </span>
                </div>
              </div>
              {preview.expired && (
                <div className="collab-preview-expired" role="alert">
                  <ShieldAlert size={13} aria-hidden="true" />
                  {t('collaboration.pair.expiredWarning')}
                </div>
              )}
              <div className="collab-form-row">
                <label className="collab-field">
                  <span>{t('collaboration.pair.profileId')}</span>
                  <input
                    type="text"
                    className="input"
                    value={profileId}
                    placeholder="lab-bench-1"
                    onChange={(e) => setProfileId(e.target.value)}
                  />
                </label>
                <label className="collab-field">
                  <span>{t('collaboration.pair.labelOverride')}</span>
                  <input
                    type="text"
                    className="input"
                    value={labelOverride}
                    placeholder={preview.label || 'Lab Workbench'}
                    onChange={(e) => setLabelOverride(e.target.value)}
                  />
                </label>
              </div>
              <div>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={!profileId.trim() || preview.expired || pairBusy}
                  onClick={() => { void handlePairAndConnect(); }}
                >
                  {t('collaboration.pair.confirmAndConnect')}
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="collab-subblock">
          <div className="collab-subblock-header">
            <span className="collab-subblock-title">{t('collaboration.profiles.title')}</span>
          </div>
          {profiles.length > 0 ? (
            <div className="collab-list">
              {profiles.map((profile) => {
                const connected = profile.status === 'connected';
                const busy = profileBusyId === profile.id || profile.status === 'connecting';
                return (
                  <div key={profile.id} className="collab-list-row">
                    <div className="collab-list-main">
                      <div className="collab-list-title">
                        <span className={`status-dot ${profile.status}`} />
                        <strong>{profile.label}</strong>
                        <span className={`port-item-badge remote-role role-${profile.role}`}>
                          {t(`collaboration.role.${profile.role}`)}
                        </span>
                        <span className="collab-meta-count">
                          {t('collaboration.profiles.portCount', { count: profile.portCount })}
                        </span>
                      </div>
                      <div className="collab-list-meta">
                        <code>{profile.endpoint}</code>
                        <span>·</span>
                        <span>{t(`sidebar.port.status.${profile.status}`)}</span>
                      </div>
                      {profile.error && (
                        <div className="collab-list-error">{profile.error}</div>
                      )}
                    </div>
                    <div className="collab-list-actions">
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={busy}
                        onClick={() => { void handleProfileConnectToggle(profile); }}
                      >
                        {connected ? <Unplug size={12} /> : <PlugZap size={12} />}
                        {connected ? t('sidebar.remoteHosts.disconnect') : t('sidebar.remoteHosts.connect')}
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        disabled={busy}
                        onClick={() => setConfirmRemoveProfile(profile)}
                      >
                        <Trash2 size={12} />
                        {t('collaboration.profiles.remove')}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="collab-empty-hint">{t('collaboration.profiles.empty')}</p>
          )}
        </div>
      </section>

      <ConfirmDialog
        open={confirmRevokeClient !== null}
        title={t('collaboration.clients.revokeTitle')}
        message={t('collaboration.clients.revokeMessage', { name: confirmRevokeClient?.label ?? '' })}
        confirmLabel={t('confirmDialog.confirm')}
        cancelLabel={t('confirmDialog.cancel')}
        danger
        onConfirm={() => { void handleRevokeClient(); }}
        onCancel={() => setConfirmRevokeClient(null)}
      />

      <ConfirmDialog
        open={confirmRemoveProfile !== null}
        title={t('collaboration.profiles.removeTitle')}
        message={t('collaboration.profiles.removeMessage', { name: confirmRemoveProfile?.label ?? '' })}
        confirmLabel={t('confirmDialog.confirm')}
        cancelLabel={t('confirmDialog.cancel')}
        danger
        onConfirm={() => { void handleRemoveProfile(); }}
        onCancel={() => setConfirmRemoveProfile(null)}
      />
    </div>
  );
};

export default CollaborationSettings;
