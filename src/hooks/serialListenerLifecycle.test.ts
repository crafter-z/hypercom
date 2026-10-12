// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eventService } from '../services/tauri';
import { useSerialReceive } from './useSerialReceive';
import { useToolOutput } from './useToolOutput';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('../services/tauri', () => ({
  eventService: { onSerialData: vi.fn(), onSerialStatus: vi.fn(), onToolOutput: vi.fn(), onToolExit: vi.fn() },
  serialService: {},
  gitBashSimService: {},
}));

beforeEach(() => { vi.resetAllMocks(); });

async function mountListener(hook: () => void) {
  const root = createRoot(document.createElement('div'));
  function Probe() { hook(); return null; }
  await act(async () => { root.render(createElement(Probe)); });
  return async () => { await act(async () => { root.unmount(); }); };
}

describe('serial and tool consumer subscription lifetimes', () => {
  it('releases serial data subscription when status registration fails', async () => {
    const unlisten = vi.fn();
    vi.mocked(eventService.onSerialData).mockResolvedValue(unlisten);
    vi.mocked(eventService.onSerialStatus).mockRejectedValue(new Error('listen unavailable'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const unmount = await mountListener(useSerialReceive);
    expect(unlisten).toHaveBeenCalledTimes(1);
    await unmount();
    expect(unlisten).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it('releases tool output subscription when exit registration fails', async () => {
    const unlisten = vi.fn();
    vi.mocked(eventService.onToolOutput).mockResolvedValue(unlisten);
    vi.mocked(eventService.onToolExit).mockRejectedValue(new Error('listen unavailable'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const unmount = await mountListener(useToolOutput);
    expect(unlisten).toHaveBeenCalledTimes(1);
    await unmount();
    expect(unlisten).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
