// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { confirm } from '@tauri-apps/plugin-dialog';
import BackupSettings from './BackupSettings';
import { configService, fileService, pluginService } from '../../../services/tauri';
import { notifyError, notifySuccess } from '../../../stores/useToastStore';
import { requestEditorLeave } from '../../../utils/editorLeave';
import { adoptEntityEditorBaselineFromConfig } from '../../../utils/entityEditor';
import { enqueueConfigWrite } from '../../../utils/configWriteQueue';
import { useAppStore } from '../../../stores/useAppStore';

vi.mock('react-i18next', () => ({ initReactI18next: { type: '3rdParty', init: () => {} }, useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ confirm: vi.fn(async () => true) }));
vi.mock('../../../services/tauri', () => ({
  configService: { setConfig: vi.fn(), getConfig: vi.fn() },
  fileService: { pickTextFileAndRead: vi.fn(), pickTextFileAndWrite: vi.fn() },
  pluginService: { listPlugins: vi.fn() },
}));
vi.mock('../../../stores/useToastStore', () => ({ notifyError: vi.fn(), notifySuccess: vi.fn() }));
vi.mock('../../../utils/editorLeave', () => ({ requestEditorLeave: vi.fn(async () => true) }));
vi.mock('../../../utils/entityEditor', () => ({ adoptEntityEditorBaselineFromConfig: vi.fn() }));
vi.mock('../../../hooks/useConfigPersistence', () => ({ markOrdinaryConfigSaved: vi.fn() }));
vi.mock('../../../utils/pluginConfigSnapshot', () => ({ syncPluginListSnapshot: vi.fn() }));

let host: HTMLDivElement;
let root: Root;
const button = () => host.querySelector<HTMLButtonElement>('.backup-action-card-warning button')!;
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.mocked(fileService.pickTextFileAndRead).mockResolvedValue(JSON.stringify({ app: 'hypercom', version: 2, config: useAppStore.getState().config }));
  vi.mocked(configService.setConfig).mockResolvedValue(false);
  vi.mocked(confirm).mockResolvedValue(true);
  vi.mocked(requestEditorLeave).mockResolvedValue(true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<BackupSettings />));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe('backup restore uses the common config write contract', () => {
  it('never publishes, reloads or reports success when the backend rejects the write', async () => {
    const previous = useAppStore.getState().config;
    await act(async () => button().click());
    expect(configService.setConfig).toHaveBeenCalledOnce();
    expect(configService.getConfig).not.toHaveBeenCalled();
    expect(adoptEntityEditorBaselineFromConfig).not.toHaveBeenCalled();
    expect(pluginService.listPlugins).not.toHaveBeenCalled();
    expect(notifySuccess).not.toHaveBeenCalled();
    expect(notifyError).toHaveBeenCalledOnce();
    expect(useAppStore.getState().config).toBe(previous);
    expect(button().disabled).toBe(false);
  });

  it('waits for an earlier ordinary/entity write instead of bypassing the common queue', async () => {
    let release!: () => void;
    const blocker = enqueueConfigWrite(() => new Promise<void>(resolve => { release = resolve; }));
    await Promise.resolve();
    try {
      await act(async () => button().click());
      expect(configService.setConfig).not.toHaveBeenCalled();
      expect(button().disabled).toBe(true);
    } finally {
      await act(async () => { release(); await blocker; });
    }
    expect(configService.setConfig).toHaveBeenCalledOnce();
    expect(notifyError).toHaveBeenCalledOnce();
  });

  it('admits only one import before React publishes the disabled button', async () => {
    let cancel!: (value: null) => void;
    vi.mocked(fileService.pickTextFileAndRead).mockImplementationOnce(() => new Promise(resolve => { cancel = resolve; }));
    await act(async () => { button().click(); button().click(); });
    expect(fileService.pickTextFileAndRead).toHaveBeenCalledOnce();
    expect(button().disabled).toBe(true);
    await act(async () => cancel(null));
    expect(configService.setConfig).not.toHaveBeenCalled();
    expect(button().disabled).toBe(false);
  });
});
