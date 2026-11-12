import type { SendCommand } from '../types';
import { serialService } from '../services/tauri';
import { getActivePortId, useAppStore } from '../stores/useAppStore';
import { useOperationStore } from '../stores/useOperationStore';
import { notifyError, useToastStore } from '../stores/useToastStore';
import { sendToPort } from '../hooks/useSerialSend';
import { getCommandStepKind, validateCommandStep } from './commandSteps';
import { getFlowStatus, isFlowRunning, setFlowStatus } from './flowRuntime';
import { isSendablePort } from './sendGuard';

/** Shared by cyclic flows and one-shot execution: only change baud, retaining
 * this target connection's confirmed framing/handshake parameters. */
export async function applyCommandParams(
  portId: string,
  command: SendCommand,
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  const port = useAppStore.getState().ports.find(item => item.id === portId);
  if (!isSendablePort(port)) throw new Error(`Port unavailable: ${portId}`);
  if (getCommandStepKind(command) !== 'setParams' || validateCommandStep(command)) throw new Error('Invalid command baud rate');
  if (!isCurrent()) return false;
  const operation = useOperationStore.getState();
  const baudRate = command.baudRate!;
  await serialService.setSerialParams(portId, {
    baudRate,
    dataBits: port.dataBits ?? operation.dataBits,
    parity: port.parity ?? operation.parity,
    stopBits: port.stopBits ?? operation.stopBits,
    handshake: port.handshake ?? operation.handshake,
    expectedGeneration: port.connectionGeneration,
  });
  if (!isCurrent()) return false;
  const current = useAppStore.getState().ports.find(item => item.id === portId);
  if (!isSendablePort(current) || current.connectionGeneration !== port.connectionGeneration) {
    throw new Error(`Port connection changed while applying parameters: ${portId}`);
  }
  useAppStore.getState().updatePort(portId, { baudRate });
  if (getActivePortId(useAppStore.getState()) === portId) {
    useOperationStore.getState().setOpState({ baudRate });
  }
  return true;
}

type SendData = (portId: string, content: string, isHex: boolean, lineEnding: string) => Promise<number>;

/** Execute only the clicked step, never its set/repeat policy or after-delay.
 * Actual sends retain the unique sendToPort pipeline (or its history wrapper).
 * A parameter operation reserves flowRuntime synchronously until I/O settles,
 * so another click/send/flow cannot interleave with the baud-rate change. */
export async function executeQuickCommand(portId: string, command: SendCommand, sendData: SendData = sendToPort): Promise<boolean> {
  const reject = (messageKey: string): false => {
    useToastStore.getState().push({ severity: 'warning', messageKey, portId });
    return false;
  };
  const validation = validateCommandStep(command);
  if (validation) return reject(validation);
  if (isFlowRunning(portId)) return reject('sendSection.flowBusy');
  if (!isSendablePort(useAppStore.getState().ports.find(item => item.id === portId))) {
    return reject('sendSection.portClosedWarning');
  }
  if (getCommandStepKind(command) === 'send') {
    return (await sendData(portId, command.content, command.type === 'hex', command.appendLineEnding)) > 0;
  }

  const status = {
    portId, runId: `quick-${crypto.randomUUID()}`, name: command.name,
    round: 1, totalRounds: 1, step: 1, totalSteps: 1,
    detail: `baud ${command.baudRate}`, exclusive: true,
  };
  const ownsStatus = () => getFlowStatus(portId)?.runId === status.runId;
  setFlowStatus({ ...status, phase: 'applyingParams' });
  try {
    const applied = await applyCommandParams(portId, command, ownsStatus);
    if (ownsStatus()) setFlowStatus({ ...status, phase: applied ? 'completed' : 'stopped' });
    return applied;
  } catch (error) {
    if (ownsStatus()) setFlowStatus({ ...status, phase: 'failed', error, detail: error instanceof Error ? error.message : String(error) });
    notifyError(error);
    return false;
  }
}
