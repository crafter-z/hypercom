// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SendCommand, SerialPort } from '../types';
import { serialService } from '../services/tauri';
import { sendToPort } from '../hooks/useSerialSend';
import { resetStoresForTests } from '../stores/resetStores';
import { getActivePortId, useAppStore } from '../stores/useAppStore';
import { useOperationStore } from '../stores/useOperationStore';
import { useToastStore } from '../stores/useToastStore';
import { applyCommandParams, executeQuickCommand } from './commandExecution';
import { clearFlowStatus, getFlowStatus, isFlowRunning, resetFlowRuntime, setFlowStatus } from './flowRuntime';

vi.mock('../services/tauri', () => ({
  serialService: { setSerialParams: vi.fn(), sendSerialData: vi.fn() },
}));
vi.mock('../hooks/useSerialSend', async importOriginal => {
  const actual = await importOriginal<typeof import('../hooks/useSerialSend')>();
  return { ...actual, sendToPort: vi.fn() };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const params: SendCommand = {
  id: 'baud', name: 'Set baud once', kind: 'setParams', baudRate: 230400,
  order: 0, delay: 3_600_000, type: 'string', content: 'DO NOT SEND', appendLineEnding: '\\r\\n',
};
const send: SendCommand = {
  id: 'send', name: 'Read status', order: 1, delay: 3_600_000,
  type: 'string', content: 'AT+STATUS?', appendLineEnding: '\\r\\n',
};
const target: SerialPort = {
  id: 'COM1', name: 'COM1', status: 'connected', type: 'real', isHidden: false,
  baudRate: 9600, dataBits: 7, parity: 'Even', stopBits: 'Two', handshake: 'RequestToSend',
  connectionGeneration: 11,
};
const other: SerialPort = {
  id: 'COM2', name: 'COM2', status: 'connected', type: 'real', isHidden: false,
  baudRate: 19200, dataBits: 8, parity: 'Odd', stopBits: 'One', handshake: 'XonXoff',
  connectionGeneration: 22,
};

const currentPort = (portId = 'COM1') => useAppStore.getState().ports.find(port => port.id === portId)!;
const warningKeys = () => useToastStore.getState().toasts.map(toast => toast.messageKey);

beforeEach(() => {
  vi.resetAllMocks();
  resetFlowRuntime();
  resetStoresForTests();
  useAppStore.setState({ ports: [{ ...target }, { ...other }] });
  useAppStore.getState().openTab('COM1');
  // Deliberately unlike COM1: changing the target's baud must not borrow the
  // focused operation panel's framing values when the target confirms its own.
  useOperationStore.getState().setOpState({
    baudRate: 9600, dataBits: 8, parity: 'None', stopBits: 'One', handshake: 'None',
  });
  vi.mocked(serialService.setSerialParams).mockResolvedValue(undefined);
  vi.mocked(serialService.sendSerialData).mockResolvedValue(3);
  vi.mocked(sendToPort).mockResolvedValue(3);
});

afterEach(() => {
  resetFlowRuntime();
  resetStoresForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('applyCommandParams', () => {
  it('sends the requested baud with the target framing and expected connection generation, then commits only baud', async () => {
    const pending = deferred<void>();
    vi.mocked(serialService.setSerialParams).mockReturnValueOnce(pending.promise);
    const applying = applyCommandParams('COM1', params);
    expect(serialService.setSerialParams).toHaveBeenCalledExactlyOnceWith('COM1', {
      baudRate: 230400, dataBits: 7, parity: 'Even', stopBits: 'Two',
      handshake: 'RequestToSend', expectedGeneration: 11,
    });
    expect(currentPort()).toEqual(target);
    expect(useOperationStore.getState().baudRate).toBe(9600);
    pending.resolve(undefined);
    await expect(applying).resolves.toBe(true);
    expect(currentPort()).toEqual({ ...target, baudRate: 230400 });
    expect(currentPort('COM2')).toEqual(other);
    expect(useOperationStore.getState()).toMatchObject({
      baudRate: 230400, dataBits: 8, parity: 'None', stopBits: 'One', handshake: 'None',
    });
    expect(serialService.sendSerialData).not.toHaveBeenCalled();
    expect(sendToPort).not.toHaveBeenCalled();
  });

  it('uses operation defaults only for target parameters that are absent', async () => {
    useAppStore.getState().updatePort('COM1', { dataBits: undefined, stopBits: undefined });
    useOperationStore.getState().setOpState({ dataBits: 6, parity: 'Odd', stopBits: 'One', handshake: 'XonXoff' });
    await expect(applyCommandParams('COM1', params)).resolves.toBe(true);
    expect(serialService.setSerialParams).toHaveBeenCalledWith('COM1', {
      baudRate: 230400, dataBits: 6, parity: 'Even', stopBits: 'One',
      handshake: 'RequestToSend', expectedGeneration: 11,
    });
  });

  it('does not pollute a new focused port when the active tab changes during I/O', async () => {
    const pending = deferred<void>();
    vi.mocked(serialService.setSerialParams).mockReturnValueOnce(pending.promise);
    const applying = applyCommandParams('COM1', params);
    useAppStore.getState().openTab('COM2');
    useOperationStore.getState().setOpState({ baudRate: 19200, dataBits: 8, parity: 'Odd', handshake: 'XonXoff' });
    const focusedOperation = useOperationStore.getState();
    expect(getActivePortId(useAppStore.getState())).toBe('COM2');
    pending.resolve(undefined);
    await expect(applying).resolves.toBe(true);
    expect(currentPort().baudRate).toBe(230400);
    expect(currentPort('COM2')).toEqual(other);
    expect(useOperationStore.getState()).toBe(focusedOperation);
  });

  it('can apply to an explicit background target without changing the focused operation state', async () => {
    useAppStore.getState().openTab('COM2');
    useOperationStore.getState().setOpState({ baudRate: 19200 });
    const operation = useOperationStore.getState();
    await expect(applyCommandParams('COM1', params)).resolves.toBe(true);
    expect(currentPort().baudRate).toBe(230400);
    expect(useOperationStore.getState()).toBe(operation);
  });

  it('does not start I/O when its execution context is already retired', async () => {
    await expect(applyCommandParams('COM1', params, () => false)).resolves.toBe(false);
    expect(serialService.setSerialParams).not.toHaveBeenCalled();
    expect(currentPort()).toEqual(target);
  });

  it('does not write back when its execution context retires while I/O is pending', async () => {
    const pending = deferred<void>();
    let current = true;
    vi.mocked(serialService.setSerialParams).mockReturnValueOnce(pending.promise);
    const applying = applyCommandParams('COM1', params, () => current);
    current = false;
    pending.resolve(undefined);
    await expect(applying).resolves.toBe(false);
    expect(currentPort()).toEqual(target);
    expect(useOperationStore.getState().baudRate).toBe(9600);
  });

  it.each(['disconnected', 'connecting', 'error'] as const)('refuses a %s target before native I/O', async status => {
    useAppStore.getState().updatePort('COM1', { status });
    await expect(applyCommandParams('COM1', params)).rejects.toThrow('Port unavailable');
    expect(serialService.setSerialParams).not.toHaveBeenCalled();
  });

  it('refuses a missing target and non-parameter commands', async () => {
    await expect(applyCommandParams('missing', params)).rejects.toThrow('Port unavailable');
    await expect(applyCommandParams('COM1', send)).rejects.toThrow('Invalid command baud rate');
    expect(serialService.setSerialParams).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 4_000_001, undefined])('rejects invalid baud %s without I/O or mutation', async baudRate => {
    await expect(applyCommandParams('COM1', { ...params, baudRate })).rejects.toThrow('Invalid command baud rate');
    expect(serialService.setSerialParams).not.toHaveBeenCalled();
    expect(currentPort()).toEqual(target);
  });

  it('rejects a late response from a replaced connection without changing the replacement state', async () => {
    const pending = deferred<void>();
    vi.mocked(serialService.setSerialParams).mockReturnValueOnce(pending.promise);
    const applying = applyCommandParams('COM1', params);
    useAppStore.getState().updatePort('COM1', { connectionGeneration: 12, baudRate: 57600 });
    useOperationStore.getState().setOpState({ baudRate: 57600 });
    pending.resolve(undefined);
    await expect(applying).rejects.toThrow('Port connection changed');
    expect(currentPort()).toMatchObject({ connectionGeneration: 12, baudRate: 57600 });
    expect(useOperationStore.getState().baudRate).toBe(57600);
  });

  it('does not commit a response if the target disconnects while I/O is pending', async () => {
    const pending = deferred<void>();
    vi.mocked(serialService.setSerialParams).mockReturnValueOnce(pending.promise);
    const applying = applyCommandParams('COM1', params);
    useAppStore.getState().updatePort('COM1', { status: 'disconnected' });
    pending.resolve(undefined);
    await expect(applying).rejects.toThrow('Port connection changed');
    expect(currentPort().baudRate).toBe(9600);
    expect(useOperationStore.getState().baudRate).toBe(9600);
  });
});

describe('executeQuickCommand', () => {
  it('applies only the clicked parameter step, without bytes, cyclic state, or waiting for its after-delay', async () => {
    vi.useFakeTimers();
    const timersBefore = vi.getTimerCount();
    const operation = useOperationStore.getState();
    await expect(executeQuickCommand('COM1', params)).resolves.toBe(true);
    expect(serialService.setSerialParams).toHaveBeenCalledTimes(1);
    expect(serialService.sendSerialData).not.toHaveBeenCalled();
    expect(sendToPort).not.toHaveBeenCalled();
    expect(useOperationStore.getState().cyclicLoops).toBe(operation.cyclicLoops);
    expect(vi.getTimerCount()).toBe(timersBefore);
    expect(getFlowStatus('COM1')).toMatchObject({
      phase: 'completed', exclusive: true, round: 1, totalRounds: 1, step: 1, totalSteps: 1,
    });
    expect(isFlowRunning('COM1')).toBe(false);
    await vi.advanceTimersByTimeAsync(params.delay);
    expect(serialService.setSerialParams).toHaveBeenCalledTimes(1);
    expect(sendToPort).not.toHaveBeenCalled();
  });

  it.each(['string', 'hex'] as const)('routes a %s send once through the default sendToPort with exact content and line ending', async type => {
    const command: SendCommand = { ...send, type, content: type === 'hex' ? 'AA BB 01' : 'AT+STATUS?' };
    await expect(executeQuickCommand('COM1', command)).resolves.toBe(true);
    expect(sendToPort).toHaveBeenCalledExactlyOnceWith('COM1', command.content, type === 'hex', command.appendLineEnding);
    expect(serialService.setSerialParams).not.toHaveBeenCalled();
    expect(getFlowStatus('COM1')).toBeNull();
    expect(useOperationStore.getState().cyclicLoops).toEqual({});
  });

  it.each([0, -1])('uses the supplied send wrapper and reports non-positive byte result %s as failure', async result => {
    const sender = vi.fn(async () => result);
    await expect(executeQuickCommand('COM1', send, sender)).resolves.toBe(false);
    expect(sender).toHaveBeenCalledExactlyOnceWith('COM1', send.content, false, send.appendLineEnding);
    expect(sendToPort).not.toHaveBeenCalled();
    expect(serialService.setSerialParams).not.toHaveBeenCalled();
  });

  it('reserves the port synchronously, blocking a second parameter click, quick send and the real TX chokepoint until settled', async () => {
    const pending = deferred<void>();
    vi.mocked(serialService.setSerialParams).mockReturnValueOnce(pending.promise);
    const applying = executeQuickCommand('COM1', params);
    // No await before these assertions: the reservation must exist in the click's own turn.
    expect(isFlowRunning('COM1')).toBe(true);
    expect(getFlowStatus('COM1')).toMatchObject({ phase: 'applyingParams', exclusive: true });
    await expect(executeQuickCommand('COM1', { ...params, baudRate: 460800 })).resolves.toBe(false);
    await expect(executeQuickCommand('COM1', send)).resolves.toBe(false);
    expect(sendToPort).not.toHaveBeenCalled();
    expect(serialService.setSerialParams).toHaveBeenCalledTimes(1);
    const { sendToPort: realSendToPort } = await vi.importActual<typeof import('../hooks/useSerialSend')>('../hooks/useSerialSend');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(realSendToPort('COM1', 'MANUAL', false, 'None')).resolves.toBe(0);
    expect(warning).toHaveBeenCalled();
    expect(serialService.sendSerialData).not.toHaveBeenCalled();
    expect(warningKeys()).toContain('sendSection.flowBusy');
    pending.resolve(undefined);
    await expect(applying).resolves.toBe(true);
    expect(isFlowRunning('COM1')).toBe(false);
    await expect(executeQuickCommand('COM1', { ...params, baudRate: 460800 })).resolves.toBe(true);
    expect(currentPort().baudRate).toBe(460800);
    expect(serialService.setSerialParams).toHaveBeenCalledTimes(2);
  });

  it('does not lock an unrelated target while COM1 parameters are pending', async () => {
    const pending = deferred<void>();
    vi.mocked(serialService.setSerialParams).mockReturnValueOnce(pending.promise);
    const applying = executeQuickCommand('COM1', params);
    await expect(executeQuickCommand('COM2', send)).resolves.toBe(true);
    expect(sendToPort).toHaveBeenCalledWith('COM2', send.content, false, send.appendLineEnding);
    pending.resolve(undefined);
    await expect(applying).resolves.toBe(true);
  });

  it.each(['starting', 'initializing', 'running', 'waiting', 'applyingParams', 'stopping'] as const)('rejects clicks while an exclusive flow is %s', async phase => {
    const status = { portId: 'COM1', runId: 'existing', phase, exclusive: true };
    setFlowStatus(status);
    await expect(executeQuickCommand('COM1', params)).resolves.toBe(false);
    await expect(executeQuickCommand('COM1', send)).resolves.toBe(false);
    expect(getFlowStatus('COM1')).toBe(status);
    expect(serialService.setSerialParams).not.toHaveBeenCalled();
    expect(sendToPort).not.toHaveBeenCalled();
    expect(warningKeys()).toContain('sendSection.flowBusy');
  });

  it.each(['disconnected', 'connecting', 'error'] as const)('rejects a %s port without taking a lock', async status => {
    useAppStore.getState().updatePort('COM1', { status });
    await expect(executeQuickCommand('COM1', params)).resolves.toBe(false);
    await expect(executeQuickCommand('COM1', send)).resolves.toBe(false);
    expect(serialService.setSerialParams).not.toHaveBeenCalled();
    expect(sendToPort).not.toHaveBeenCalled();
    expect(getFlowStatus('COM1')).toBeNull();
    expect(warningKeys()).toContain('sendSection.portClosedWarning');
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 4_000_001, undefined])('rejects invalid quick baud %s before a lock or native mutation', async baudRate => {
    await expect(executeQuickCommand('COM1', { ...params, baudRate })).resolves.toBe(false);
    expect(serialService.setSerialParams).not.toHaveBeenCalled();
    expect(sendToPort).not.toHaveBeenCalled();
    expect(getFlowStatus('COM1')).toBeNull();
    expect(warningKeys()).toContain('editor.invalidStepBaudRate');
  });

  it('rejects an unknown imported action instead of sending its retained content', async () => {
    const future = { ...send, kind: 'future' } as unknown as SendCommand;
    await expect(executeQuickCommand('COM1', future)).resolves.toBe(false);
    expect(serialService.setSerialParams).not.toHaveBeenCalled();
    expect(sendToPort).not.toHaveBeenCalled();
    expect(getFlowStatus('COM1')).toBeNull();
    expect(warningKeys()).toContain('editor.unknownCommandStep');
  });

  it('leaves confirmed state unchanged on native failure and releases the reservation for retry', async () => {
    const error = new Error('Native parameter update failed');
    vi.mocked(serialService.setSerialParams).mockRejectedValueOnce(error);
    await expect(executeQuickCommand('COM1', params)).resolves.toBe(false);
    expect(currentPort()).toEqual(target);
    expect(useOperationStore.getState().baudRate).toBe(9600);
    expect(isFlowRunning('COM1')).toBe(false);
    expect(getFlowStatus('COM1')).toMatchObject({ phase: 'failed', error });
    await expect(executeQuickCommand('COM1', params)).resolves.toBe(true);
    expect(currentPort().baudRate).toBe(230400);
  });

  it('does not commit a quick response from an old connection generation and unlocks its failed run', async () => {
    const pending = deferred<void>();
    vi.mocked(serialService.setSerialParams).mockReturnValueOnce(pending.promise);
    const applying = executeQuickCommand('COM1', params);
    useAppStore.getState().updatePort('COM1', { connectionGeneration: 12, baudRate: 57600 });
    useOperationStore.getState().setOpState({ baudRate: 57600 });
    pending.resolve(undefined);
    await expect(applying).resolves.toBe(false);
    expect(currentPort()).toMatchObject({ connectionGeneration: 12, baudRate: 57600 });
    expect(useOperationStore.getState().baudRate).toBe(57600);
    expect(getFlowStatus('COM1')?.phase).toBe('failed');
    expect(isFlowRunning('COM1')).toBe(false);
  });

  it('does not recreate a retired quick context when its native response arrives', async () => {
    const pending = deferred<void>();
    vi.mocked(serialService.setSerialParams).mockReturnValueOnce(pending.promise);
    const applying = executeQuickCommand('COM1', params);
    clearFlowStatus('COM1');
    pending.resolve(undefined);
    await expect(applying).resolves.toBe(false);
    expect(getFlowStatus('COM1')).toBeNull();
    expect(currentPort()).toEqual(target);
    expect(useOperationStore.getState().baudRate).toBe(9600);
  });

  it.each(['resolve', 'reject'] as const)('does not overwrite a newer run when its retired native request later %s', async outcome => {
    const pending = deferred<void>();
    vi.mocked(serialService.setSerialParams).mockReturnValueOnce(pending.promise);
    const applying = executeQuickCommand('COM1', params);
    const newStatus = { portId: 'COM1', runId: 'replacement-run', phase: 'running' as const, exclusive: true, step: 2 };
    setFlowStatus(newStatus);
    if (outcome === 'resolve') pending.resolve(undefined);
    else pending.reject(new Error('Old run failed late'));
    await expect(applying).resolves.toBe(false);
    expect(getFlowStatus('COM1')).toBe(newStatus);
    expect(isFlowRunning('COM1')).toBe(true);
    expect(currentPort()).toEqual(target);
    expect(useOperationStore.getState().baudRate).toBe(9600);
  });
});
