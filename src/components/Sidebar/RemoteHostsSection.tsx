import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Globe, Loader2, Plug, PlugZap, Settings, Unplug } from 'lucide-react';
import {
  controlService,
  eventService,
  type RemotePluginViewEntryDto,
  type RemoteProfileSummaryDto,
} from '../../services/tauri';
import { notifyError } from '../../stores/useToastStore';
import type { SerialPort } from '../../types';
import { openRemotePluginViewTab } from '../../utils/pluginViewRuntime';
import { PortItemRow } from './SortablePortItem';

interface RemoteHostsSectionProps {
  remotePorts: SerialPort[];
  activePortId: string | null;
  searchActive: boolean;
  onOpenManage: () => void;
  onRefreshPorts: () => Promise<boolean>;
}

const RemoteHostsSection: React.FC<RemoteHostsSectionProps> = ({
  remotePorts,
  activePortId,
  searchActive,
  onOpenManage,
  onRefreshPorts,
}) => {
  const { t } = useTranslation();
  const [profiles, setProfiles] = useState<RemoteProfileSummaryDto[]>([]);
  const [pluginViewsByHost, setPluginViewsByHost] = useState<Record<string, RemotePluginViewEntryDto[]>>({});
  const [expandedMap, setExpandedMap] = useState<Record<string, boolean>>({});
  const [busyProfileId, setBusyProfileId] = useState<string | null>(null);
  const [connectingAll, setConnectingAll] = useState(false);

  const loadProfiles = useCallback(async () => {
    try {
      const list = await controlService.remoteClientListProfiles();
      setProfiles(Array.isArray(list) ? list : []);
    } catch (err) {
      console.debug('[RemoteHostsSection] Failed to list remote profiles:', err);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadProfiles();
    let unlisten: (() => void) | undefined;
    if (typeof eventService?.onRemoteHostsChanged === 'function') {
      void eventService.onRemoteHostsChanged(() => {
        if (!cancelled) void loadProfiles();
      }).then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      }).catch((err) => {
        console.debug('[RemoteHostsSection] Failed to subscribe to remote:hosts-changed:', err);
      });
    }
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [loadProfiles]);

  useEffect(() => {
    let cancelled = false;
    const eligibleProfiles = profiles.filter((p) => p.status === 'connected' && p.devicePlugins);
    if (eligibleProfiles.length === 0 || typeof controlService?.remoteListPluginViews !== 'function') {
      setPluginViewsByHost({});
      return;
    }
    void Promise.all(
      eligibleProfiles.map(async (p) => {
        try {
          const views = await controlService.remoteListPluginViews(p.id);
          const workspaceViews = Array.isArray(views)
            ? views.filter((view) => !view.placements?.length || view.placements.includes('workspace-tab'))
            : [];
          return [p.id, workspaceViews] as const;
        } catch {
          return [p.id, [] as RemotePluginViewEntryDto[]] as const;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      const next: Record<string, RemotePluginViewEntryDto[]> = {};
      for (const [id, views] of entries) {
        if (views.length > 0) next[id] = views;
      }
      setPluginViewsByHost(next);
    });
    return () => {
      cancelled = true;
    };
  }, [profiles]);

  const hostEntries = useMemo(() => {
    const byHostId = new Map<string, SerialPort[]>();
    for (const port of remotePorts) {
      const key = port.hostId ?? 'unknown';
      const list = byHostId.get(key) ?? [];
      list.push(port);
      byHostId.set(key, list);
    }
    const entries = profiles.map((profile) => ({
      profile,
      ports: byHostId.get(profile.id) ?? [],
      pluginViews: pluginViewsByHost[profile.id] ?? [],
    }));
    const knownIds = new Set(profiles.map((p) => p.id));
    for (const [hostId, ports] of byHostId) {
      if (!knownIds.has(hostId)) {
        entries.push({
          profile: {
            id: hostId,
            label: ports[0]?.hostLabel ?? hostId,
            endpoint: '',
            serverId: '',
            certificateSha256: '',
            clientId: '',
            role: ports[0]?.remoteRole ?? 'observe',
            ports: [],
            allowLoan: Boolean(ports[0]?.remoteAllowLoan),
            status: 'connected',
            portCount: ports.length,
          },
          ports,
          pluginViews: [],
        });
      }
    }
    if (searchActive) {
      return entries.filter((entry) => entry.ports.length > 0 || entry.pluginViews.length > 0);
    }
    return entries;
  }, [profiles, remotePorts, pluginViewsByHost, searchActive]);

  if (profiles.length === 0 && remotePorts.length === 0) {
    return null;
  }

  const toggleExpand = (id: string, currentExpanded: boolean) => {
    setExpandedMap((prev) => ({ ...prev, [id]: !currentExpanded }));
  };

  const handleToggleHostConnection = async (profile: RemoteProfileSummaryDto) => {
    if (busyProfileId === profile.id) return;
    setBusyProfileId(profile.id);
    try {
      if (profile.status === 'connected' || profile.status === 'connecting') {
        await controlService.remoteClientDisconnect(profile.id);
      } else {
        await controlService.remoteClientConnect(profile.id);
      }
      await loadProfiles();
      await onRefreshPorts();
    } catch (err) {
      notifyError(err);
      await loadProfiles();
    } finally {
      setBusyProfileId((cur) => (cur === profile.id ? null : cur));
    }
  };

  const disconnectedProfiles = profiles.filter(
    (p) => p.status === 'disconnected' || p.status === 'error',
  );
  const hasDisconnected = profiles.length > 0 && disconnectedProfiles.length > 0;

  const handleConnectAll = async () => {
    if (connectingAll || busyProfileId !== null || disconnectedProfiles.length === 0) return;
    setConnectingAll(true);
    try {
      const results = await Promise.allSettled(
        disconnectedProfiles.map((p) => controlService.remoteClientConnect(p.id)),
      );
      for (const result of results) {
        if (result.status === 'rejected') {
          notifyError(result.reason);
        }
      }
      await loadProfiles();
      await onRefreshPorts();
    } finally {
      setConnectingAll(false);
    }
  };

  const handleOpenRemotePluginView = (
    profile: RemoteProfileSummaryDto,
    view: RemotePluginViewEntryDto,
  ) => {
    try {
      openRemotePluginViewTab({
        profileId: profile.id,
        hostLabel: profile.label,
        pluginId: view.pluginId,
        pluginName: view.pluginName,
        installGeneration: view.installGeneration,
        viewId: view.viewId,
        label: view.label,
      });
    } catch (err) {
      notifyError(err);
    }
  };

  return (
    <div className="sidebar-section sidebar-remote-section">
      <div className="sidebar-section-header sidebar-remote-section-header">
        <span className="eyebrow">{t('sidebar.remoteHosts.title')}</span>
        <div className="sidebar-remote-section-actions">
          {hasDisconnected && (
            <button
              type="button"
              className="icon-btn"
              disabled={connectingAll || busyProfileId !== null}
              title={t('sidebar.remoteHosts.connectAll')}
              aria-label={t('sidebar.remoteHosts.connectAll')}
              onClick={() => { void handleConnectAll(); }}
            >
              {connectingAll ? <Loader2 size={12} className="spin-icon" /> : <PlugZap size={12} />}
            </button>
          )}
          <button
            type="button"
            className="icon-btn"
            title={t('sidebar.remoteHosts.manage')}
            aria-label={t('sidebar.remoteHosts.manage')}
            onClick={onOpenManage}
          >
            <Settings size={12} />
          </button>
        </div>
      </div>
      {hostEntries.map(({ profile, ports, pluginViews }) => {
        const isConnected = profile.status === 'connected';
        const isConnecting = profile.status === 'connecting' || busyProfileId === profile.id;
        const expanded = expandedMap[profile.id] ?? (isConnected || ports.length > 0 || pluginViews.length > 0);
        const roleLabel = t(`collaboration.role.${profile.role}`);
        const statusTitle = t(`sidebar.port.status.${profile.status}`);
        return (
          <div key={profile.id} className="remote-host-card">
            <div className="remote-host-header">
              <button
                type="button"
                className="remote-host-toggle"
                aria-expanded={expanded}
                onClick={() => toggleExpand(profile.id, expanded)}
                title={profile.endpoint || profile.label}
              >
                <ChevronRight
                  size={12}
                  className="port-group-chevron"
                  style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
                />
                <Globe size={12} className="remote-host-globe" aria-hidden="true" />
                <span className={`status-dot ${profile.status}`} title={statusTitle} />
                <span className="remote-host-label">{profile.label}</span>
                {isConnected && ports.length > 0 && (
                  <span
                    className="remote-host-port-count"
                    title={t('sidebar.remoteHosts.portCount', { count: ports.length })}
                  >
                    {ports.length}
                  </span>
                )}
                <span className={`port-item-badge remote-role role-${profile.role}`}>{roleLabel}</span>
              </button>
              <div className="remote-host-actions">
                <button
                  type="button"
                  className={`icon-btn${isConnected ? ' active' : ''}`}
                  disabled={isConnecting}
                  title={isConnected ? t('sidebar.remoteHosts.disconnect') : t('sidebar.remoteHosts.connect')}
                  aria-label={isConnected ? t('sidebar.remoteHosts.disconnect') : t('sidebar.remoteHosts.connect')}
                  onClick={() => { void handleToggleHostConnection(profile); }}
                >
                  {isConnecting
                    ? <Loader2 size={12} className="spin-icon" />
                    : isConnected ? <Unplug size={12} /> : <PlugZap size={12} />}
                </button>
              </div>
            </div>
            {profile.status === 'error' && profile.error && (
              <div className="remote-host-error" title={profile.error}>
                {profile.error}
              </div>
            )}
            {expanded && (
              <div className="remote-host-ports">
                {ports.length > 0 ? (
                  ports.map((port) => (
                    <PortItemRow
                      key={port.id}
                      port={port}
                      isActive={activePortId === port.id}
                      isConnected={port.status === 'connected'}
                    />
                  ))
                ) : pluginViews.length === 0 ? (
                  <div className="remote-host-empty">
                    {isConnected
                      ? t('sidebar.remoteHosts.noPorts')
                      : t('sidebar.remoteHosts.disconnectedHint')}
                  </div>
                ) : null}
                {pluginViews.length > 0 && (
                  <div className="remote-host-plugins" role="group" aria-label={t('sidebar.remoteHosts.pluginsSection')}>
                    {pluginViews.map((view) => (
                      <button
                        key={`${view.pluginId}:${view.viewId}`}
                        type="button"
                        className="remote-host-plugin-item"
                        title={t('sidebar.remoteHosts.openPluginView', {
                          plugin: view.pluginName || view.pluginId,
                          label: view.label,
                        })}
                        onClick={() => handleOpenRemotePluginView(profile, view)}
                      >
                        <Plug size={12} className="remote-host-plugin-icon" aria-hidden="true" />
                        <span className="remote-host-plugin-label">{view.label}</span>
                        <span className="remote-host-plugin-name">{view.pluginName || view.pluginId}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default RemoteHostsSection;
