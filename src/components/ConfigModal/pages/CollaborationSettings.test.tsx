// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CollaborationStatusDto,
  InvitePreviewDto,
  RemoteClientDto,
  RemoteInviteDto,
  RemoteProfileSummaryDto,
} from '../../../services/control';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  getCollaborationStatus: vi.fn<() => Promise<CollaborationStatusDto>>(),
  remoteHostListClients: vi.fn<() => Promise<RemoteClientDto[]>>(),
  remoteClientListProfiles: vi.fn<() => Promise<RemoteProfileSummaryDto[]>>(),
  remoteHostCreateInvite: vi.fn(),
  remoteClientInspectInvite: vi.fn<(inviteJson: string) => Promise<InvitePreviewDto>>(),
  reclaimPortLoan: vi.fn(),
  remoteHostStart: vi.fn(),
  remoteHostStop: vi.fn(),
  remoteHostRevokeClient: vi.fn(),
  remoteClientPair: vi.fn(),
  remoteClientConnect: vi.fn(),
  remoteClientDisconnect: vi.fn(),
  remoteClientRemoveProfile: vi.fn(),
  onRemoteHostsChanged: vi.fn(),
  onSerialToolLoan: vi.fn(),
  notifyError: vi.fn(),
  notifySuccess: vi.fn(),
}));

vi.mock('../../../services/tauri', () => ({
  controlService: {
    getCollaborationStatus: () => mocks.getCollaborationStatus(),
    remoteHostListClients: () => mocks.remoteHostListClients(),
    remoteClientListProfiles: () => mocks.remoteClientListProfiles(),
    remoteHostCreateInvite: (params: unknown) => mocks.remoteHostCreateInvite(params),
    remoteClientInspectInvite: (inviteJson: string) => mocks.remoteClientInspectInvite(inviteJson),
    reclaimPortLoan: (portId: string) => mocks.reclaimPortLoan(portId),
    remoteHostStart: (params: unknown) => mocks.remoteHostStart(params),
    remoteHostStop: () => mocks.remoteHostStop(),
    remoteHostRevokeClient: (clientId: string) => mocks.remoteHostRevokeClient(clientId),
    remoteClientPair: (params: unknown) => mocks.remoteClientPair(params),
    remoteClientConnect: (profileId: string) => mocks.remoteClientConnect(profileId),
    remoteClientDisconnect: (profileId: string) => mocks.remoteClientDisconnect(profileId),
    remoteClientRemoveProfile: (profileId: string) => mocks.remoteClientRemoveProfile(profileId),
  },
  eventService: {
    onRemoteHostsChanged: (...args: unknown[]) => mocks.onRemoteHostsChanged(...args),
    onSerialToolLoan: (...args: unknown[]) => mocks.onSerialToolLoan(...args),
  },
}));

vi.mock('../../../stores/useToastStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../stores/useToastStore')>();
  return {
    ...actual,
    notifyError: (...args: unknown[]) => mocks.notifyError(...args),
    notifySuccess: (...args: unknown[]) => mocks.notifySuccess(...args),
  };
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { default: CollaborationSettings } = await import('./CollaborationSettings');
const { resetStoresForTests } = await import('../../../stores/resetStores');

function makeStatus(remoteEnabled = true): CollaborationStatusDto {
  return {
    hostId: 'host-1',
    protocol: 1,
    localEndpoint: '\\\\.\\pipe\\hypercom-ctl',
    localRunning: true,
    localClients: 0,
    remote: {
      enabled: remoteEnabled,
      endpoint: '127.0.0.1:7372',
      serverId: 'srv-1',
      certificateSha256: 'abc123',
    },
    remoteClients: 0,
    activeLoans: [],
  };
}

let container: HTMLDivElement;
let root: Root;

