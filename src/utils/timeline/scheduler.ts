import { TIMELINE_BUDGET, type TimelinePhase } from './types';

export interface TimelineTask {
  phase: TimelinePhase;
  epoch: number;
  sequence: number;
  run(signal: AbortSignal): Promise<void> | void;
  valid(): boolean;
  settled?(elapsedMs: number, error?: unknown): void;
  slow?(): void;
}
interface Lane {
  pending?: TimelineTask;
  active?: {
    task: TimelineTask;
    abort: AbortController;
    timer: ReturnType<typeof setTimeout>;
  };
  lastStarted: number;
  interval: number;
  enabled: boolean;
}
export interface TimelineSchedulerOptions {
  now?: () => number;
  schedule?: (callback: () => void) => unknown;
  cancel?: (id: unknown) => void;
  changed?: () => void;
}
/** Admission control only: a timed-out JS callback remains in flight until it really settles. */
export class TimelineScheduler {
  private lanes = new Map<string, Lane>();
  private frame: unknown;
  private wake?: ReturnType<typeof setTimeout>;
  private cursor = 0;
  private readonly now: () => number;
  private readonly schedule: (callback: () => void) => unknown;
  private readonly cancel: (id: unknown) => void;
  private foreground = true;
  private pressure = 0;
  private lastFrame?: number;
  private previewPaused = false;
  private disposed = false;
  private probe: unknown;
  private probeLast?: number;
  private gestures = new Set<string>();
  constructor(private options: TimelineSchedulerOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.schedule =
      options.schedule ??
      ((cb) =>
        typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame(cb)
          : setTimeout(cb, 0));
    this.cancel =
      options.cancel ??
      ((id) =>
        typeof cancelAnimationFrame === 'function'
          ? cancelAnimationFrame(id as number)
          : clearTimeout(id as ReturnType<typeof setTimeout>));
  }
  enqueue(id: string, task: TimelineTask): void {
    if (this.disposed) return;
    let lane = this.lanes.get(id);
    if (!lane) {
      lane = {
        lastStarted: -Infinity,
        interval: 1000 / TIMELINE_BUDGET.previewHz,
        enabled: true,
      };
      this.lanes.set(id, lane);
    }
    const pending = lane.pending;
    if (
      pending &&
      (pending.epoch > task.epoch ||
        (pending.epoch === task.epoch &&
          pending.phase === 'commit' &&
          task.phase === 'preview'))
    )
      return;
    lane.pending = task;
    if (
      lane.active &&
      (lane.active.task.epoch !== task.epoch ||
        (task.phase === 'commit' && lane.active.task.phase === 'preview'))
    )
      lane.active.abort.abort();
    this.options.changed?.();
    this.request();
  }
  state(id: string): { pending: boolean; inFlight: boolean } {
    const lane = this.lanes.get(id);
    return { pending: !!lane?.pending, inFlight: !!lane?.active };
  }
  setEnabled(id: string, enabled: boolean): void {
    const lane = this.lanes.get(id);
    if (lane) {
      lane.enabled = enabled;
      if (!enabled) lane.active?.abort.abort();
    }
    if (enabled) this.request();
  }
  dropPendingPreview(id: string): void {
    const lane = this.lanes.get(id);
    if (lane?.pending?.phase === 'preview') lane.pending = undefined;
  }
  setPreviewInterval(id: string, interval: number): void {
    const lane = this.lanes.get(id);
    if (lane) lane.interval = interval;
  }
  invalidate(id: string): void {
    const lane = this.lanes.get(id);
    if (!lane) return;
    lane.pending = undefined;
    lane.active?.abort.abort();
    this.options.changed?.();
  }
  remove(id: string): void {
    const lane = this.lanes.get(id);
    if (!lane) return;
    lane.active?.abort.abort();
    if (lane.active) clearTimeout(lane.active.timer);
    this.lanes.delete(id);
    this.options.changed?.();
  }
  beginGesture(id = 'default'): void {
    this.gestures.add(id);
    this.pressure = 0;
    this.previewPaused = false;
    for (const lane of this.lanes.values())
      lane.interval = 1000 / TIMELINE_BUDGET.previewHz;
    this.requestProbe();
  }
  endGesture(id = 'default'): void {
    this.gestures.delete(id);
    if (!this.gestures.size && this.probe !== undefined) {
      this.cancel(this.probe);
      this.probe = undefined;
      this.probeLast = undefined;
    }
  }
  private requestProbe(): void {
    if (
      this.probe !== undefined ||
      !this.gestures.size ||
      this.disposed ||
      typeof requestAnimationFrame !== 'function'
    )
      return;
    this.probe = this.schedule(() => {
      this.probe = undefined;
      const now = this.now();
      const foreground =
        this.foreground &&
        (typeof document === 'undefined' ||
          document.visibilityState !== 'hidden');
      if (foreground && this.probeLast !== undefined) {
        const before = this.previewPaused;
        this.observeFrame(now - this.probeLast);
        if (before !== this.previewPaused) this.options.changed?.();
      }
      this.probeLast = foreground ? now : undefined;
      this.requestProbe();
    });
  }
  observeFrame(intervalMs: number, foreground = true): void {
    if (!foreground) return;
    this.lastFrame = intervalMs;
    this.pressure =
      intervalMs > TIMELINE_BUDGET.frameMs * 1.5 ? this.pressure + 1 : 0;
    if (this.pressure >= TIMELINE_BUDGET.pressureFrames)
      this.previewPaused = true;
  }
  setForeground(value: boolean): void {
    this.foreground = value;
    if (value) this.request();
  }
  get previewsPaused(): boolean {
    return this.previewPaused;
  }
  private request(): void {
    if (this.frame !== undefined || this.disposed) return;
    this.frame = this.schedule(() => {
      this.frame = undefined;
      this.flush();
    });
  }
  flush(): void {
    if (this.disposed) return;
    const entries = [...this.lanes.entries()];
    if (!entries.length) return;
    const start = this.now();
    const budget = Math.min(
      TIMELINE_BUDGET.batchMs,
      (this.lastFrame ?? TIMELINE_BUDGET.frameMs) *
        TIMELINE_BUDGET.frameFraction,
    );
    let wait = Infinity;
    let controls = 0;
    const startCursor = this.cursor;
    for (let i = 0; i < entries.length; i++) {
      const index = (startCursor + i) % entries.length;
      const [id, lane] = entries[index];
      const task = lane.pending;
      if (!task || lane.active || !lane.enabled) continue;
      if (!task.valid()) {
        lane.pending = undefined;
        continue;
      }
      if (
        task.phase === 'commit' &&
        (controls >= TIMELINE_BUDGET.controlPerBatch ||
          (controls > 0 && this.now() - start >= budget))
      ) {
        wait = 0;
        break;
      }
      if (task.phase === 'preview') {
        if (
          !this.foreground ||
          (typeof document !== 'undefined' &&
            document.visibilityState === 'hidden') ||
          this.previewPaused
        ) {
          lane.pending = undefined;
          continue;
        }
        const remaining = lane.interval - (this.now() - lane.lastStarted);
        if (remaining > 0) {
          wait = Math.min(wait, remaining);
          continue;
        }
        if (this.now() - start >= budget) {
          wait = 0;
          break;
        }
      }
      if (task.phase === 'commit') controls++;
      lane.pending = undefined;
      lane.lastStarted = this.now();
      this.cursor = (index + 1) % entries.length;
      const abort = new AbortController();
      const active = {
        task,
        abort,
        timer: setTimeout(
          () => {
            if (lane.active === active) {
              if (task.phase === 'preview') active.abort.abort();
              task.slow?.();
              this.options.changed?.();
            }
          },
          task.phase === 'preview'
            ? TIMELINE_BUDGET.previewSlowMs
            : TIMELINE_BUDGET.commitSlowMs,
        ),
      };
      lane.active = active;
      this.options.changed?.();
      let result: Promise<void>;
      try {
        result = Promise.resolve(task.run(abort.signal));
      } catch (error) {
        result = Promise.reject(error);
      }
      void result.then(
        () => finish(),
        (error) => finish(error),
      );
      const finish = (error?: unknown) => {
        clearTimeout(active.timer);
        if (lane.active !== active) return;
        lane.active = undefined;
        if (this.lanes.get(id) !== lane) return;
        task.settled?.(Math.max(0, this.now() - lane.lastStarted), error);
        this.options.changed?.();
        this.request();
      };
    }
    if (wait !== Infinity && !this.wake)
      this.wake = setTimeout(
        () => {
          this.wake = undefined;
          this.request();
        },
        Math.max(1, wait),
      );
  }
  dispose(): void {
    this.disposed = true;
    if (this.probe !== undefined) this.cancel(this.probe);
    this.probe = undefined;
    this.gestures.clear();
    if (this.frame !== undefined) this.cancel(this.frame);
    if (this.wake) clearTimeout(this.wake);
    for (const id of this.lanes.keys()) this.remove(id);
  }
}
