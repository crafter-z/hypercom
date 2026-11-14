/**
 * Conservative guard for user-authored regular expressions.
 *
 * JavaScript's RegExp engine is synchronous and offers no execution timeout.
 * Limiting pattern/input length therefore does not stop nested-quantifier
 * backtracking (for example `(a+)+$` or `(a|aa)+$`). This parser rejects the
 * common exponential shapes before a pattern reaches the hot RX path. It intentionally
 * errs on the safe side; unsupported/invalid expressions should be edited
 * rather than allowed to stall the UI.
 */

/** Keep this in sync with the editor/execution policy. */
export const MAX_SAFE_REGEX_PATTERN_LENGTH = 200;

interface GroupFrame {
  hasQuantifier: boolean;
  hasAlternation: boolean;
}

interface QuantifierInfo {
  length: number;
  /** An unbounded repetition (`*`, `+`, `{n,}`) can backtrack exponentially
   * when its atom is an alternation with overlapping branches. */
  unbounded: boolean;
}

function quantifierInfo(pattern: string, index: number, previousWasAtom: boolean): QuantifierInfo | null {
  const char = pattern[index];
  if (char === '*' || char === '+') return previousWasAtom ? { length: 1, unbounded: true } : null;
  if (char === '?') {
    // `?` directly after `(` belongs to a non-capturing/lookaround group,
    // not to the group body. Elsewhere it is a quantifier only after an atom.
    return previousWasAtom && pattern[index - 1] !== '(' ? { length: 1, unbounded: false } : null;
  }
  if (char !== '{' || !previousWasAtom) return null;
  const match = /^\{(\d+)(?:,(\d*))?\}/.exec(pattern.slice(index));
  if (!match) return null;
  return {
    length: match[0].length,
    // A missing upper bound is the only unbounded brace form. Finite ranges
    // have a bounded amount of backtracking and remain supported.
    unbounded: match[2] !== undefined && match[2] === '',
  };
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
  let closedGroupHasAlternation = false;

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (escaped) {
      escaped = false;
      previousWasAtom = true;
      closedGroupHasQuantifier = false;
      closedGroupHasAlternation = false;
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
      closedGroupHasAlternation = false;
      continue;
    }
    if (char === '[') {
      inClass = true;
      previousWasAtom = true;
      closedGroupHasQuantifier = false;
      closedGroupHasAlternation = false;
      continue;
    }
    if (char === '(') {
      groups.push({ hasQuantifier: false, hasAlternation: false });
      previousWasAtom = false;
      closedGroupHasQuantifier = false;
      closedGroupHasAlternation = false;
      continue;
    }
    if (char === ')') {
      const frame = groups.pop();
      if (!frame) return false;
      // A quantified child or an alternation is part of the parent group's
      // complexity even when the child itself was not quantified as a whole.
      if (groups.length > 0) {
        if (frame.hasQuantifier) groups[groups.length - 1].hasQuantifier = true;
        if (frame.hasAlternation) groups[groups.length - 1].hasAlternation = true;
      }
      previousWasAtom = true;
      closedGroupHasQuantifier = frame.hasQuantifier;
      closedGroupHasAlternation = frame.hasAlternation;
      continue;
    }

    const quantifier = quantifierInfo(pattern, index, previousWasAtom);
    if (quantifier) {
      // Existing nested-quantifier guard, plus the common overlapping-
      // alternation shape such as `(a|aa)+$`. The latter has no nested
      // quantifier but still causes exponential backtracking on a long near
      // miss. Finite `{n,m}` repetitions stay allowed.
      if (closedGroupHasQuantifier || (quantifier.unbounded && closedGroupHasAlternation)) return false;
      if (groups.length > 0) groups[groups.length - 1].hasQuantifier = true;
      previousWasAtom = true;
      closedGroupHasQuantifier = false;
      closedGroupHasAlternation = false;
      index += quantifier.length - 1;
      continue;
    }

    // Group modifiers (`?:`, `?=`, `?!`, `?<name>`) and alternation do not
    // create an atom. Everything else is an ordinary atom or anchor.
    if (char === '|') {
      if (groups.length > 0) groups[groups.length - 1].hasAlternation = true;
      previousWasAtom = false;
    } else if (!(char === '?' && !previousWasAtom)) {
      previousWasAtom = true;
    }
    closedGroupHasQuantifier = false;
    closedGroupHasAlternation = false;
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
