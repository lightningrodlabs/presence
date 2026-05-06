import { LitElement, html, css, PropertyValues } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import {
  filmstripController,
  FilmstripFrame,
} from '../modules/video-filmstrip';

/**
 * Self-updating filmstrip overlay for one peer with a playback jitter
 * buffer.
 *
 * On clip arrival, push that clip's N frames onto a queue. A single
 * setTimeout chain pops one frame every period and displays it,
 * regardless of when clips arrive. This decouples display timing from
 * receive timing — the visible playback is at constant cadence even
 * when clip arrivals jitter.
 *
 * Trade-off: latency. Initial playback waits for `BUFFER_CLIPS` clips
 * to accumulate so a slow clip arrival doesn't underrun immediately.
 * After playback has started, underrun (queue drains before the next
 * clip arrives) freezes on the last frame; the next clip arrival
 * resumes playback immediately (no re-buffering).
 *
 * Buffer cap: if clips arrive faster than they're consumed (e.g. signal
 * burst after a network gap), drop OLDEST frames first so the latency
 * doesn't grow unbounded.
 *
 * Positioned `position: absolute; inset: 0` so the parent video-container
 * mounts it as an overlay; the .strip is transparent until the first
 * frame is displayed, so the avatar shows through until then.
 */

/**
 * Initial buffer depth, in clips. Setting playback to start once we
 * have BUFFER_CLIPS clips' worth of frames means the queue stays around
 * (BUFFER_CLIPS - 1) clips deep in steady state, giving us up to
 * (BUFFER_CLIPS - 1) clip-cadence-worth of clip-arrival jitter
 * tolerance before underrun. With a 1 s clip cadence, BUFFER_CLIPS = 2
 * absorbs ~1 s of jitter at the cost of ~1 s of added startup latency.
 */
const BUFFER_CLIPS = 2;

/**
 * Hard cap on queue depth, in clips. Drops oldest frames if exceeded.
 * Prevents unbounded growth from sender bursts (e.g. clips queued by a
 * network gap arrive together).
 */
const MAX_BUFFER_CLIPS = 4;

interface QueuedFrame {
  url: string;
  index: number;
  count: number;
  periodMs: number;
}

@customElement('peer-filmstrip')
export class PeerFilmstrip extends LitElement {
  @property({ type: String })
  agentPubKeyB64 = '';

  private _queue: QueuedFrame[] = [];
  private _started = false;
  private _animTimer: number | null = null;
  private _unsubscribe: (() => void) | null = null;

