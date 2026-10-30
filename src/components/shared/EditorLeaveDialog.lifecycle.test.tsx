// @vitest-environment jsdom
import { act, createElement, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listen } from '@tauri-apps/api/event';
import { systemService } from '../../services/tauri';
import { getEditorLeaveDialogState, registerEditorParticipant, respondEditorLeave } from '../../utils/editorLeave';
import { NumericInput } from './NumericInput';
import { useEditorWindowClose } from './EditorLeaveDialog';

vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'main' }) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('../../services/tauri', () => ({
  systemService: { acknowledgeEditorClose: vi.fn(async () => {}), completeEditorClose: vi.fn(async () => {}), cancelEditorClose: vi.fn(async () => {}) },
}));
vi.mock('./usePluginViewOverlay', () => ({ usePluginViewOverlay: () => true }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
let current = 0;
function Probe() {
  useEditorWindowClose();
  const [value, setValue] = useState(0);
  const dirty = useRef(false);
  useEffect(() => registerEditorParticipant('native-number', {
    isDirty: () => dirty.current, label: () => 'Number',
    save: async () => { dirty.current = false; return true; },
    discard: () => { dirty.current = false; },
  }), []);
  current = value;
  return createElement(NumericInput, { min: 0, max: 1000, value, onCommit: (next: number) => { dirty.current = true; setValue(next); } });
}
function request(requestId: string, forceExit = false) {
  const callback = vi.mocked(listen).mock.calls[0][1];
  callback({ event: 'editor:close-requested', id: 1, payload: { requestId, forceExit } });
}
beforeEach(async () => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(createElement(Probe)); });
});
afterEach(async () => {
  await act(async () => { await respondEditorLeave('continue'); });
  await act(async () => { root.unmount(); });
  container.remove();
  document.body.inert = false;
  vi.useRealTimers();
});

describe('native close draft publication and token coalescing', () => {
  async function typeNumber() {
    const input = container.querySelector('input')!;
    await act(async () => {
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '250');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(current).toBe(0);
  }

  it('acknowledges receipt, sends liveness while approval is pending, and stops after cancellation', async () => {
    await typeNumber();
    vi.useFakeTimers();
    await act(async () => { request('heartbeat'); });
    expect(systemService.acknowledgeEditorClose).toHaveBeenCalledExactlyOnceWith('heartbeat');
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(systemService.acknowledgeEditorClose).toHaveBeenCalledTimes(3);
    await act(async () => { await respondEditorLeave('continue'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(systemService.acknowledgeEditorClose).toHaveBeenCalledTimes(3);
  });

  it('stops orphan heartbeats when React unmounts even if its close promise remains pending', async () => {
    await typeNumber();
    vi.useFakeTimers();
    await act(async () => { request('unmounted'); });
    expect(systemService.acknowledgeEditorClose).toHaveBeenCalledExactlyOnceWith('unmounted');
    await act(async () => { root.unmount(); });
    root = createRoot(document.createElement('div'));
    await act(async () => { await vi.advanceTimersByTimeAsync(9_000); });
    expect(systemService.acknowledgeEditorClose).toHaveBeenCalledTimes(1);
  });

  it('makes the body inert between approval and the native completion response', async () => {
    let release!: () => void;
    vi.mocked(systemService.completeEditorClose).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await act(async () => { request('approved'); });
    expect(systemService.completeEditorClose).toHaveBeenCalledWith('approved');
    expect(document.body.inert).toBe(true);
    await act(async () => { release(); });
    expect(document.body.inert).toBe(false);
  });

  it('publishes the focused numeric buffer before checking whether close needs approval', async () => {
    await typeNumber();
    await act(async () => { request('one'); });
    expect(current).toBe(250);
    expect(getEditorLeaveDialogState().open).toBe(true);
    expect(systemService.completeEditorClose).not.toHaveBeenCalled();
    await act(async () => { await respondEditorLeave('discard'); });
    expect(systemService.completeEditorClose).toHaveBeenCalledExactlyOnceWith('one');
  });

  it('coalesces repeated requests with the same token into one cancellation', async () => {
    await typeNumber();
    await act(async () => { request('one'); request('one', true); });
    await act(async () => { await respondEditorLeave('continue'); });
    expect(systemService.cancelEditorClose).toHaveBeenCalledExactlyOnceWith('one');
    expect(getEditorLeaveDialogState().open).toBe(false);
  });

  it('answers the renewed token with the existing decision instead of the expired token', async () => {
    await typeNumber();
    await act(async () => { request('expired'); request('renewed', true); });
    await act(async () => { await respondEditorLeave('discard'); });
    expect(systemService.completeEditorClose).toHaveBeenCalledExactlyOnceWith('renewed');
  });
});
