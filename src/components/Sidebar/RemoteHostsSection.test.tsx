// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemotePluginViewEntryDto, RemoteProfileSummaryDto } from '../../services/control';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  remoteClientListProfiles: vi.fn<() => Promise<RemoteProfileSummaryDto[]>>(),
  remoteListPluginViews: vi.fn<(profileId: string) => Promise<RemotePluginViewEntryDto[]>>(),
  remoteClientConnect: vi.fn(),
  remoteClientDisconnect: vi.fn(),
  onRemoteHostsChanged: vi.fn(),
  openRemotePluginViewTab: vi.fn(),
  notifyError: vi.fn(),
}));

vi.mock('../../services/tauri', () => ({
  controlService: {
    remoteClientListProfiles: () => mocks.remoteClientListProfiles(),
    remoteListPluginViews: (profileId: string) => mocks.remoteListPluginViews(profileId),
    remoteClientConnect: (profileId: string) => mocks.remoteClientConnect(profileId),
    remoteClientDisconnect: (profileId: string) => mocks.remoteClientDisconnect(profileId),
  },
  eventService: {
    onRemoteHostsChanged: (...args: unknown[]) => mocks.onRemoteHostsChanged(...args),
  },
}));

vi.mock('../../utils/pluginViewRuntime', () => ({
  openRemotePluginViewTab: (opts: unknown) => mocks.openRemotePluginViewTab(opts),
}));

vi.mock('../../stores/useToastStore', () => ({
  notifyError: (...args: unknown[]) => mocks.notifyError(...args),
}));

vi.mock('./SortablePortItem', () => ({
  PortItemRow: ({ port }: { port: { id: string } }) => createElement('div', { className: 'mock-port-row' }, port.id),
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { default: RemoteHostsSection } = await import('./RemoteHostsSection');

function makeProfile(overrides: Partial<RemoteProfileSummaryDto> = {}): RemoteProfileSummaryDto {
  return {
    id: 'lab-1',
    label: 'Lab Bench',
    endpoint: '10.0.0.10:7372',
    serverId: 'srv-1',
    certificateSha256: 'fp-1',
    clientId: 'cli-1',
    role: 'control',
    ports: [],
    allowLoan: false,
    devicePlugins: true,
    status: 'connected',
    portCount: 0,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('RemoteHostsSection remote plugin views', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.onRemoteHostsChanged.mockResolvedValue(() => {});
    mocks.remoteClientDisconnect.mockResolvedValue(undefined);
    mocks.remoteClientConnect.mockResolvedValue(makeProfile());
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('fetches workspace-tab remote plugin views for connected devicePlugins hosts and opens them on click', async () => {
    const profile = makeProfile();
    mocks.remoteClientListProfiles.mockResolvedValue([profile]);
    mocks.remoteListPluginViews.mockResolvedValue([
      {
        pluginId: 'com.example.scope',
        pluginName: 'Scope Plugin',
        installGeneration: 'gen-42',
        viewId: 'waveform',
        label: 'Waveform',
        mode: 'isolated',
        placements: ['workspace-tab'],
        portBinding: 'optional',
      },
      {
        pluginId: 'com.example.inline',
        pluginName: 'Inline Only',
        installGeneration: 'gen-2',
        viewId: 'inline',
        label: 'Inline View',
        mode: 'isolated',
        placements: ['serial-content'],
        portBinding: 'required',
      },
    ]);

    await act(async () => {
      root.render(createElement(RemoteHostsSection, {
        remotePorts: [],
        activePortId: null,
        searchActive: false,
        onOpenManage: () => {},
        onRefreshPorts: async () => true,
      }));
    });
    await flushPromises();

    expect(mocks.remoteListPluginViews).toHaveBeenCalledWith('lab-1');
    const items = [...container.querySelectorAll('.remote-host-plugin-item')] as HTMLButtonElement[];
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain('Waveform');
    expect(items[0].textContent).toContain('Scope Plugin');

    await act(async () => {
      items[0].click();
    });

    expect(mocks.openRemotePluginViewTab).toHaveBeenCalledWith({
      profileId: 'lab-1',
      hostLabel: 'Lab Bench',
      pluginId: 'com.example.scope',
      pluginName: 'Scope Plugin',
      installGeneration: 'gen-42',
      viewId: 'waveform',
      label: 'Waveform',
    });
  });

  it('keeps host visible during search when it has plugin views and clears views on disconnect', async () => {
    const connected = makeProfile();
    const disconnected = makeProfile({ status: 'disconnected' });
    mocks.remoteClientListProfiles.mockResolvedValueOnce([connected]).mockResolvedValueOnce([disconnected]);
    mocks.remoteListPluginViews.mockResolvedValue([
      {
        pluginId: 'com.example.flasher',
        pluginName: 'Flasher',
        installGeneration: 'gen-1',
        viewId: 'main',
        label: 'Firmware Flasher',
        mode: 'isolated',
        placements: ['workspace-tab'],
        portBinding: 'none',
      },
    ]);

    await act(async () => {
      root.render(createElement(RemoteHostsSection, {
        remotePorts: [],
        activePortId: null,
        searchActive: true,
        onOpenManage: () => {},
        onRefreshPorts: async () => true,
      }));
    });
    await flushPromises();

    expect(container.querySelector('.remote-host-card')).not.toBeNull();
    expect(container.querySelectorAll('.remote-host-plugin-item')).toHaveLength(1);

    const disconnectBtn = container.querySelector('button[aria-label="sidebar.remoteHosts.disconnect"]') as HTMLButtonElement;
    expect(disconnectBtn).not.toBeNull();
    await act(async () => {
      disconnectBtn.click();
    });
    await flushPromises();

    expect(mocks.remoteClientDisconnect).toHaveBeenCalledWith('lab-1');
    expect(container.querySelectorAll('.remote-host-plugin-item')).toHaveLength(0);
  });

  it('ignores errors gracefully when remote host does not support remoteListPluginViews', async () => {
    mocks.remoteClientListProfiles.mockResolvedValue([makeProfile()]);
    mocks.remoteListPluginViews.mockRejectedValue(new Error('unsupported'));

    await act(async () => {
      root.render(createElement(RemoteHostsSection, {
        remotePorts: [],
        activePortId: null,
        searchActive: false,
        onOpenManage: () => {},
        onRefreshPorts: async () => true,
      }));
    });
    await flushPromises();

    expect(mocks.notifyError).not.toHaveBeenCalled();
    expect(container.querySelectorAll('.remote-host-plugin-item')).toHaveLength(0);
  });
});