async function render(): Promise<void> {
  await act(async () => {
    root.render(createElement(CollaborationSettings));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

function checkboxByText(text: string): HTMLInputElement {
  const label = [...container.querySelectorAll('label')].find(el => el.textContent?.includes(text));
  expect(label).toBeDefined();
  const input = label!.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
  expect(input).not.toBeNull();
  return input!;
}

async function setCheckbox(input: HTMLInputElement, checked: boolean): Promise<void> {
  await act(async () => {
    if (input.checked !== checked) input.click();
  });
}

describe('CollaborationSettings devicePlugins integration', () => {
  beforeEach(() => {
    resetStoresForTests();
    vi.clearAllMocks();
    mocks.getCollaborationStatus.mockResolvedValue(makeStatus(true));
    mocks.remoteHostListClients.mockResolvedValue([]);
    mocks.remoteClientListProfiles.mockResolvedValue([]);
    mocks.onRemoteHostsChanged.mockResolvedValue(() => {});
    mocks.onSerialToolLoan.mockResolvedValue(() => {});
    mocks.remoteHostCreateInvite.mockResolvedValue({
      endpoint: '127.0.0.1:7372',
      serverId: 'srv-1',
      certificateSha256: 'abc123',
      code: 'invite-1',
      ports: [],
      role: 'control',
      allowLoan: false,
      devicePlugins: true,
    } satisfies RemoteInviteDto);

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

  it('defaults devicePlugins on when switching to control without forcing it off on role changes, and passes it to createInvite', async () => {
    await render();
    const pluginCheckbox = checkboxByText('collaboration.invite.devicePlugins');
    expect(pluginCheckbox.checked).toBe(false);

    // Switching to control checks devicePlugins automatically when untouched
    const controlBtn = [...container.querySelectorAll('button')].find(
      btn => btn.textContent?.trim() === 'collaboration.role.control',
    )!;
    expect(controlBtn).toBeDefined();
    await act(async () => { controlBtn.click(); });
    expect(pluginCheckbox.checked).toBe(true);

    // Switching back to observe preserves the checked state
    const observeBtn = [...container.querySelectorAll('button')].find(
      btn => btn.textContent?.trim() === 'collaboration.role.observe',
    )!;
    await act(async () => { observeBtn.click(); });
    expect(pluginCheckbox.checked).toBe(true);

    // Generate invite passes devicePlugins: true
    const generateBtn = [...container.querySelectorAll('button')].find(
      btn => btn.textContent?.trim() === 'collaboration.invite.generate',
    )!;
    await act(async () => { generateBtn.click(); });
    expect(mocks.remoteHostCreateInvite).toHaveBeenCalledWith(expect.objectContaining({
      role: 'observe',
      devicePlugins: true,
    }));

    // Unchecking explicitly works and stays unchecked even if switching to control again
    await setCheckbox(pluginCheckbox, false);
    expect(pluginCheckbox.checked).toBe(false);
    await act(async () => { controlBtn.click(); });
    expect(pluginCheckbox.checked).toBe(false);
    await act(async () => { generateBtn.click(); });
    expect(mocks.remoteHostCreateInvite).toHaveBeenLastCalledWith(expect.objectContaining({
      role: 'control',
      devicePlugins: false,
    }));
  });

  it('renders plugin badges on clients & profiles and shows devicePlugins in invite preview', async () => {
    mocks.remoteHostListClients.mockResolvedValue([
      {
        clientId: 'client-1',
        label: 'Lab Client',
        revoked: false,
        permissions: { role: 'control', ports: [], allowLoan: false, devicePlugins: true },
      },
      {
        clientId: 'client-2',
        label: 'Observer Client',
        revoked: false,
        permissions: { role: 'observe', ports: [], allowLoan: false, devicePlugins: false },
      },
    ]);
    mocks.remoteClientListProfiles.mockResolvedValue([
      {
        id: 'prof-1',
        label: 'Bench A',
        endpoint: '10.0.0.2:7372',
        serverId: 'srv-a',
        certificateSha256: 'fp-a',
        clientId: 'cli-a',
        role: 'control',
        ports: [],
        allowLoan: false,
        devicePlugins: true,
        status: 'connected',
        portCount: 1,
      },
      {
        id: 'prof-2',
        label: 'Bench B',
        endpoint: '10.0.0.3:7372',
        serverId: 'srv-b',
        certificateSha256: 'fp-b',
        clientId: 'cli-b',
        role: 'observe',
        ports: [],
        allowLoan: false,
        devicePlugins: false,
        status: 'disconnected',
        portCount: 0,
      },
    ]);
    mocks.remoteClientInspectInvite.mockResolvedValue({
      endpoint: '10.0.0.5:7372',
      serverId: 'srv-5',
      certificateSha256: 'fp-5',
      expired: false,
      label: 'Preview Bench',
      ports: [],
      role: 'write',
      allowLoan: false,
      devicePlugins: true,
    });

    await render();

    // Two rows have devicePlugins=true (client-1 and prof-1) -> two plugin badges
    const pluginBadges = [...container.querySelectorAll('.port-item-badge')].filter(
      el => el.textContent?.trim() === 'collaboration.badge.plugins',
    );
    expect(pluginBadges).toHaveLength(2);

    // Inspect invite shows preview.devicePlugins
    const textarea = container.querySelector('.collab-invite-textarea') as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(textarea, '{"code":"abc"}');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const inspectBtn = [...container.querySelectorAll('button')].find(
      btn => btn.textContent?.trim() === 'collaboration.pair.inspect',
    )!;
    await act(async () => { inspectBtn.click(); });
    expect(container.textContent).toContain('collaboration.pair.previewPlugins');
    expect(container.textContent).toContain('collaboration.pair.previewPluginsAllowed');
  });
});
