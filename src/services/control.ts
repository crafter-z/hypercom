/**
 * 本地 IPC 协作、租约回收与远端 TLS 1.3 控制面命令封装。
 */
import { invoke } from '@tauri-apps/api/core';
import type { PortLoanInfo, RemoteRole } from '../types';

export interface LoanInfoDto extends PortLoanInfo {
  portId: string;
  generation: number;
}

export interface LeaseRecoveryDto {
  state: string;
  error?: string;
}

export interface RemoteStatusDto {
  enabled: boolean;
  endpoint: string;
  serverId: string;
  certificateSha256: string;
}

export interface CollaborationStatusDto {
  hostId: string;
  protocol: number;
  localEndpoint: string;
  localRunning: boolean;
  localClients: number;
  remote: RemoteStatusDto;
  remoteClients: number;
  activeLoans: LoanInfoDto[];
}

export interface RemotePermissionsDto {
  role: RemoteRole;
  ports: string[];
  allowLoan: boolean;
  automation?: boolean;
  devicePlugins?: boolean;
  deviceTools?: boolean;
}

export interface RemoteInviteDto {
  endpoint: string;
  serverId: string;
  certificateSha256: string;
  code: string;
  expiresAt?: number;
  label?: string;
  ports: string[];
  role?: RemoteRole;
  allowLoan: boolean;
  devicePlugins?: boolean;
}

export interface RemoteClientDto {
  clientId: string;
  label: string;
  permissions: RemotePermissionsDto;
  revoked: boolean;
}

export interface InvitePreviewDto {
  endpoint: string;
  serverId: string;
  certificateSha256: string;
  expiresAt?: number;
  expired: boolean;
  label?: string;
  ports: string[];
  role?: RemoteRole;
  allowLoan: boolean;
  devicePlugins?: boolean;
}

export type RemoteProfileStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface RemoteProfileSummaryDto {
  id: string;
  label: string;
  endpoint: string;
  serverId: string;
  certificateSha256: string;
  clientId: string;
  role: RemoteRole;
  ports: string[];
  allowLoan: boolean;
  devicePlugins?: boolean;
  status: RemoteProfileStatus;
  error?: string;
  portCount: number;
}

export interface HostErrorDto {
  code: string;
  message: string;
}

export interface PluginToolDescriptorDto {
  host: string;
  hostLabel?: string;
  pluginId: string;
  pluginName: string;
  installGeneration: string;
  tool: string;
  description: string;
  access: string;
  mode: string;
  portScoped: boolean;
  acceptsArtifacts: boolean;
  inputSchema: Record<string, unknown>;
}

export interface ResolvedArtifactDto {
  artifactId: string;
  name: string;
  path: string;
  sizeBytes: number;
  sha256: string;
}

export interface ArtifactInfoDto {
  artifactId: string;
  name: string;
  sizeBytes: number;
  sha256: string;
  expiresAtMs: number;
}

export interface PluginJobEventDto {
  seq: number;
  timestampMs: number;
  kind: string;
  message?: string;
  stream?: string;
  progress?: number;
  data?: unknown;
}

export interface PluginJobStatusDto {
  jobId: string;
  host: string;
  pluginId: string;
  tool: string;
  state: string;
  result?: unknown;
  error?: HostErrorDto;
  latestSeq: number;
  nextSeq: number;
  events: PluginJobEventDto[];
}

export interface PluginToolInvokeResultDto {
  mode: string;
  result?: unknown;
  jobId?: string;
  status?: PluginJobStatusDto;
}

export interface RemotePluginViewEntryDto {
  pluginId: string;
  pluginName: string;
  installGeneration: string;
  viewId: string;
  label: string;
  mode: string;
  placements: string[];
  portBinding: string;
}

export interface RemoteViewAssetDto {
  relPath: string;
  mime: string;
  dataBase64: string;
}

export interface RemoteViewSessionDto {
  remoteInstanceId: string;
  documentId: string;
  pluginId: string;
  pluginName: string;
  installGeneration: string;
  viewId: string;
  label: string;
  entry: string;
  styles: string[];
  assets: RemoteViewAssetDto[];
}

export interface RemoteViewEventDto {
  seq: number;
  kind: string;
  payload: unknown;
}

export interface RemoteViewEventPageDto {
  remoteInstanceId: string;
  latestSeq: number;
  nextSeq: number;
  closed: boolean;
  events: RemoteViewEventDto[];
}

