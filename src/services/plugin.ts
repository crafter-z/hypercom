import { Channel, invoke } from '@tauri-apps/api/core';
import { decodeLegacyPluginBytes, isPluginRawUnsupported } from './pluginBinary';
import type {
  PluginHttpChunk,
  PluginHttpHead,
  PluginHttpRequest,
  PluginListResponse,
  PluginStateSnapshot,
  PluginShellRequest,
  PluginShellResult,
  MarketplaceIndex,
  MarketplaceUpdate,
} from '../types';

function assertAssetWriteContent(content: string | undefined, base64: string | undefined): void {
  if ((content === undefined) === (base64 === undefined)) {
    throw new Error('writePluginAsset 需要 content 或 base64 之一');
  }
}

export type PluginInstallProgress =
  | { phase: 'waiting' | 'scanning' | 'validating' | 'committing' }
  | { phase: 'copying'; copiedBytes: number; totalBytes: number; availableBytes: number };

export interface PluginDirectoryInstallRequest {
  requestId: string;
  onProgress: (progress: PluginInstallProgress) => void;
}

export type PluginInstallCancelResult = 'accepted' | 'tooLate' | 'notFound';

export interface PluginSerialLoanInfo {
  leaseId: string;
  portId: string;
  holder: string;
  reason?: string;
  acquiredAtMs: number;
  expiresAtMs?: number;
  generation: number;
  autoReopen: boolean;
  connectionBound: boolean;
}

export interface PluginSerialLoanAcquireRequest {
  portId: string;
  expectedConnectionGeneration?: number;
  reason?: string;
  ttlMs?: number;
  autoReopen?: boolean;
}

export interface PluginSerialLoanHeartbeatRequest {
  leaseId: string;
  extendTtlMs?: number;
}

export interface PluginSerialLoanReleaseRequest {
  leaseId: string;
  reopenOverride?: boolean;
}

export interface PluginSerialLoanReleaseResult {
  state: string;
  error?: string;
}

