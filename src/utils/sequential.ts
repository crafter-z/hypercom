/**
 * Run an async action over a list, one item at a time, with a fixed gap between
 * items.
 *
 * The spacing is a backend constraint, not a cosmetic one: opening/closing
 * several serial ports back-to-back has them race for the same OS handle and
 * the Rust side serialises on the manager lock anyway, so the batch
 * "connect all" / "disconnect all" paths must not fire in parallel. The sidebar
 * port rack and the pane tab bar each grew their own copy of this loop.
 *
 * Errors from `action` propagate — the caller decides whether one failing port
 * aborts the batch. The gap is only inserted between items, so a batch never
 * ends with a trailing idle sleep.
 */
export async function runSequential<T>(
  items: readonly T[],
  action: (item: T) => void | Promise<void>,
  gapMs = 100,
): Promise<void> {
  for (let i = 0; i < items.length; i++) {
    if (i > 0 && gapMs > 0) {
      // `Promise.withResolvers()` would be tidier but the project's `lib` is
      // ES2020 (tsconfig), where it does not typecheck.
      await new Promise((resolve) => setTimeout(resolve, gapMs));
    }
    await action(items[i]);
  }
}
