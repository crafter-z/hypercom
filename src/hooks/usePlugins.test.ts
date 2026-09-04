/**
 * usePlugins 辅助函数回归测试（issue #17 复审补强）。
 *
 * - syncStorePluginConfigs：后端返回的**权威插件状态数组**（list_plugins 响应 /
 *   四个变更命令的返回值，config.json 实体原样）写回 store.config.pluginConfigs
 *   （镜像 portGroups/portMeta 的 #4-10 模式）。此写回是两条链路的源头：
 *   ① 全量 set_config（ConfigModal 保存/取消等）不再用启动快照覆盖后端刚写入的
 *   启用/授权状态（issue #5-2 同源陷阱）；② usePluginHost 的 store 订阅
 *   （worker 启停 + rx 装配）与 PluginSession 调用时权限校验读 store——
 *   不回写则启用/授权运行时永不生效。
 *   契约：**原样写回**（不做视图加工——目录缺失/manifest 损坏不丢已装插件状态）。
 * - rxEligiblePluginIds：RX 装配资格 = enabled && terminal:read（设计 §5
 *   「宿主 → 插件事件」rx.line 权限契约——未授权插件不得收到 RX 字节）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../stores/useAppStore';
import { rxEligiblePluginIds, syncStorePluginConfigs } from './usePlugins';
import type { AppConfig, PluginConfigEntry } from '../types';

vi.mock('../services/tauri', () => ({
  pluginService: {
    listPlugins: vi.fn(),
    installPlugin: vi.fn(),
    uninstallPlugin: vi.fn(),
    setPluginEnabled: vi.fn(),
    setPluginPermissions: vi.fn(),
    readPluginAsset: vi.fn(),
    writePluginAsset: vi.fn(),
    pluginHttp: vi.fn(),
    pluginOpenExternal: vi.fn(),
  },
}));

const makeConfig = (overrides: Partial<AppConfig> = {}): AppConfig => ({
  closeBehavior: 'minimize',
  maxDisplayLines: 100000,
  language: 'zh-CN',
  theme: 'dark',
  preventScreenOff: false,
  preventSleep: false,
  autoReconnect: false,
  maxRetries: 3,
  terminalFont: 'Consolas, monospace',
  terminalFontSize: 14,
  uiFont: 'Inter, sans-serif',
  uiFontSize: 14,
  defaultBaudRates: [9600, 19200],
  defaultLineEnding: '\\r\\n',
  sendPrefix: '',
  backgroundImage: '',
  backgroundImageEnabled: false,
  backgroundImageOpacity: 50,
  backgroundImageBlur: 0,
  showPortType: true,
  sendOnEnter: true,
  clearSendInputAfterSend: false,
  quickSendInlineCount: 6,
  timestampMode: 'perLine',
  timestampFormat: 'absolute',
  autoSaveLog: true,
  logDirectory: '',
  logFilenameFormat: '[com]-[datetime]',
  logFormat: 'string',
  logEncoding: 'UTF-8',
  logSplitEnabled: true,
  logSplitSizeMb: 100,
  logIncludeTimestamp: true,
  logIncludeDirection: true,
  logSubdirMode: 'date',
  logNewFilePerSession: false,
  backupEnabled: false,
  backupInterval: 24,
  backupDirectory: '',
  restoreSession: true,
  diagLogEnabled: true,
  updateCheckMode: 'stable',
  sendCommandSets: [],
  highlightRuleSets: [],
  protocolTemplates: [],
  triggerRules: [],
  portPresets: [],
  portToolConfigs: [],
  portGroups: [],
  portMeta: [],
  pluginConfigs: [],
  ...overrides,
});

beforeEach(() => {
  useAppStore.setState({ config: makeConfig() });
});

describe('syncStorePluginConfigs（issue #5-2 快照陷阱 + 运行时同步的源）', () => {
  it('命令返回的状态数组原样写回（enabled/grantedPermissions/installedAt/source 保全）', () => {
    const entries: PluginConfigEntry[] = [
      {
        id: 'com.example.demo',
        enabled: true,
        grantedPermissions: ['terminal:read', 'serial:send'],
        installedAt: 1234,
        source: 'dir',
      },
    ];
    syncStorePluginConfigs(entries);
    expect(useAppStore.getState().config.pluginConfigs).toEqual(entries);
  });

  it('引用保持：store 中的数组与返回值同一引用（订阅触发 syncWithConfig/rx 装配）', () => {
    const entries: PluginConfigEntry[] = [
      { id: 'com.example.demo', enabled: true, grantedPermissions: [] },
    ];
    syncStorePluginConfigs(entries);
    expect(useAppStore.getState().config.pluginConfigs).toBe(entries);
  });

  it('目录已删但 config 有条目的孤儿实体不丢（无损——卸载由命令返回值驱动）', () => {
    const entries: PluginConfigEntry[] = [
      { id: 'com.example.orphased', enabled: true, grantedPermissions: ['terminal:read'] },
    ];
    syncStorePluginConfigs(entries);
    expect(useAppStore.getState().config.pluginConfigs).toEqual(entries);
  });

  it('空数组清空 store.pluginConfigs（卸载最后一个插件后）', () => {
    useAppStore.getState().setConfig({
      pluginConfigs: [{ id: 'com.example.demo', enabled: true, grantedPermissions: [] }],
    });
    syncStorePluginConfigs([]);
    expect(useAppStore.getState().config.pluginConfigs).toEqual([]);
  });
});

describe('rxEligiblePluginIds（rx.line 需 terminal:read 的权限门控）', () => {
  it('enabled 但未授予 terminal:read → 不合格（不得收到 RX 字节）', () => {
    useAppStore.getState().setConfig({
      pluginConfigs: [{ id: 'com.example.demo', enabled: true, grantedPermissions: [] }],
    });
    expect(rxEligiblePluginIds()).toEqual(new Set());
  });

  it('enabled 且授予 terminal:read → 合格', () => {
    useAppStore.getState().setConfig({
      pluginConfigs: [
        {
          id: 'com.example.demo',
          enabled: true,
          grantedPermissions: ['terminal:read'],
        },
      ],
    });
    expect(rxEligiblePluginIds()).toEqual(new Set(['com.example.demo']));
  });

  it('已授予但未启用 → 不合格', () => {
    useAppStore.getState().setConfig({
      pluginConfigs: [
        { id: 'com.example.demo', enabled: false, grantedPermissions: ['terminal:read'] },
      ],
    });
    expect(rxEligiblePluginIds()).toEqual(new Set());
  });
});
