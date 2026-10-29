import type { SendCommand } from '../types';

/** Stable sort preserves legacy array order when persisted ranks are equal. */
export function orderedCommands(commands: readonly SendCommand[]): SendCommand[] {
  const rank = (command: SendCommand) => Number.isFinite(command.order) ? command.order : Number.MAX_SAFE_INTEGER;
  return [...commands].sort((left, right) => rank(left) - rank(right));
}

/** Use the supplied list position after a drag, insert, or delete. */
export function renumberCommands(commands: readonly SendCommand[]): SendCommand[] {
  return commands.map((command, order) => command.order === order ? command : { ...command, order });
}

/** Canonical wire shape: array position and dense persisted rank agree. */
export function normalizeCommandOrder(commands: readonly SendCommand[]): SendCommand[] {
  return renumberCommands(orderedCommands(commands));
}
