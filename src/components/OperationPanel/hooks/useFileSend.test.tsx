// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { open } from '@tauri-apps/plugin-dialog';
import { useAppStore } from '../../../stores/useAppStore';
import { eventService, serialService, type FileProgressPayload } from '../../../services/tauri';
import { notifyError, notifySuccess } from '../../../stores/useToastStore';
import { trafficStats } from '../../../utils/trafficStats';
import { isFlowRunning } from '../../../utils/flowRuntime';
import { useFileSend, type FileSendControls } from './useFileSend';

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('../../../services/tauri', () => ({
  eventService: { onFileProgress: vi.fn() },
  serialService: { sendFile: vi.fn(), cancelFileSend: vi.fn(async () => {}) },
}));
vi.mock('../../../stores/useToastStore', () => ({
  notifyError: vi.fn(), notifySuccess: vi.fn(),
  useToastStore: { getState: () => ({ push: vi.fn() }) },
}));
vi.mock('../../../utils/flowRuntime', () => ({ isFlowRunning: vi.fn(() => false) }));
vi.mock('../../../utils/trafficStats', () => ({
  trafficStats: { capture: vi.fn(() => ({ identity: Symbol('lease') })), isCurrent: vi.fn(() => true), addTx: vi.fn() },
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
let root: Root;
let mounted: boolean;
let controls: FileSendControls;
let progress: (event: FileProgressPayload) => void;
const unlisten = vi.fn();
function Probe({ portId }: { portId: string | null }) { controls = useFileSend(portId); return null; }
async function render(portId: string | null = 'COM1') {
  await act(async () => { root.render(createElement(Probe, { portId })); });
}
async function begin() {
  let sending!: Promise<void>;
  await act(async () => { sending = controls.startFileSend(); });
  return { sending };
}
function emit(sentBytes: number, totalBytes = 10, done = false, extras: Partial<FileProgressPayload> = {}) {
  const calls = vi.mocked(serialService.sendFile).mock.calls;
  const transferId = calls[calls.length - 1][0].transferId;
  progress({ portId: 'COM1', transferId, sentBytes, totalBytes, done, ...extras });
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(isFlowRunning).mockReturnValue(false);
  vi.mocked(trafficStats.isCurrent).mockReturnValue(true);
  vi.mocked(open).mockResolvedValue('C:/send.bin');
  vi.mocked(eventService.onFileProgress).mockImplementation(async callback => { progress = callback; return unlisten; });
  vi.mocked(serialService.sendFile).mockResolvedValue(10);
  useAppStore.setState({ ports: ['COM1', 'COM2'].map(id => ({
    id, name: id, status: 'connected', type: 'real', isHidden: false, connectionGeneration: 7,
  })) });
  root = createRoot(document.createElement('div'));
  mounted = true;
  await render();
});
afterEach(async () => {
  if (mounted) await act(async () => { root.unmount(); });
});

describe('file send ownership and asynchronous boundaries', () => {
  it('blocks before the picker when the port is disconnected or flow-owned', async () => {
    useAppStore.getState().updatePort('COM1', { status: 'disconnected' });
    await act(async () => { await controls.startFileSend(); });
    useAppStore.getState().updatePort('COM1', { status: 'connected' });
    vi.mocked(isFlowRunning).mockReturnValue(true);
    await act(async () => { await controls.startFileSend(); });
    expect(open).not.toHaveBeenCalled();
    expect(serialService.sendFile).not.toHaveBeenCalled();
  });

  it.each(['COM2', null])('retires a pending picker on target change to %s', async target => {
    const picker = deferred<string | null>();
    vi.mocked(open).mockReturnValueOnce(picker.promise);
    const { sending } = await begin();
    await render(target);
    await act(async () => { picker.resolve('C:/old.bin'); await sending; });
    expect(serialService.sendFile).not.toHaveBeenCalled();
    expect(controls.progress).toBeNull();
  });

  it('does not send a picker result after unmount', async () => {
    const picker = deferred<string | null>();
    vi.mocked(open).mockReturnValueOnce(picker.promise);
    const { sending } = await begin();
    await act(async () => { root.unmount(); }); mounted = false;
    await act(async () => { picker.resolve('C:/old.bin'); await sending; });
    expect(serialService.sendFile).not.toHaveBeenCalled();
  });

  it('reserves a single flight before the picker and releases it on cancel', async () => {
    const picker = deferred<string | null>();
    vi.mocked(open).mockReturnValueOnce(picker.promise);
    const { sending } = await begin();
    await act(async () => { await controls.startFileSend(); });
    expect(open).toHaveBeenCalledTimes(1);
    await act(async () => { picker.resolve(null); await sending; });
    await act(async () => { await controls.startFileSend(); });
    expect(open).toHaveBeenCalledTimes(2);
    expect(serialService.sendFile).toHaveBeenCalledTimes(1);
  });

  it.each(['disconnect', 'reconnect', 'flow', 'retire'] as const)('rechecks %s after the picker', async change => {
    const picker = deferred<string | null>();
    vi.mocked(open).mockReturnValueOnce(picker.promise);
    const { sending } = await begin();
    if (change === 'disconnect') useAppStore.getState().updatePort('COM1', { status: 'disconnected' });
    if (change === 'reconnect') useAppStore.getState().updatePort('COM1', { connectionGeneration: 8 });
    if (change === 'flow') vi.mocked(isFlowRunning).mockReturnValue(true);
    if (change === 'retire') vi.mocked(trafficStats.isCurrent).mockReturnValue(false);
    await act(async () => { picker.resolve('C:/old.bin'); await sending; });
    expect(serialService.sendFile).not.toHaveBeenCalled();
    expect(controls.progress).toBeNull();
  });

  it('waits for registration and rechecks the connection after it completes', async () => {
    await act(async () => { root.unmount(); }); mounted = false;
    const ready = deferred<() => void>();
    vi.mocked(eventService.onFileProgress).mockReturnValueOnce(ready.promise);
    root = createRoot(document.createElement('div')); mounted = true; await render();
    const { sending } = await begin();
    expect(serialService.sendFile).not.toHaveBeenCalled();
    useAppStore.getState().updatePort('COM1', { status: 'disconnected' });
    await act(async () => { ready.resolve(unlisten); await sending; });
    expect(serialService.sendFile).not.toHaveBeenCalled();
  });

  it('fails closed on listener failure and retries registration on the next click', async () => {
    await act(async () => { root.unmount(); }); mounted = false;
    vi.mocked(eventService.onFileProgress).mockRejectedValue(new Error('listen unavailable'));
    root = createRoot(document.createElement('div')); mounted = true; await render();
    await act(async () => { await controls.startFileSend(); });
    expect(serialService.sendFile).not.toHaveBeenCalled();
    expect(notifyError).toHaveBeenCalledTimes(1);
    vi.mocked(eventService.onFileProgress).mockImplementation(async callback => { progress = callback; return unlisten; });
    await act(async () => { await controls.startFileSend(); });
    expect(serialService.sendFile).toHaveBeenCalledTimes(1);
  });

  it('releases the picker reservation after dialog rejection', async () => {
    vi.mocked(open).mockRejectedValueOnce(new Error('dialog unavailable'));
    await act(async () => { await controls.startFileSend(); });
    expect(notifyError).toHaveBeenCalledTimes(1);
    await act(async () => { await controls.startFileSend(); });
    expect(serialService.sendFile).toHaveBeenCalledTimes(1);
  });

  it('filters foreign progress, counts only deltas, and cancels its exact transfer', async () => {
    const transfer = deferred<number>(); vi.mocked(serialService.sendFile).mockReturnValueOnce(transfer.promise);
    const { sending } = await begin();
    await act(async () => {
      emit(9, 10, false, { transferId: 'foreign' });
      emit(9, 10, false, { portId: 'COM2' });
      emit(3); emit(3); emit(2); emit(8);
    });
    expect(vi.mocked(trafficStats.addTx).mock.calls.map(call => call[1])).toEqual([3, 5]);
    const args = vi.mocked(serialService.sendFile).mock.calls[0][0];
    expect(args.expectedGeneration).toBe(7);
    controls.cancelFileSend();
    expect(serialService.cancelFileSend).toHaveBeenCalledWith('COM1', args.transferId);
    await act(async () => { emit(10, 10, true); transfer.resolve(10); await sending; });
    expect(vi.mocked(trafficStats.addTx).mock.calls.map(call => call[1])).toEqual([3, 5, 2]);
    expect(notifySuccess).toHaveBeenCalledExactlyOnceWith('sendSection.file.sent');
    expect(controls.progress).toBeNull();
  });

  it.each([0, 4])('does not report an empty/cancelled %s-byte completion as success', async bytes => {
    const transfer = deferred<number>(); vi.mocked(serialService.sendFile).mockReturnValueOnce(transfer.promise);
    const { sending } = await begin();
    await act(async () => { emit(bytes, bytes === 0 ? 0 : 10, true); transfer.resolve(bytes); await sending; });
    expect(notifySuccess).not.toHaveBeenCalled();
    expect(controls.progress).toBeNull();
  });

  it('reconciles final bytes when invoke overtakes progress, without remaining stuck', async () => {
    const transfer = deferred<number>(); vi.mocked(serialService.sendFile).mockReturnValueOnce(transfer.promise);
    const { sending } = await begin();
    await act(async () => { emit(4); transfer.resolve(10); await sending; });
    expect(vi.mocked(trafficStats.addTx).mock.calls.map(call => call[1])).toEqual([4, 6]);
    await act(async () => { emit(10, 10, true); });
    expect(trafficStats.addTx).toHaveBeenCalledTimes(2);
    expect(controls.progress).toBeNull();
  });

  it('does not let an old picker returning after COM1 → COM2 → COM1 steal the new owner', async () => {
    const oldPicker = deferred<string | null>();
    const newTransfer = deferred<number>();
    vi.mocked(open).mockReturnValueOnce(oldPicker.promise);
    const old = await begin();
    await render('COM2'); await render('COM1');
    vi.mocked(serialService.sendFile).mockReturnValueOnce(newTransfer.promise);
    const current = await begin();
    await act(async () => { oldPicker.resolve('C:/old.bin'); await old.sending; });
    expect(serialService.sendFile).toHaveBeenCalledTimes(1);
    expect(controls.progress).toEqual({ sent: 0, total: 0 });
    await act(async () => { newTransfer.resolve(10); await current.sending; });
  });

  it('does not let old invoke settlement or progress clear a replacement transfer', async () => {
    const oldTransfer = deferred<number>();
    const newTransfer = deferred<number>();
    vi.mocked(serialService.sendFile).mockReturnValueOnce(oldTransfer.promise).mockReturnValueOnce(newTransfer.promise);
    const old = await begin();
    const oldId = vi.mocked(serialService.sendFile).mock.calls[0][0].transferId;
    await act(async () => { emit(10, 10, true); });
    const current = await begin();
    await act(async () => {
      progress({ portId: 'COM1', transferId: oldId, sentBytes: 10, totalBytes: 10, done: true });
      oldTransfer.resolve(10); await old.sending;
    });
    expect(controls.progress).toEqual({ sent: 0, total: 0 });
    expect(notifySuccess).toHaveBeenCalledTimes(1);
    await act(async () => { emit(3); newTransfer.resolve(10); await current.sending; });
    expect(vi.mocked(trafficStats.addTx).mock.calls.map(call => call[1])).toEqual([10, 3, 7]);
  });

  it('releases a listener that finishes registering after unmount', async () => {
    await act(async () => { root.unmount(); }); mounted = false;
    const ready = deferred<() => void>();
    const lateUnlisten = vi.fn();
    vi.mocked(eventService.onFileProgress).mockReturnValueOnce(ready.promise);
    root = createRoot(document.createElement('div')); mounted = true; await render();
    const { sending } = await begin();
    await act(async () => { root.unmount(); }); mounted = false;
    await act(async () => { ready.resolve(lateUnlisten); await sending; });
    expect(lateUnlisten).toHaveBeenCalledTimes(1);
    expect(serialService.sendFile).not.toHaveBeenCalled();
  });

  it('clears a rejected command even if no final progress event arrives', async () => {
    vi.mocked(serialService.sendFile).mockRejectedValueOnce(new Error('send failed'));
    await act(async () => { await controls.startFileSend(); });
    expect(controls.progress).toBeNull();
    expect(notifyError).toHaveBeenCalledTimes(1);
    await act(async () => { await controls.startFileSend(); });
    expect(serialService.sendFile).toHaveBeenCalledTimes(2);
  });
});
