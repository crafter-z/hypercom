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
  ]);

  // 事件名 → transformCallback id（issue #6-10 e2e：驱动 serial:data 事件）
  const eventListeners = {};

  window.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args) => {
      if (ARRAY_COMMANDS.has(cmd)) return [];
      if (cmd === 'list_available_ports') {
        // 给 e2e 一个可打开标签页的端口（issue #6-10 RX 显示路径测试）
        return [{ id: 'COM1', name: 'COM1', port_type: 'real', manufacturer: null, product: null }];
      }
      if (cmd === 'get_config') return getConfigFixture();
      if (cmd === 'update_session_snapshot') return null;
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
      if (cmd === 'plugin:event|unlisten') return null;
      if (cmd === 'plugin:event|listen') {
        const id = nextId++;
        if (args && args.event) eventListeners[args.event] = args.handler;
        return id;
      }
      if (cmd === 'plugin:app|version') return '1.0.0-e2e';
      if (cmd === 'open_serial_port' || cmd === 'close_serial_port' || cmd === 'set_serial_params'
        || cmd === 'set_flow_control' || cmd === 'attempt_reconnect' || cmd === 'cancel_file_send') return null;
      if (cmd === 'open_popout') return args && args.kind === 'quick-send' ? 'quick-send' : 'terminal';
      if (cmd === 'close_popout' || cmd === 'set_popout_always_on_top') return null;
      if (cmd === 'send_serial_data' || cmd === 'send_file') return 0;
      if (cmd === 'plugin:event|emit' || cmd === 'plugin:event|emit_to'
        || cmd === 'plugin:window|set_title' || cmd === 'prevent_screen_off' || cmd === 'prevent_sleep'
        || cmd === 'plugin:webview|set_webview_zoom' || cmd === 'append_diag_log') return null;
      if (cmd === 'plugin:window|is_maximized' || cmd === 'plugin:window|is_always_on_top') return false;
      if (cmd === 'get_session_snapshot') return null;
      if (cmd === 'get_system_status')
        return { status: 'normal', memoryUsedMb: 0, cpuUsage: 0 };
      if (cmd === 'complete_editor_close' || cmd === 'cancel_editor_close' || cmd === 'acknowledge_editor_close') return null;
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