  static styles = css`
    :host {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      display: block;
      /* Match the parent video-container's frame so the filmstrip is
         clipped to the same shape as the WebRTC <video> would be (circle
         in circle view, rounded square in square view). The base
         .video-container class is overflow: visible in circle view and
         applies border-radius: 50% to the <video> directly, so we have
         to do equivalent clipping on the host ourselves. */
      border-radius: inherit;
      overflow: hidden;
      /* No explicit z-index — document order already puts us above the
         avatar (rendered before us) and below the connection-detail
         overlay, maximize icon, and tile-meta (rendered after us). An
         explicit z-index would lift us over those un-z-indexed siblings. */
    }
    .strip {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background-repeat: no-repeat;
      background-position: 0 0;
      /* background-size set inline as 100% × (N*100)% so each of the N
         frames fills the strip when its background-position-y is at
         that frame's offset. Source frames are square so this matches
         the square peer pane without aspect distortion. */
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    this._subscribe();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this._teardown();
  }

  willUpdate(changed: PropertyValues): void {
    if (changed.has('agentPubKeyB64')) {
      this._teardown();
      this._subscribe();
    }
  }

  private _subscribe(): void {
    if (!this.agentPubKeyB64) return;
    this._unsubscribe = filmstripController.subscribe(
      this.agentPubKeyB64,
      (frame) => this._onFrame(frame),
    );
  }

  private _teardown(): void {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
    if (this._animTimer !== null) {
      window.clearTimeout(this._animTimer);
      this._animTimer = null;
    }
    this._queue = [];
    this._started = false;
    // Clear the imperative bg-image so a stale image from a previous
    // peer doesn't linger if `agentPubKeyB64` is reassigned without an
    // immediate replay-subscribe.
    const el = this.renderRoot?.querySelector?.('.strip') as HTMLDivElement | null;
    if (el) el.style.backgroundImage = '';
  }

  private async _onFrame(frame: FilmstripFrame | null): Promise<void> {
    // null = sender stopped (explicit stop signal or inactivity TTL).
    // Drain the queue, stop animation, clear bg-image so the avatar
    // shows through.
    if (frame === null) {
      if (this._animTimer !== null) {
        window.clearTimeout(this._animTimer);
        this._animTimer = null;
      }
      this._queue = [];
      this._started = false;
      const el = this.renderRoot.querySelector('.strip') as HTMLDivElement | null;
      if (el) el.style.backgroundImage = '';
      filmstripController.setBufferDepth(this.agentPubKeyB64, 0);
      return;
    }

    // Pre-decode the new JPEG so when we swap the bg-image the browser
    // already has the pixel data ready and the swap is atomic. Without
    // this, the swap can paint an empty bg for one frame while the new
    // image decodes (visible as an avatar-flash through the host).
    try {
      const probe = new Image();
      probe.src = frame.url;
      await probe.decode();
    } catch {
      // Decode rejected (rare — corrupt JPEG, revoked URL). Fall through.
    }
    // The element may have been unmounted while we awaited decode.
    if (!this._unsubscribe) return;

    // Push N entries (one per frame) into the queue. The setTimeout
    // chain consumes them at periodMs intervals.
    for (let i = 0; i < frame.frameCount; i++) {
      this._queue.push({
        url: frame.url,
        index: i,
        count: frame.frameCount,
        periodMs: frame.periodMs,
      });
    }

    // Cap the queue depth — drop oldest if a sender burst pushed us
    // over MAX_BUFFER_CLIPS. Preferring to lose old frames keeps the
    // displayed video as close to real-time as the cap allows.
    const max = MAX_BUFFER_CLIPS * frame.frameCount;
    while (this._queue.length > max) {
      this._queue.shift();
    }

    // Publish buffer depth to the controller's stats so the panel /
    // console log can show it.
    filmstripController.setBufferDepth(this.agentPubKeyB64, this._queue.length);

    if (!this._started) {
      // Initial buffering: wait for BUFFER_CLIPS clips before the first
      // frame is displayed. Adds startup latency, gains jitter tolerance.
      const target = BUFFER_CLIPS * frame.frameCount;
      if (this._queue.length >= target) {
        this._started = true;
        this._popAndSchedule();
      }
    } else if (this._animTimer === null) {
      // Resuming after underrun. Don't re-buffer — the user has already
      // seen the freeze; pushing them through more wait is worse than
      // resuming with whatever just arrived.
      this._popAndSchedule();
    }
  }

  /**
   * Pop one frame from the queue, display it, and schedule the next
   * tick. If the queue is empty, leave the timer null so a new clip's
   * `_onFrame` can resume playback. The displayed frame stays on
   * screen during the underrun (frozen on last shown frame).
   */
  private _popAndSchedule(): void {
    const next = this._queue.shift();
    if (!next) return;
    this._applyFrame(next);
    filmstripController.setBufferDepth(this.agentPubKeyB64, this._queue.length);
    this._animTimer = window.setTimeout(() => {
      this._animTimer = null;
      this._popAndSchedule();
    }, next.periodMs);
  }

  private _applyFrame(f: QueuedFrame): void {
    const el = this.renderRoot.querySelector('.strip') as HTMLDivElement | null;
    if (!el) return;
    // Only update bg-image when the source clip changes — avoids
    // unnecessary style writes when stepping through frames within the
    // same clip. background-size depends on N too, so update both.
    const desiredBg = `url("${f.url}")`;
    if (el.style.backgroundImage !== desiredBg) {
      el.style.backgroundImage = `url(${f.url})`;
      el.style.backgroundSize = `100% ${f.count * 100}%`;
    }
    el.style.backgroundPositionY =
      f.count > 1 ? `${(f.index / (f.count - 1)) * 100}%` : '0%';
  }

  render() {
    // Static template — always renders an empty .strip div. _applyFrame
    // sets bg-image imperatively. Until the first clip is displayed the
    // .strip is transparent, so the parent's avatar shows through; once
    // playback starts, the .strip stays painted with the current bg-image
    // until the host is unmounted.
    return html`<div class="strip"></div>`;
  }
}
