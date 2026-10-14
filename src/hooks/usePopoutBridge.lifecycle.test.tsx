// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePopoutBridge } from './usePopoutBridge';
import { useAppStore } from '../stores/useAppStore';
import { useRuleStore } from '../stores/useRuleStore';
import { useSystemStore } from '../stores/useSystemStore';
import { resetStoresForTests } from '../stores/resetStores';
import { popoutEventService, popoutService, serialService, storageService } from '../services/tauri';

vi.mock('../services/tauri', () => ({
  serialService: { sendSerialData: vi.fn(async () => 3) },
  gitBashSimService: { resizeGitBashSim: vi.fn(async () => {}) },
  storageService: { saveCommandSet: vi.fn(async () => {}) },
  popoutService: { terminalClosed: vi.fn(() => true) },
  popoutEventService: {
    onSendCommand: vi.fn(), onOpenConfig: vi.fn(), onCommandSetUpdated: vi.fn(),
    onRequestSync: vi.fn(), onTerminalRequestSnapshot: vi.fn(), onTerminalClosed: vi.fn(),
    emitActiveTabChanged: vi.fn(async () => {}), emitCommandSetsChanged: vi.fn(async () => {}),
    emitPortStatusesSync: vi.fn(async () => {}), emitTerminalSnapshot: vi.fn(async () => {}),
  },
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let tabId: string;
function Probe() { usePopoutBridge(); return null; }
beforeEach(() => {
  vi.clearAllMocks();
  resetStoresForTests();
  useAppStore.setState({ ports: [{ id: 'COM1', name: 'COM1', status: 'connected', type: 'real', isHidden: false }] });
  tabId = useAppStore.getState().openTab('COM1');
  useAppStore.getState().setTabPoppedOut(tabId, true);
  useRuleStore.getState().setSendCommandSets([{ id: 'set', name: 'old', commands: [], isLoop: false, loopDelay: 0, repeatCount: 0 }]);
  vi.mocked(popoutEventService.onSendCommand).mockResolvedValue(() => {});
  vi.mocked(popoutEventService.onOpenConfig).mockResolvedValue(() => {});
  vi.mocked(popoutEventService.onCommandSetUpdated).mockResolvedValue(() => {});
  vi.mocked(popoutEventService.onRequestSync).mockResolvedValue(() => {});
  vi.mocked(popoutEventService.onTerminalRequestSnapshot).mockResolvedValue(() => {});
  vi.mocked(popoutEventService.onTerminalClosed).mockResolvedValue(() => {});
  root = createRoot(document.createElement('div'));
});
afterEach(async () => { await act(async () => { root.unmount(); }); });

describe('main popout bridge retirement', () => {
  it('rejects stale registered callbacks rather than mutating current stores or sending commands', async () => {
    let finishRegistration!: (unlisten: () => void) => void;
    const unlisten = vi.fn();
    vi.mocked(popoutEventService.onSendCommand).mockImplementationOnce(() => new Promise(resolve => { finishRegistration = resolve; }));
    await act(async () => { root.render(createElement(Probe)); });
    await act(async () => { root.unmount(); });
    root = createRoot(document.createElement('div'));
    const rules = useRuleStore.getState().sendCommandSets;
    await act(async () => {
      vi.mocked(popoutEventService.onSendCommand).mock.calls[0][0]({ portId: 'COM1', content: 'old', isHex: false, lineEnding: 'None' });
      vi.mocked(popoutEventService.onOpenConfig).mock.calls[0][0]({ page: 'commands' });
      vi.mocked(popoutEventService.onCommandSetUpdated).mock.calls[0][0]({ set: { ...rules[0], name: 'stale' } });
      vi.mocked(popoutEventService.onRequestSync).mock.calls[0][0]();
      vi.mocked(popoutEventService.onTerminalRequestSnapshot).mock.calls[0][0]({ portId: 'COM1' });
      vi.mocked(popoutEventService.onTerminalClosed).mock.calls[0][0]({ portId: 'COM1' });
      finishRegistration(unlisten);
    });
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(serialService.sendSerialData).not.toHaveBeenCalled();
    expect(storageService.saveCommandSet).not.toHaveBeenCalled();
    expect(useRuleStore.getState().sendCommandSets).toBe(rules);
    expect(useSystemStore.getState().ui.isConfigOpen).toBe(false);
    expect(useAppStore.getState().tabs.find(tab => tab.id === tabId)).toMatchObject({ poppedOut: true });
    expect(popoutService.terminalClosed).not.toHaveBeenCalled();
    expect(popoutEventService.emitActiveTabChanged).not.toHaveBeenCalled();
    expect(popoutEventService.emitTerminalSnapshot).not.toHaveBeenCalled();
  });
});
