import { describe, expect, it } from 'vitest';
import type { SendCommand, SendCommandSet } from '../types';
import { commandStepKindPatch, createCommandStep, foldDelayIntoRoundGap, getCommandStepKind, isEnhancedCommandSet, isSendCommand, normalizeCommandStep, runsMultipleRounds, validateCommandSetSteps, validateCommandStep } from './commandSteps';
import { recoverableEntityCollection } from './entityEditorRecovery';

const legacy: SendCommand = { id: 'send', name: 'Legacy', order: 3, delay: 250, type: 'hex', content: 'AA BB', appendLineEnding: 'None' };
const collection = (commands: SendCommand[]): SendCommandSet => ({ id: 'set', name: 'Set', commands, isLoop: true, loopDelay: 500, repeatCount: 2 });
const params: SendCommand = { id: 'params', name: 'Params', order: 4, delay: 0, type: 'string', content: '', appendLineEnding: 'None', kind: 'setParams', baudRate: 230400 };

describe('command-step compatibility', () => {
  it('interprets missing kind as send without changing legacy bytes, timings or persisted shape', () => {
    const normalized = normalizeCommandStep(legacy);
    expect(getCommandStepKind(legacy)).toBe('send');
    expect(isSendCommand(legacy)).toBe(true);
    expect(normalized).toEqual({ ...legacy, kind: 'send' });
    expect(legacy).not.toHaveProperty('kind');
    expect(validateCommandSetSteps(collection([legacy]))).toBeNull();
    expect(isEnhancedCommandSet(collection([legacy]))).toBe(false);
  });

  it('never treats unknown explicit kinds as a send command', () => {
    const future = { ...legacy, kind: 'future' } as unknown as SendCommand;
    expect(getCommandStepKind(future)).toBe('unknown');
    expect(isSendCommand(future)).toBe(false);
    expect(validateCommandStep(future)).toBe('editor.unknownCommandStep');
    expect(normalizeCommandStep(future).kind).toBe('future');
  });

  it('has no standalone wait action — timing is the per-step delay', () => {
    const removed = { ...legacy, kind: 'wait' } as unknown as SendCommand;
    expect(getCommandStepKind(removed)).toBe('unknown');
    expect(validateCommandStep(removed)).toBe('editor.unknownCommandStep');
    expect(createCommandStep('setParams', 'p', 'Params')).not.toHaveProperty('durationMs');
  });

  it('recognizes enhanced sets even after the last action was removed', () => {
    expect(isEnhancedCommandSet(collection([createCommandStep('setParams', 'p', 'Params')]))).toBe(true);
    expect(isEnhancedCommandSet({ ...collection([legacy]), schemaVersion: 2 })).toBe(true);
    expect(validateCommandSetSteps({ ...collection([legacy]), schemaVersion: 9 } as unknown as SendCommandSet)).toBe('editor.unsupportedCommandVersion');
  });

  it('retains legacy defaults only for newly created send commands', () => {
    expect(createCommandStep('send', 's', 'Send')).toEqual({ id: 's', name: 'Send', order: 0, delay: 100, type: 'string', content: '', appendLineEnding: '\\r\\n' });
    expect(createCommandStep('setParams', 'p', 'Params')).toMatchObject({ kind: 'setParams', baudRate: 230400, delay: 0, content: '' });
  });

  it.each([0, -1, 1.5, NaN, Infinity, 4_000_001, undefined])('rejects invalid local baud rate %s', baudRate => {
    expect(validateCommandStep({ ...legacy, kind: 'setParams', baudRate })).toBe('editor.invalidStepBaudRate');
  });
  it.each([1, 115200, 230400, 4_000_000])('accepts local baud rate %s', baudRate => {
    expect(validateCommandStep({ ...legacy, kind: 'setParams', baudRate })).toBeNull();
  });

  it('keeps legacy commands runnable when their line ending is unusual', () => {
    // 后端 `build_tx_bytes` 对未知行尾就是「不追加」，旧配置一直能正常发送；
    // 升级后的启动校验只拦后端必然拒绝的输入，不能把能跑的旧命令集挡在门外。
    expect(validateCommandStep({ ...legacy, appendLineEnding: '' as SendCommand['appendLineEnding'] })).toBeNull();
    expect(validateCommandStep({ ...legacy, appendLineEnding: '\\\\r\\\\n' as SendCommand['appendLineEnding'] })).toBeNull();
    expect(validateCommandStep({ ...legacy, content: 'A' })).toBe('editor.invalidHex');
  });

  it('tolerates any delay value so old command sets keep running', () => {
    // 旧配置里 delay 可以是任意数（调度器天然容忍，NaN/负数等价于 0）：
    // 为一个不精确的间隔拒绝启动，比容忍它更糟。
    for (const delay of [-5, 0.5, NaN, Infinity, 3_600_001]) {
      expect(validateCommandStep({ ...legacy, delay }), String(delay)).toBeNull();
    }
  });

  it('preserves HEX validation only for send steps and keeps timing across an action switch', () => {
    expect(validateCommandStep({ ...legacy, content: 'A' })).toBe('editor.invalidHex');
    expect(validateCommandStep({ ...params, content: 'A' })).toBeNull();
    // delay 是位置属性：切换动作类型时不参与清理，只有另一种动作专属字段被清掉。
    const patch = commandStepKindPatch({ ...params, delay: 55 }, 'send');
    expect(patch).toEqual({ kind: 'send', baudRate: undefined });
    expect(patch).not.toHaveProperty('content');
    expect(patch).not.toHaveProperty('delay');
  });
});

