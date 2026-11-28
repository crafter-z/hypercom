import { expect, type Page } from '@playwright/test';
import type { SerialPort } from '../src/types';

/** Establish a receive session through the real status handler, not a store patch.
 * Polling also waits for the app-root status listener to finish registering. */
export async function connectMockSerialPort(page: Page, portId: string, generation = 1): Promise<void> {
  await expect.poll(() => page.evaluate(async ({ portId, generation }) => {
    const path = '/src/stores/useAppStore.ts';
    const { useAppStore } = await import(path);
    window.__TAURI_INTERNALS__.dispatchEvent('serial:status', { port_id: portId, status: 'connected', generation });
    const port = useAppStore.getState().ports.find((port: SerialPort) => port.id === portId);
    return port?.status === 'connected' && port.connectionGeneration === generation;
  }, { portId, generation }), { message: `connected receive session for ${portId}` }).toBe(true);
}

/** Shared browser-only Tauri IPC fixture. Never used by production code. */
export const TAURI_MOCK = `
(() => {
  if (window.__TAURI_INTERNALS__) return;

  const callbacks = new Map();
  let nextId = 1;
  let configRevision = 0;
  const configFields = {
    restoreSession: false, sendCommandSets: [], highlightRuleSets: [], protocolTemplates: [],
    triggerRules: [], portToolConfigs: [], portPresets: [], portGroups: [], portMeta: [], pluginConfigs: [],
  };
  let configFixturePromise = null;
  let configFixture = null;
  const getConfigFixture = async () => {
    if (!configFixturePromise) {
      configFixturePromise = import('/src/stores/useAppStore.ts').then(({ useAppStore }) => {
        configFixture = structuredClone(useAppStore.getState().config);
        Object.assign(configFixture, configFields);
      });
    }
    await configFixturePromise;
    configFixture.revision = configRevision;
    return structuredClone(configFixture);
  };

  // Commands that return arrays — must NOT return null or .map() crashes.
  const ARRAY_COMMANDS = new Set([
    'load_command_sets',
    'load_highlight_sets',
    'load_protocol_templates',
    'load_port_tool_configs',
    'load_trigger_rules',
    'load_port_presets',
    'get_log_files',
    // Plugin marketplace checks are part of manual update checks; an empty
    // result keeps E2E free of an unknown-command failure.
    'check_plugin_updates',
    'list_port_leases',
    'remote_host_list_clients',
    'remote_client_list_profiles',
    'remote_list_plugin_views',
  ]);

  const NULL_COMMANDS = new Set([
    'update_session_snapshot',
    'plugin:event|unlisten',
    'open_serial_port',
    'close_serial_port',
    'set_serial_params',
    'set_flow_control',
    'attempt_reconnect',
    'cancel_file_send',
    'close_popout',
    'set_popout_always_on_top',
    'plugin:event|emit',
    'plugin:event|emit_to',
    'plugin:window|set_title',
    'prevent_screen_off',
    'prevent_sleep',
    'plugin:webview|set_webview_zoom',
    'append_diag_log',
    'get_session_snapshot',
    'complete_editor_close',
    'cancel_editor_close',
    'acknowledge_editor_close',
    'remote_host_stop',
    'remote_client_disconnect',
    'remote_client_remove_profile',
    'control_sync_plugin_tools',
    'control_plugin_reply',
    'control_plugin_job_event',
    'control_remote_view_event',
    'remote_open_plugin_view',
    'remote_close_plugin_view',
    'remote_pick_and_upload_artifact',
    'create_projected_plugin_view',
  ]);

  // 事件名 → transformCallback id（issue #6-10 e2e：驱动 serial:data 事件）
  const eventListeners = {};

  window.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args) => {
      if (ARRAY_COMMANDS.has(cmd)) return [];
      if (NULL_COMMANDS.has(cmd)) return null;
      if (cmd === 'list_available_ports') {
        // 给 e2e 一个可打开标签页的端口（issue #6-10 RX 显示路径测试）
        return [{ id: 'COM1', name: 'COM1', port_type: 'real', manufacturer: null, product: null }];
      }
      if (cmd === 'get_config') return getConfigFixture();
      if (cmd === 'get_config_path') return 'C:/mock/config.json';
      if (cmd === 'set_config') {
        if (!args || args.expectedRevision !== configRevision) return false;
        await getConfigFixture();
        const nextConfig = { ...(args.newConfig || {}) };
        delete nextConfig.revision;
        delete nextConfig.pluginConfigs;
        Object.assign(configFixture, nextConfig);
        configRevision++;
        configFixture.revision = configRevision;
        return true;
      }
      if (cmd === 'list_plugins') return { revision: configRevision, plugins: [], pluginConfigs: [] };
      if (cmd === 'plugin:event|listen') {
        const id = nextId++;
        if (args && args.event) eventListeners[args.event] = args.handler;
        return id;
      }
      if (cmd === 'plugin:app|version') return '1.0.0-e2e';
      if (cmd === 'open_popout') return args && args.kind === 'quick-send' ? 'quick-send' : 'terminal';
      if (cmd === 'send_serial_data' || cmd === 'send_file') return 0;
      if (cmd === 'plugin:window|is_maximized' || cmd === 'plugin:window|is_always_on_top') return false;
      if (cmd === 'get_system_status')
        return { status: 'normal', memoryUsedMb: 0, cpuUsage: 0 };
      if (cmd === 'get_collaboration_status') {
        return {
          hostId: 'mock-host',
          protocol: 1,
          localEndpoint: 'default',
          localRunning: true,
          localClients: 0,
          remote: { enabled: false, endpoint: '', serverId: '', certificateSha256: '' },
          remoteClients: 0,
          activeLoans: [],
        };
      }
      if (cmd === 'reclaim_port_loan') return { state: 'not-loaned' };
      if (cmd === 'remote_host_start') {
        return { enabled: true, endpoint: '127.0.0.1:7372', serverId: 'mock-server', certificateSha256: '00' };
      }
      if (cmd === 'remote_host_create_invite') {
        return {
          endpoint: '127.0.0.1:7372',
          serverId: 'mock-server',
          certificateSha256: '00',
          code: 'mock-invite-code',
          label: (args && args.label) || 'mock-invite',
          ports: (args && args.ports) || [],
          role: (args && args.role) || 'observe',
          allowLoan: Boolean(args && args.allowLoan),
          devicePlugins: Boolean(args && args.devicePlugins),
        };
      }
      if (cmd === 'remote_host_revoke_client') {
        return {
          clientId: (args && args.clientId) || '',
          label: 'revoked',
          permissions: { role: 'observe', ports: [], allowLoan: false, devicePlugins: false },
          revoked: true,
        };
      }
      if (cmd === 'remote_client_inspect_invite') {
        return {
          endpoint: '127.0.0.1:7372',
          serverId: 'mock-server',
          certificateSha256: '00',
          expired: false,
          label: 'mock-invite',
          ports: [],
          role: 'observe',
          allowLoan: false,
          devicePlugins: false,
        };
      }
      if (cmd === 'remote_client_pair') {
        return {
          id: (args && args.profileId) || 'mock-profile',
          label: (args && args.labelOverride) || 'mock-profile',
          endpoint: '127.0.0.1:7372',
          serverId: 'mock-server',
          certificateSha256: '00',
          clientId: 'mock-client',
          role: 'observe',
          ports: [],
          allowLoan: false,
          devicePlugins: false,
          status: 'disconnected',
          portCount: 0,
        };
      }
      if (cmd === 'remote_client_connect') {
        return {
          id: (args && args.profileId) || 'mock-profile',
          label: (args && args.profileId) || 'mock-profile',
          endpoint: '127.0.0.1:7372',
          serverId: 'mock-server',
          certificateSha256: '00',
          clientId: 'mock-client',
          role: 'observe',
          ports: [],
          allowLoan: false,
          devicePlugins: false,
          status: 'connected',
          portCount: 0,
        };
      }
      if (cmd === 'remote_send_plugin_view_input') return { ok: true };
      if (cmd === 'remote_poll_plugin_view_events') {
        return { remoteInstanceId: '', latestSeq: 0, nextSeq: 0, closed: true, events: [] };
      }
      if (cmd === 'remote_invoke_plugin_tool') return { mode: 'sync', result: null };
      if (cmd === 'remote_poll_plugin_job') {
        return { jobId: '', host: 'local', pluginId: '', tool: '', state: 'completed', latestSeq: 0, nextSeq: 0, events: [] };
      }
      if (cmd === 'remote_cancel_plugin_job') {
        return { jobId: '', host: 'local', pluginId: '', tool: '', state: 'cancelled', latestSeq: 0, nextSeq: 0, events: [] };
      }
      if (cmd === 'plugin_serial_loan_acquire' || cmd === 'plugin_serial_loan_heartbeat') {
        return {
          leaseId: (args && args.leaseId) || 'mock-lease',
          portId: (args && args.portId) || 'COM1',
          holder: (args && args.pluginId) || 'mock-plugin',
          reason: (args && args.reason) || undefined,
          acquiredAtMs: Date.now(),
          generation: 1,
          autoReopen: Boolean(args && args.autoReopen),
          connectionBound: false,
        };
      }
      if (cmd === 'plugin_serial_loan_release') return { state: 'released' };
      (window.__E2E_UNKNOWN_COMMANDS__ ||= []).push(cmd);
      throw new Error('Unhandled mocked Tauri command: ' + cmd);
    },
    // 测试驱动：向某个已注册的事件监听器派发 payload（@tauri-apps/api 的
    // handler 收到 { event, payload } 对象）。
    dispatchEvent: (event, payload) => {
      const handlerId = eventListeners[event];
      const cb = callbacks.get(handlerId);
      if (cb) cb({ event, id: handlerId, payload });
    },
    transformCallback: (cb, once = false) => {
      const id = nextId++;
      callbacks.set(id, (data) => {
        if (once) callbacks.delete(id);
        return cb && cb(data);
      });
      return id;
    },
    unregisterCallback: (id) => { callbacks.delete(id); },
    runCallback: (id, data) => {
      const cb = callbacks.get(id);
      if (cb) cb(data);
    },
    callbacks,
    metadata: {
      currentWindow: { label: 'main' },
      currentWebview: { windowLabel: 'main', label: 'main' },
    },
    convertFileSrc: (filePath, protocol = 'asset') =>
      'http://' + protocol + '.localhost/' + encodeURIComponent(filePath),
  };

  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: () => {},
  };
})();
`;
