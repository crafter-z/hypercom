/**
 * Pure auto-follow helpers for the terminal scroll-lock system (DOM-free).
 *
 * Extracted from TerminalView so the follow/gesture predicates can be
 * unit-tested under vitest's `environment: 'node'` config (no jsdom).
 * None of these functions touch the DOM or stores — they are plain
 * geometry/boolean transforms over numbers.
 */

/** Tolerance (px) absorbing virtualizer layout lag in the settle check. */
export const FOLLOW_TOLERANCE = 50;

/**
 * True when the viewport is within `tolerance` px of the scroll bottom.
 * Exactly-at-tolerance (`scrollTop + clientHeight === scrollHeight - tolerance`)
 * counts as bottom so the settle check does not flick the lock off when the
 * residual gap is pure measurement lag.
 */
export function isAtBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  tolerance = FOLLOW_TOLERANCE,
): boolean {
  return scrollTop + clientHeight >= scrollHeight - tolerance;
}

/**
 * Whether auto-follow may run: not paused (frozen view), follow engaged,
 * no active user gesture, and no open search bar. The follow *pin target*
 * itself is computed inline in `TerminalRenderer.render` (padding-aware
 * same-frame pin) — there is no pure-function indirection for it because the
 * renderer already owns the container geometry at that point.
 */
export function shouldFollow(
  paused: boolean,
  follow: boolean,
  gestureActive: boolean,
  searchOpen: boolean,
): boolean {
  return !paused && follow && !gestureActive && !searchOpen;
}
