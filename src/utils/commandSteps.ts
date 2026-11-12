import type { CommandStepKind, SendCommand, SendCommandSet } from '../types';
import { hexInputError } from './sendUtils';

/** Shared step limits: consumed by validation, editors and execution preflight. */
export const COMMAND_BAUD_RATE = [1, 4_000_000] as const;
/** 「之后等待」的取值范围：与旧版单命令 delay 完全一致（0 = 立刻做下一步）。 */
export const COMMAND_DELAY_MS = [0, 3_600_000] as const;

/** Missing kind is the only legacy fallback. Unknown explicit kinds never send bytes. */
export function getCommandStepKind(command: Pick<SendCommand, 'kind'>): CommandStepKind | 'unknown' {
  if (command.kind === undefined) return 'send';
  return command.kind === 'send' || command.kind === 'setParams' ? command.kind : 'unknown';
}

export function isSendCommand(command: Pick<SendCommand, 'kind'>): boolean {
  return getCommandStepKind(command) === 'send';
}

/** Both supported actions may execute once; unknown imported kinds never execute. */
export function isExecutableCommand(command: Pick<SendCommand, 'kind'>): boolean {
  return getCommandStepKind(command) !== 'unknown';
}

export function isEnhancedCommandSet(set: Pick<SendCommandSet, 'commands' | 'schemaVersion'>): boolean {
  return set.schemaVersion !== undefined || set.commands.some(command => !isSendCommand(command));
}

/**
 * 该集合是否会跑**不止一轮**——只有此时「轮间间隔」和轮末的等待才轮到上场，
 * 也才值得给用户「把轮末等待并入轮间间隔」这个动作。
 *
 * `repeatCount > 0` 时精确发满 N 轮：N = 1 就是单轮（没有轮间）；N = 0 时跟随
 * `isLoop`（无限循环才是多轮）。编辑器与时长估算共用这一个判定。
 */
export function runsMultipleRounds(set: Pick<SendCommandSet, 'isLoop' | 'repeatCount'>): boolean {
  const repeat = set.repeatCount ?? 0;
  return repeat > 1 || (repeat === 0 && set.isLoop);
}

/** Non-persisting adapter: callers may normalize runtime copies without rewriting old files. */
export function normalizeCommandStep(command: SendCommand): SendCommand {
  return command.kind === undefined ? { ...command, kind: 'send' } : { ...command };
}

function integerWithin(value: unknown, bounds: readonly [number, number]): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= bounds[0] && value <= bounds[1];
}

/**
 * Returns an i18n key; validation does not clamp imported steps into different actions.
 *
 * 刻意**不校验** `delay`：旧配置里它有任意值（后端与调度器天然容忍，NaN/负数
 * 等价于 0）。把能跑的旧命令集挡在门外，比容忍一个不精确的间隔更糟。
 */
export function validateCommandStep(command: SendCommand): string | null {
  switch (getCommandStepKind(command)) {
    case 'send':
      if (command.type !== 'string' && command.type !== 'hex') return 'editor.invalidCommandStep';
      // 行尾不做枚举校验：后端 `build_tx_bytes` 对未知行尾就是「不追加」，
      // 旧配置里非常规行尾一直能正常发送。启动校验只拦后端必然拒绝的输入
      // （非法 HEX / 非字符串内容），否则会把能跑的旧命令集挡在门外。
      if (typeof command.content !== 'string') return 'editor.invalidCommandStep';
      if (command.type === 'hex' && hexInputError(command.content) !== null) return 'editor.invalidHex';
      return null;
    case 'setParams':
      return integerWithin(command.baudRate, COMMAND_BAUD_RATE) ? null : 'editor.invalidStepBaudRate';
    default:
      return 'editor.unknownCommandStep';
  }
}

export function validateCommandSetSteps(set: SendCommandSet): string | null {
  if (set.schemaVersion !== undefined && set.schemaVersion !== 2) return 'editor.unsupportedCommandVersion';
  for (const command of set.commands) {
    const error = validateCommandStep(command);
    if (error) return error;
  }
  return null;
}

/** Defaults only apply to newly created steps, never to imported legacy commands. */
export function createCommandStep(kind: CommandStepKind, id: string, name: string): SendCommand {
  const base: SendCommand = { id, name, order: 0, delay: 0, type: 'string', content: '', appendLineEnding: 'None' };
  if (kind === 'setParams') return { ...base, kind, baudRate: 230400 };
  // 旧版新建发送命令的默认间隔就是 100ms——保留，但界面现在会写明它是
  // 「之后等待 100 ms」，不再是列表里一个没有含义的 100。
  return { ...base, delay: 100, appendLineEnding: '\\r\\n' };
}

/**
 * 把某一步的「之后等待」并入集合的**轮间间隔**并清零该步——轮末那一步的等待
 * 唯一有意义的去处就是轮边界（`loopDelay`）。设置页与弹窗列表共用这一份算术，
 * 不要各自写一遍加法（两处漂移会让同一操作在两边产生不同的时序）。
 */
export function foldDelayIntoRoundGap(
  set: Pick<SendCommandSet, 'commands' | 'loopDelay'>,
  commandId: string,
): { loopDelay: number; commands: SendCommand[] } {
  const safe = (value: number | undefined): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
  const moved = safe(set.commands.find(command => command.id === commandId)?.delay);
  return {
    loopDelay: safe(set.loopDelay) + moved,
    commands: set.commands.map(command => command.id === commandId ? { ...command, delay: 0 } : command),
  };
}

/**
 * 切换动作类型：`delay` 是位置属性，**不随类型切换清除**（等待属于「这一步之后」，
 * 与这一步做什么无关）；只清掉另一种动作专属的字段。
 */
export function commandStepKindPatch(command: SendCommand, kind: CommandStepKind): Partial<SendCommand> {
  return {
    kind,
    baudRate: kind === 'setParams' ? command.baudRate ?? 230400 : undefined,
  };
}