export const pluginService = {
  listPlugins: (): Promise<PluginListResponse> => invoke('list_plugins'),
  installPlugin: (
    sourcePath: string,
    replaceExisting?: boolean,
    expectedGeneration?: string,
  ): Promise<PluginStateSnapshot> =>
    invoke('install_plugin', { sourcePath, replaceExisting, expectedGeneration }),
  installPluginDirectory: (
    sourcePath: string,
    { requestId, onProgress }: PluginDirectoryInstallRequest,
    replaceExisting?: boolean,
    expectedGeneration?: string,
  ): Promise<PluginStateSnapshot> => {
    const progress = new Channel<PluginInstallProgress>(onProgress);
    return invoke('install_plugin_directory_with_progress', { sourcePath, replaceExisting, expectedGeneration, requestId, progress });
  },
  cancelPluginInstall: (requestId: string): Promise<PluginInstallCancelResult> =>
    invoke('cancel_plugin_install', { requestId }),
  /** Reload installed code in place; preserves installGeneration/consent/data. */
  reloadPlugin: (id: string, expectedGeneration: string): Promise<PluginStateSnapshot> =>
    invoke('reload_plugin', { id, expectedGeneration }),
  uninstallPlugin: (id: string, expectedGeneration: string): Promise<PluginStateSnapshot> =>
    invoke('uninstall_plugin', { id, expectedGeneration }),
  setPluginEnabled: (id: string, enabled: boolean, expectedGeneration: string): Promise<PluginStateSnapshot> =>
    invoke('set_plugin_enabled', { id, enabled, expectedGeneration }),
  setPluginPermissions: (id: string, permissions: string[], expectedGeneration: string): Promise<PluginStateSnapshot> =>
    invoke('set_plugin_permissions', { id, permissions, expectedGeneration }),
  setPluginTrustedWeb: (id: string, trusted: boolean, expectedGeneration: string): Promise<PluginStateSnapshot> =>
    invoke('set_plugin_trusted_web', { id, trusted, expectedGeneration }),
  clearPluginWebData: (id: string, expectedGeneration: string): Promise<PluginStateSnapshot> =>
    invoke('clear_plugin_web_data', { id, expectedGeneration }),
  // Legacy wire contract is retained for text, KV and older native IPC paths.
  readPluginAsset: (id: string, relPath: string, format: 'text' | 'binary' = 'text'): Promise<string | null> =>
    invoke('read_plugin_asset', { id, relPath, format }),
  /** Whole-file binary fast path; only unsupported raw IPC may use legacy base64. */
  async readPluginAssetBytes(id: string, relPath: string, expectedGeneration?: string): Promise<Uint8Array | null> {
    try {
      const raw = await invoke<unknown>('read_plugin_asset_raw', { id, relPath, expectedGeneration });
      if (!(raw instanceof ArrayBuffer)) throw new Error('invalid plugin asset raw response');
      return new Uint8Array(raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'PLUGIN_FILE_NOT_FOUND') return null;
      if (!isPluginRawUnsupported(error)) throw error;
      const legacy = await invoke<string | null>('read_plugin_asset', { id, relPath, format: 'binary' });
      return legacy === null ? null : decodeLegacyPluginBytes(legacy);
    }
  },
  /** Text or raw bytes; content/base64 are mutually exclusive on the wire. */
  writePluginAsset: (id: string, relPath: string, content?: string, base64?: string): Promise<void> => {
    assertAssetWriteContent(content, base64);
    return invoke('write_plugin_asset', { id, relPath, content, base64 });
  },
  pluginHttpOpen: (
    pluginId: string,
    expectedGeneration: string,
    requestId: string,
    request: PluginHttpRequest,
  ): Promise<PluginHttpHead> =>
    invoke('plugin_http_open', { pluginId, expectedGeneration, requestId, request }),
  pluginHttpRead: (pluginId: string, expectedGeneration: string, requestId: string): Promise<PluginHttpChunk> =>
    invoke('plugin_http_read', { pluginId, expectedGeneration, requestId }),
  pluginHttpCancel: (pluginId: string, expectedGeneration: string, requestId: string): Promise<void> =>
    invoke('plugin_http_cancel', { pluginId, expectedGeneration, requestId }),
  pluginOpenExternal: (pluginId: string, url: string): Promise<void> =>
    invoke('plugin_open_external', { pluginId, url }),
  pluginShellExecute: (
    pluginId: string,
    expectedGeneration: string,
    request: PluginShellRequest,
  ): Promise<PluginShellResult> =>
    invoke('plugin_shell_execute', { pluginId, expectedGeneration, request }),
  pluginSerialLoanAcquire: (
    pluginId: string,
    expectedGeneration: string,
    request: PluginSerialLoanAcquireRequest,
  ): Promise<PluginSerialLoanInfo> =>
    invoke('plugin_serial_loan_acquire', {
      pluginId,
      expectedGeneration,
      portId: request.portId,
      expectedConnectionGeneration: request.expectedConnectionGeneration,
      reason: request.reason,
      ttlMs: request.ttlMs,
      autoReopen: request.autoReopen,
    }),
  pluginSerialLoanHeartbeat: (
    pluginId: string,
    expectedGeneration: string,
    request: PluginSerialLoanHeartbeatRequest,
  ): Promise<PluginSerialLoanInfo> =>
    invoke('plugin_serial_loan_heartbeat', {
      pluginId,
      expectedGeneration,
      leaseId: request.leaseId,
      extendTtlMs: request.extendTtlMs,
    }),
  pluginSerialLoanRelease: (
    pluginId: string,
    expectedGeneration: string,
    request: PluginSerialLoanReleaseRequest,
  ): Promise<PluginSerialLoanReleaseResult> =>
    invoke('plugin_serial_loan_release', {
      pluginId,
      expectedGeneration,
      leaseId: request.leaseId,
      reopenOverride: request.reopenOverride,
    }),
  /** Fetch the configured marketplace index from an explicitly reviewed source. */
  fetchPluginMarketplace: (sourceUrl: string): Promise<MarketplaceIndex> =>
    invoke('fetch_plugin_marketplace', { sourceUrl }),
  /** Check the current marketplace source for updates to installed plugins. */
  checkPluginUpdates: (sourceUrl?: string): Promise<MarketplaceUpdate[]> =>
    invoke('check_plugin_updates', { sourceUrl }),
  /** Install/update a marketplace plugin after the metadata and version were reviewed. */
  installMarketplacePlugin: (
    metadataUrl: string,
    expectedId: string,
    expectedVersion: string,
    expectedGeneration?: string,
  ): Promise<PluginStateSnapshot> =>
    invoke('install_marketplace_plugin', { metadataUrl, expectedId, expectedVersion, expectedGeneration }),
};
