export interface ReplayClockSnapshot {
  timeMs: number;
  playing: boolean;
  speed: number;
}
export interface ReplayClockOptions {
  startTimeMs: number;
  endTimeMs: number;
  now?: () => number;
  onTick?: (timeMs: number) => void;
  schedule?: (callback: () => void) => unknown;
  cancel?: (id: unknown) => void;
}
/** One monotonic transport for a whole replay session; gaps are never truncated. */
export class ReplayClock {
  private originTime: number;
  private originNow: number;
  private playing = false;
  private speed = 1;
  private frame: unknown;
  private disposed = false;
  private snapshot: ReplayClockSnapshot;
  private listeners = new Set<() => void>();
  private readonly now: () => number;
  private readonly schedule: (callback: () => void) => unknown;
  private readonly cancel: (id: unknown) => void;
  constructor(private readonly options: ReplayClockOptions) {
    if (
      !Number.isFinite(options.startTimeMs) ||
      !Number.isFinite(options.endTimeMs) ||
      options.endTimeMs < options.startTimeMs
    )
      throw new Error('Invalid replay range');
    this.now = options.now ?? (() => performance.now());
    this.schedule =
      options.schedule ??
      ((cb) =>
        typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame(cb)
          : setTimeout(cb, 16));
    this.cancel =
      options.cancel ??
      ((id) =>
        typeof cancelAnimationFrame === 'function'
          ? cancelAnimationFrame(id as number)
          : clearTimeout(id as ReturnType<typeof setTimeout>));
    this.originTime = options.startTimeMs;
    this.originNow = this.now();
    this.snapshot = { timeMs: this.originTime, playing: false, speed: 1 };
  }
  getSnapshot = (): ReplayClockSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private current(): number {
    return Math.min(
      this.options.endTimeMs,
      Math.max(
        this.options.startTimeMs,
        this.originTime +
          (this.playing
            ? Math.max(0, this.now() - this.originNow) * this.speed
            : 0),
      ),
    );
  }
  private settle(): void {
    this.originTime = this.current();
    this.originNow = this.now();
  }
  private publish(): void {
    this.snapshot = {
      timeMs: this.current(),
      playing: this.playing,
      speed: this.speed,
    };
    this.options.onTick?.(this.snapshot.timeMs);
    for (const listener of this.listeners) listener();
  }
  private request(): void {
    if (this.frame !== undefined || !this.playing || this.disposed) return;
    this.frame = this.schedule(() => {
      this.frame = undefined;
      this.tick();
      this.request();
    });
  }
  tick(): void {
    if (this.disposed) return;
    if (this.current() >= this.options.endTimeMs) {
      this.settle();
      this.playing = false;
    }
    this.publish();
  }
  play(): void {
    if (
      this.disposed ||
      this.playing ||
      this.current() >= this.options.endTimeMs
    )
      return;
    this.originNow = this.now();
    this.playing = true;
    this.publish();
    this.request();
  }
  pause(): void {
    if (this.disposed || !this.playing) return;
    this.settle();
    this.playing = false;
    if (this.frame !== undefined) this.cancel(this.frame);
    this.frame = undefined;
    this.publish();
  }
  seek(timeMs: number): void {
    if (this.disposed || !Number.isFinite(timeMs)) return;
    this.originTime = Math.max(
      this.options.startTimeMs,
      Math.min(this.options.endTimeMs, timeMs),
    );
    this.originNow = this.now();
    if (this.originTime === this.options.endTimeMs) this.playing = false;
    this.publish();
    this.request();
  }
  setSpeed(speed: number): void {
    if (!Number.isFinite(speed) || speed <= 0)
      throw new Error('Replay speed must be finite and positive');
    if (this.disposed) return;
    this.settle();
    this.speed = speed;
    this.publish();
  }
  dispose(): void {
    if (this.disposed) return;
    this.settle();
    this.playing = false;
    this.disposed = true;
    if (this.frame !== undefined) this.cancel(this.frame);
    this.frame = undefined;
    this.listeners.clear();
  }
}
