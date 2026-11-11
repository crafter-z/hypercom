import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  clearFlowStatus,
  getFlowStatus,
  isFlowRunning,
  resetFlowRuntime,
  setFlowStatus,
  subscribeFlowRuntime,
  type FlowPhase,
} from './flowRuntime';

function publish(phase: FlowPhase, portId = 'COM3', exclusive = true, runId = 'run-1'): void {
  setFlowStatus({ portId, runId, phase, exclusive });
}

describe('flowRuntime — enhanced flow occupancy', () => {
  beforeEach(() => resetFlowRuntime());

  it('reports running for every exclusive in-progress phase', () => {
    for (const phase of ['starting', 'initializing', 'running', 'waiting', 'applyingParams', 'stopping'] as FlowPhase[]) {
      resetFlowRuntime();
      publish(phase);
      expect(isFlowRunning('COM3'), phase).toBe(true);
    }
  });

  it('releases the port for terminal phases', () => {
    for (const phase of ['completed', 'stopped', 'failed'] as FlowPhase[]) {
      resetFlowRuntime();
      publish(phase);
      expect(isFlowRunning('COM3'), phase).toBe(false);
    }
  });

  it('never locks a port for a non-exclusive status', () => {
    publish('running', 'COM3', false);
    expect(isFlowRunning('COM3')).toBe(false);
  });

  it('scopes occupancy per port', () => {
    publish('running', 'COM3');
    expect(isFlowRunning('COM3')).toBe(true);
    expect(isFlowRunning('COM4')).toBe(false);
    expect(isFlowRunning(null)).toBe(false);
    expect(isFlowRunning(undefined)).toBe(false);
  });

  it('ignores a clear request from an older run', () => {
    publish('running', 'COM3', true, 'run-2');
    clearFlowStatus('COM3', 'run-1');
    expect(getFlowStatus('COM3')?.runId).toBe('run-2');
    clearFlowStatus('COM3', 'run-2');
    expect(getFlowStatus('COM3')).toBeNull();
  });

  it('replaces the status on a newer run for the same port', () => {
    publish('completed', 'COM3', true, 'run-1');
    publish('running', 'COM3', true, 'run-2');
    expect(getFlowStatus('COM3')?.phase).toBe('running');
    expect(isFlowRunning('COM3')).toBe(true);
  });

  it('notifies subscribers on publish, clear and reset', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeFlowRuntime(listener);
    publish('running');
    expect(listener).toHaveBeenCalledTimes(1);
    clearFlowStatus('COM3');
    expect(listener).toHaveBeenCalledTimes(2);
    publish('running');
    resetFlowRuntime();
    expect(listener).toHaveBeenCalledTimes(4);
    unsubscribe();
    publish('running');
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it('does not notify when clearing an unknown port', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeFlowRuntime(listener);
    clearFlowStatus('NOPE');
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});