export const controlService = {
  getCollaborationStatus: (): Promise<CollaborationStatusDto> =>
    invoke<CollaborationStatusDto>('get_collaboration_status'),

  reclaimPortLoan: (portId: string): Promise<LeaseRecoveryDto> =>
    invoke<LeaseRecoveryDto>('reclaim_port_loan', { portId }),

  listPortLeases: (): Promise<LoanInfoDto[]> =>
    invoke<LoanInfoDto[]>('list_port_leases'),

  remoteHostStart: (params: { listen: string; advertise?: string }): Promise<RemoteStatusDto> =>
    invoke<RemoteStatusDto>('remote_host_start', params),

  remoteHostStop: (): Promise<void> =>
    invoke<void>('remote_host_stop'),

  remoteHostCreateInvite: (params: {
    label: string;
    ports: string[];
    role: RemoteRole;
    allowLoan: boolean;
    devicePlugins?: boolean;
    ttlSecs?: number;
  }): Promise<RemoteInviteDto> =>
    invoke<RemoteInviteDto>('remote_host_create_invite', params),

  remoteHostListClients: (): Promise<RemoteClientDto[]> =>
    invoke<RemoteClientDto[]>('remote_host_list_clients'),

  remoteHostRevokeClient: (clientId: string): Promise<RemoteClientDto> =>
    invoke<RemoteClientDto>('remote_host_revoke_client', { clientId }),

  remoteClientInspectInvite: (inviteJson: string): Promise<InvitePreviewDto> =>
    invoke<InvitePreviewDto>('remote_client_inspect_invite', { inviteJson }),

  remoteClientPair: (params: {
    profileId: string;
    labelOverride?: string;
    inviteJson: string;
  }): Promise<RemoteProfileSummaryDto> =>
    invoke<RemoteProfileSummaryDto>('remote_client_pair', params),

  remoteClientListProfiles: (): Promise<RemoteProfileSummaryDto[]> =>
    invoke<RemoteProfileSummaryDto[]>('remote_client_list_profiles'),

  remoteClientConnect: (profileId: string): Promise<RemoteProfileSummaryDto> =>
    invoke<RemoteProfileSummaryDto>('remote_client_connect', { profileId }),

  remoteClientDisconnect: (profileId: string): Promise<void> =>
    invoke<void>('remote_client_disconnect', { profileId }),

  remoteClientRemoveProfile: (profileId: string): Promise<void> =>
    invoke<void>('remote_client_remove_profile', { profileId }),

  controlSyncPluginTools: (tools: PluginToolDescriptorDto[]): Promise<void> =>
    invoke<void>('control_sync_plugin_tools', { tools }),

  controlPluginReply: (params: {
    requestId: string;
    ok: boolean;
    result?: unknown;
    error?: string;
  }): Promise<void> =>
    invoke<void>('control_plugin_reply', params),

  controlPluginJobEvent: (params: {
    jobId: string;
    kind: string;
    message?: string;
    stream?: string;
    progress?: number;
    data?: unknown;
    result?: unknown;
    error?: string;
  }): Promise<void> =>
    invoke<void>('control_plugin_job_event', params),

  controlRemoteViewEvent: (params: {
    remoteInstanceId: string;
    kind: string;
    payload?: unknown;
  }): Promise<void> =>
    invoke<void>('control_remote_view_event', params),

  remoteListPluginViews: (profileId: string): Promise<RemotePluginViewEntryDto[]> =>
    invoke<RemotePluginViewEntryDto[]>('remote_list_plugin_views', { profileId }),

  remoteOpenPluginView: (params: {
    profileId: string;
    pluginId: string;
    viewId: string;
    boundPortId?: string | null;
    params?: unknown;
  }): Promise<RemoteViewSessionDto> =>
    invoke<RemoteViewSessionDto>('remote_open_plugin_view', params),

  remoteSendPluginViewInput: (params: {
    profileId: string;
    remoteInstanceId: string;
    kind: string;
    payload?: unknown;
  }): Promise<unknown> =>
    invoke<unknown>('remote_send_plugin_view_input', params),

  remotePollPluginViewEvents: (params: {
    profileId: string;
    remoteInstanceId: string;
    afterSeq?: number;
    waitMs?: number;
  }): Promise<RemoteViewEventPageDto> =>
    invoke<RemoteViewEventPageDto>('remote_poll_plugin_view_events', params),

  remoteClosePluginView: (profileId: string, remoteInstanceId: string): Promise<void> =>
    invoke<void>('remote_close_plugin_view', { profileId, remoteInstanceId }),

  remotePickAndUploadArtifact: (params: {
    profileId: string;
    title?: string;
    filters?: Array<{ name: string; extensions: string[] }>;
  }): Promise<ArtifactInfoDto | null> =>
    invoke<ArtifactInfoDto | null>('remote_pick_and_upload_artifact', params),

  remoteInvokePluginTool: (params: {
    profileId: string;
    pluginId: string;
    tool: string;
    args?: unknown;
    artifacts?: string[];
    timeoutMs?: number;
  }): Promise<PluginToolInvokeResultDto> =>
    invoke<PluginToolInvokeResultDto>('remote_invoke_plugin_tool', params),

  remotePollPluginJob: (params: {
    profileId: string;
    jobId: string;
    afterSeq?: number;
    waitMs?: number;
    limit?: number;
  }): Promise<PluginJobStatusDto> =>
    invoke<PluginJobStatusDto>('remote_poll_plugin_job', params),

  remoteCancelPluginJob: (profileId: string, jobId: string): Promise<PluginJobStatusDto> =>
    invoke<PluginJobStatusDto>('remote_cancel_plugin_job', { profileId, jobId }),
};
