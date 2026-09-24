/**
 * Portable filmstrip capture pump (design spec decision 5): camera track →
 * an off-document `<video>` element → `createImageBitmap` at the sample
 * period. This REPLACES Presence's `MediaStreamTrackProcessor` +
 * transferred-`ReadableStream` pump (`video-filmstrip.ts`'s
 * `_sendTrackToWorker`), which WebKitGTK does not implement.
 *
 * An `ImageBitmap` — not a stream — is what crosses into the worker, so the
 * worker's protocol is one `frame` message per sample.
 *
 * Constrains: src/filmstrip-carrier.ts (its only caller in this package).
 */

/**
 * Injectable interval timers. The default is `globalThis`, so production
 * uses the platform timers and a test can install fake ones (the lookup
 * happens at call time).
 */
export interface SamplerTimers {
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
}

export class FilmstripSampler {
  private video: HTMLVideoElement | null = null;

  /**
   * The live interval id. Typed off `setInterval` itself rather than as
   * `number` because the package typechecks with and without the Node
   * globals in scope (the test config pulls them in via vitest).
   */
  private timer: ReturnType<typeof globalThis.setInterval> | null = null;

  private periodMs = 167;

  /**
   * True while a `createImageBitmap` is in flight — a tick that lands on a
   * busy sampler is skipped rather than queued, so a slow capture cannot
   * build a backlog.
   */
  private busy = false;

  private onSample: ((bitmap: ImageBitmap, t0: number) => void) | null = null;

  /**
   * Open the track in a detached `<video>` and start sampling it every
   * `periodMs`. Resolves false (never rejects) when the environment cannot
   * sample or the element refuses to play — the caller's failure arm is what
   * releases the camera handle, and a rejection would skip it.
   */
  async start(
    track: MediaStreamTrack,
    periodMs: number,
    onSample: (bitmap: ImageBitmap, t0: number) => void,
    timers: SamplerTimers = globalThis
  ): Promise<boolean> {
    if (typeof document === 'undefined' || !globalThis.createImageBitmap) {
      console.error('filmstrip: needs a document and createImageBitmap');
      return false;
    }
    this.stop(timers);
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.srcObject = new MediaStream([track]);
    try {
      await v.play();
    } catch (e) {
      console.error('filmstrip: video.play failed', e);
      return false;
    }
    this.video = v;
    this.periodMs = periodMs;
    this.onSample = onSample;
    this.timer = timers.setInterval(() => this._tick(), this.periodMs);
    return true;
  }

  /** Re-arm the running interval at a new period. No-op when not started. */
  setPeriod(ms: number, timers: SamplerTimers = globalThis): void {
    this.periodMs = ms;
    if (this.timer === null) return;
    timers.clearInterval(this.timer);
    this.timer = timers.setInterval(() => this._tick(), this.periodMs);
  }

  /**
   * Device change: re-point the SAME element at the new track. The interval,
   * the period and the callback all continue uninterrupted.
   */
  replaceTrack(track: MediaStreamTrack): void {
    if (!this.video) return;
    this.video.srcObject = new MediaStream([track]);
    this.video.play().catch(() => {});
  }

  stop(timers: SamplerTimers = globalThis): void {
    if (this.timer !== null) {
      timers.clearInterval(this.timer);
      this.timer = null;
    }
    if (this.video) {
      this.video.pause();
      this.video.srcObject = null;
      this.video = null;
    }
    this.onSample = null;
    this.busy = false;
  }

  private _tick(): void {
    if (this.busy || !this.video || this.video.videoWidth === 0) return;
    const onSample = this.onSample;
    if (!onSample) return;
    this.busy = true;
    // Wall clock, deliberately: `t0` is the cross-carrier sender timebase
    // that voice frames stamp as `wts` (see FilmstripClipPayload.t0).
    const t0 = Date.now();
    createImageBitmap(this.video).then(
      b => {
        this.busy = false;
        onSample(b, t0);
      },
      () => {
        this.busy = false;
      }
    );
  }
}
