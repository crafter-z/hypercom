/** Explicit-intent navigation lifecycle. Raw scroll can sample an existing
 * gesture, but can never acquire ownership or change independent follow. */
export interface NavigationLifecycleOptions<A> {
  readAnchor: () => A | null;
  readScrollTop: () => number;
  onBegin: () => void;
  onPreview: (anchor: A) => void;
  onCommit: (anchor: A) => void;
  onCancel: () => void;
  /** A different participant may preempt this local gesture before quiet settle. */
  isCurrent?: () => boolean;
  /** Only unreadable/hidden geometry may fall back; unknown event time cannot drive. */
  canUseLastAnchor?: () => boolean;
  quietMs?: number;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (id: number) => void;
}

export class TerminalNavigationLifecycle<A> {
  private active = false;
  private held = false;
  private pointerId: number | null = null;
  private moved = false;
  private disposed = false;
  private generation = 0;
  private lastTop = 0;
  private lastAnchor: A | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private frame: number | null = null;
  private readonly requestFrame: (callback: FrameRequestCallback) => number;
  private readonly cancelFrame: (id: number) => void;

  constructor(private readonly options: NavigationLifecycleOptions<A>) {
    // Browser Web IDL methods require Window as receiver; storing the unbound
    // native function and invoking it as this.requestFrame() throws Illegal invocation.
    this.requestFrame = options.requestFrame ?? (callback => requestAnimationFrame(callback));
    this.cancelFrame = options.cancelFrame ?? (id => cancelAnimationFrame(id));
  }

  /** Wheel/keys have quiet-settle semantics; native scrollbar holds until release. */
  begin(pointerId?: number): void {
    if (this.disposed) return;
    if (this.active && this.options.isCurrent?.() === false) this.cancel();
    if (!this.active) {
      this.active = true;
      this.generation++;
      this.lastTop = this.options.readScrollTop();
      this.lastAnchor = null;
      this.moved = false;
      this.options.onBegin();
    }
    if (pointerId !== undefined) {
      this.held = true;
      this.pointerId = pointerId;
    }
    clearTimeout(this.timer);
    if (!this.held) this.scheduleEnd();
  }

  /** Called only for actual geometry changes; programmatic/unknown scrolls do not drive. */
  scroll(): void {
    if (!this.active || this.disposed) return;
    const top = this.options.readScrollTop();
    if (top === this.lastTop) return; // horizontal scroll, resize notification, etc.
    this.lastTop = top;
    this.moved = true;
    this.sampleNextFrame();
    if (!this.held) this.scheduleEnd();
  }

  release(pointerId?: number): void {
    if (!this.active || this.disposed) return;
    if (pointerId !== undefined && this.pointerId !== null && pointerId !== this.pointerId) return;
    this.held = false;
    this.pointerId = null;
    // Allow a last browser scroll after pointerup, then read final geometry in rAF.
    this.scroll();
    this.sampleNextFrame();
    this.scheduleEnd();
  }

  /** Search/jump is explicit navigation whose local seek has already been applied. */
  commitPosition(): void {
    if (this.disposed) return;
    this.begin();
    this.moved = true;
    this.held = false;
    this.scheduleEnd();
    this.sampleNextFrame();
  }

  private sampleNextFrame(): void {
    if (this.frame !== null) return;
    const generation = this.generation;
    this.frame = this.requestFrame(() => {
      this.frame = null;
      if (!this.active || this.disposed || generation !== this.generation) return;
      const anchor = this.options.readAnchor();
      if (anchor !== null) {
        this.lastAnchor = anchor;
        if (this.moved) this.options.onPreview(anchor);
      }
    });
  }

  private scheduleEnd(): void {
    clearTimeout(this.timer);
    const generation = this.generation;
    this.timer = setTimeout(() => {
      if (!this.active || this.held || this.disposed || generation !== this.generation) return;
      if (this.frame !== null) this.cancelFrame(this.frame);
      this.frame = this.requestFrame(() => {
        this.frame = null;
        if (!this.active || this.disposed || generation !== this.generation) return;
        const anchor = this.options.readAnchor() ?? (this.options.canUseLastAnchor?.() !== false ? this.lastAnchor : null);
        this.active = false;
        this.lastAnchor = null;
        if (this.moved && anchor !== null) this.options.onCommit(anchor);
        else this.options.onCancel();
      });
    }, this.options.quietMs ?? 120);
  }

  /** Closing/hiding/changing source invalidates without submitting stale geometry. */
  cancel(): void {
    clearTimeout(this.timer);
    if (this.frame !== null) this.cancelFrame(this.frame);
    this.frame = null;
    this.generation++;
    const wasActive = this.active;
    this.active = false;
    this.held = false;
    this.pointerId = null;
    this.lastAnchor = null;
    if (wasActive) this.options.onCancel();
  }

  dispose(): void {
    this.cancel();
    this.disposed = true;
  }
}
