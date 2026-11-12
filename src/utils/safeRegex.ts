/**
 * Conservative guard for user-authored regular expressions.
 *
 * JavaScript's RegExp engine is synchronous and offers no execution timeout.
 * Limiting pattern/input length therefore does not stop nested-quantifier
 * backtracking (for example `(a+)+$`). This parser rejects the common
 * exponential shape before a pattern reaches the hot RX path. It intentionally
 * errs on the safe side; unsupported/invalid expressions should be edited
 * rather than allowed to stall the UI.
 */

/** Keep this in sync with the editor/execution policy. */
export const MAX_SAFE_REGEX_PATTERN_LENGTH = 200;

interface GroupFrame {
  hasQuantifier: boolean;
}

function isQuantifierStart(pattern: string, index: number, previousWasAtom: boolean): number {
  const char = pattern[index];
  if (char === '*' || char === '+') return previousWasAtom ? 1 : 0;
  if (char === '?') {
    // `?` directly after `(` belongs to a non-capturing/lookaround group,
    // not to the group body. Elsewhere it is a quantifier only after an atom.
    return previousWasAtom && pattern[index - 1] !== '(' ? 1 : 0;
  }
  if (char !== '{' || !previousWasAtom) return 0;
  const rest = pattern.slice(index);
  return /^\{\d+(?:,\d*)?\}/.test(rest) ? rest.match(/^\{\d+(?:,\d*)?\}/)![0].length : 0;
}

/**
 * Return whether a pattern is valid and avoids nested quantifiers.
 * This is a policy check, not a complete regex complexity proof.
 */
export function isSafeRegexPattern(pattern: string): boolean {
  if (typeof pattern !== 'string' || pattern.length > MAX_SAFE_REGEX_PATTERN_LENGTH) return false;
  try {
    // Validate syntax up front. Execution sites still construct their own
    // RegExp so this helper remains side-effect free.
    new RegExp(pattern);
  } catch {
    return false;
  }

  const groups: GroupFrame[] = [];
  let escaped = false;
  let inClass = false;
  let previousWasAtom = false;
  let closedGroupHasQuantifier = false;

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (escaped) {
      escaped = false;
      previousWasAtom = true;
      closedGroupHasQuantifier = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (inClass) {
      if (char === ']') inClass = false;
      previousWasAtom = true;
      closedGroupHasQuantifier = false;
      continue;
    }
    if (char === '[') {
      inClass = true;
      previousWasAtom = true;
      closedGroupHasQuantifier = false;
      continue;
    }
    if (char === '(') {
      groups.push({ hasQuantifier: false });
      previousWasAtom = false;
      closedGroupHasQuantifier = false;
      continue;
    }
    if (char === ')') {
      const frame = groups.pop();
      if (!frame) return false;
      // A quantified child is part of the parent group's complexity even when
      // the child itself was not quantified as a whole.
      if (groups.length > 0 && frame.hasQuantifier) groups[groups.length - 1].hasQuantifier = true;
      previousWasAtom = true;
      closedGroupHasQuantifier = frame.hasQuantifier;
      continue;
    }

    const quantifierLength = isQuantifierStart(pattern, index, previousWasAtom);
    if (quantifierLength > 0) {
      if (closedGroupHasQuantifier) return false;
      if (groups.length > 0) groups[groups.length - 1].hasQuantifier = true;
      previousWasAtom = true;
      closedGroupHasQuantifier = false;
      index += quantifierLength - 1;
      continue;
    }

    // Group modifiers (`?:`, `?=`, `?!`, `?<name>`) and alternation do not
    // create an atom. Everything else is an ordinary atom or anchor.
    if (char !== '|' && !(char === '?' && !previousWasAtom)) previousWasAtom = true;
    closedGroupHasQuantifier = false;
  }

  return groups.length === 0;
}

/** Avoid accidentally running a rejected expression in an execution path. */
export function tryCreateSafeRegex(pattern: string, flags?: string): RegExp | null {
  if (!isSafeRegexPattern(pattern)) return null;
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}
