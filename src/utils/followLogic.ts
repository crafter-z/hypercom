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
 * The `scrollTop` value that pins the viewport flush to the bottom.
 * Clamped to 0 — when the content is shorter than the viewport the browser
 * would clamp an overshooting assignment anyway, so return the legal value.
 */
export function computePinTarget(scrollHeight: number, clientHeight: number): number {
  return Math.max(0, scrollHeight - clientHeight);
}

/**
 * Edge detection for the lock→engage transition.
 *
 * `prev === undefined` is the first observation (tab remount of an
 * already-locked tab) — treat the mount value as a transition so the view
 * jumps to the latest row immediately. Otherwise only the false→true
 * transition fires; true→true and true→false never pin.
 */
export function becameLocked(prev: boolean | undefined, locked: boolean): boolean {
  return prev === undefined ? locked : locked && !prev;
}

/**
 * Whether auto-follow may run: not paused (frozen view), follow engaged,
 * no active user gesture, and no open search bar.
 */
export function shouldFollow(
  paused: boolean,
  follow: boolean,
  gestureActive: boolean,
  searchOpen: boolean,
): boolean {
  return !paused && follow && !gestureActive && !searchOpen;
}