describe('round policy and folding a round-final wait', () => {
  it('only reports multiple rounds when a round gap can actually apply', () => {
    expect(runsMultipleRounds({ isLoop: true, repeatCount: 0 })).toBe(true);
    expect(runsMultipleRounds({ isLoop: false, repeatCount: 0 })).toBe(false);
    // 精确 1 轮没有轮间间隔；repeatCount > 0 时优先于 isLoop。
    expect(runsMultipleRounds({ isLoop: false, repeatCount: 1 })).toBe(false);
    expect(runsMultipleRounds({ isLoop: true, repeatCount: 1 })).toBe(false);
    expect(runsMultipleRounds({ isLoop: false, repeatCount: 2 })).toBe(true);
  });

  it('folds a step delay into the round gap and clears it there', () => {
    const set = { ...collection([{ ...legacy, delay: 250 }, params]), loopDelay: 500 };
    const patch = foldDelayIntoRoundGap(set, legacy.id);
    expect(patch.loopDelay).toBe(750);
    expect(patch.commands[0].delay).toBe(0);
    // 其它步骤不动，集合本身也不被改写（草稿链路靠不可变更新）。
    expect(patch.commands[1]).toEqual(params);
    expect(set.commands[0].delay).toBe(250);
    expect(set.loopDelay).toBe(500);
  });

  it('never produces a non-finite round gap from corrupt delays', () => {
    expect(foldDelayIntoRoundGap({ loopDelay: Number.NaN, commands: [{ ...legacy, delay: Number.POSITIVE_INFINITY }] }, legacy.id).loopDelay).toBe(0);
    expect(foldDelayIntoRoundGap({ loopDelay: 100, commands: [{ ...legacy, delay: -50 }] }, legacy.id).loopDelay).toBe(100);
    // 目标步骤不存在时也只是清零无操作，不抛错。
    expect(foldDelayIntoRoundGap({ loopDelay: 40, commands: [legacy] }, 'missing').loopDelay).toBe(40);
  });
});

describe('enhanced command draft recovery', () => {
  it('restores old and enhanced command sets without dropping action fields', () => {
    expect(recoverableEntityCollection('sendCommandSets', [collection([legacy])])).toBe(true);
    expect(recoverableEntityCollection('sendCommandSets', [{ ...collection([params, { ...legacy, kind: 'send' }]), schemaVersion: 2 }])).toBe(true);
  });
  it('retains incomplete numeric drafts for correction but rejects foreign fields and wrong types', () => {
    expect(recoverableEntityCollection('sendCommandSets', [collection([{ ...params, baudRate: -1 }])])).toBe(true);
    expect(recoverableEntityCollection('sendCommandSets', [collection([{ ...params, baudRate: '100' } as unknown as SendCommand])])).toBe(false);
    expect(recoverableEntityCollection('sendCommandSets', [collection([{ ...params, script: 'not allowed' } as SendCommand])])).toBe(false);
    // 已撤销的 durationMs 不再是合法字段：旧草稿被拒绝而不是带着幽灵字段恢复。
    expect(recoverableEntityCollection('sendCommandSets', [collection([{ ...params, durationMs: 50 } as unknown as SendCommand])])).toBe(false);
  });
});
