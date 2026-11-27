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
  status: RemoteProfileStatus;
  error?: string;
  portCount: number;
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
};
