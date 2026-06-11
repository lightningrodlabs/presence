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
  /** Per-frame edge length (px), used to scale the display max-size. */
  width: number;
}

@customElement('peer-filmstrip')
export class PeerFilmstrip extends LitElement {
  @property({ type: String })
  agentPubKeyB64 = '';

  /**
   * Callback invoked when filmstrip activity transitions. Parent uses
   * this to hide the avatar (which sits behind the filmstrip) while a
   * clip is being displayed — keeps the avatar from flashing through
   * any transparent moment in the bg-image swap.
   */
  @property({ attribute: false })
  onActiveChange?: (active: boolean) => void;

  private _queue: QueuedFrame[] = [];
  private _started = false;
  private _animTimer: number | null = null;
  private _unsubscribe: (() => void) | null = null;
  /**
   * Receiver-side display scale, 0–100.
   *   - 0 = strip displayed at exactly the capture size (e.g. 96 px).
   *   - 100 = strip fills the pane (frame size).
   *   - linear interpolation between in pixels.
   * Per-element local state — adjusted by the slider in the host.
   * Defaults to 100 (fill the pane).
   */
  private _scalePercent = 100;
  /** Width (px) of the latest received frame; used by _applyScale. */
  private _lastFrameWidth = 0;
  /** Track active state to fire onActiveChange only on transitions. */
  private _active = false;

  private _setActive(active: boolean): void {
    if (active === this._active) return;
    this._active = active;
    try { this.onActiveChange?.(active); } catch (e) {
      console.error('peer-filmstrip: onActiveChange threw', e);
    }
  }

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
      /* Center the .strip box inside the host so the filmstrip sits in
         the middle of the pane regardless of container size. */
      display: flex;
      align-items: center;
      justify-content: center;
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
      /* Height is set imperatively by _applyScale via a calc() that
         linearly interpolates between capture size (slider=0) and pane
         size (slider=100). Width is derived from aspect-ratio so the
         strip stays square in any pane shape — in 16:9 panes a
         width-based calc would make the strip a rectangle (asymmetric
         "100%" in width vs height) and distort the bg-image. */
      height: 100%;
      aspect-ratio: 1 / 1;
      max-width: 100%;
      background-repeat: no-repeat;
      background-position: 0 0;
      /* background-size set inline as 100% × (N*100)% so each of the N
         frames fills the strip when its background-position-y is at
         that frame's offset. Source frames are square so this matches
         the strip box without aspect distortion. */
    }
    /* Match the pane shape — circle in circle view, slightly rounded
       in square view. :host-context lets us peek at the .video-container
       parent's classes from inside the shadow DOM. */
    :host-context(.video-container:not(.square-view):not(.screen-share)) .strip {
      border-radius: 50%;
      overflow: hidden;
    }
    :host-context(.video-container.square-view) .strip {
      border-radius: 8px;
      overflow: hidden;
    }
    .size-slider {
      position: absolute;
      /* Sit just above the pane's bottom icon chrome (tile-meta).
         Square view: tile-meta is a single 36px row at bottom: 10px,
         so its top edge is ~46px from the bottom. Overridden for
         circle view via :host-context() below. */
      bottom: 50px;
      left: 50%;
      transform: translateX(-50%);
      width: 60%;
      max-width: 200px;
      height: 14px;
      pointer-events: auto;
      opacity: 0.4;
      transition: opacity 0.15s;
      cursor: pointer;
      /* Sit above the .strip — both are siblings inside the host;
         document order alone (slider first) puts the strip on top
         when it has a bg-image, hiding the slider. */
      z-index: 1;
      /* Hidden by default — shown only when a clip is being displayed.
         Visibility toggled imperatively in _applyFrame / null callback. */
      display: none;
    }
    /* Circle view: tile-meta is a stacked column at bottom: 10px —
       icons row (30px) + 4px margin + avatar row (36px) puts its top
       edge ~80px from the bottom; a little extra clearance keeps the
       slider from overlapping the icons. */
    :host-context(.video-container:not(.square-view):not(.screen-share)) .size-slider {
      bottom: 92px;
    }
    :host(:hover) .size-slider {
      opacity: 0.85;
    }
    .size-slider:focus-visible {
      opacity: 1;
      outline: 1px solid #9cf;
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
    // immediate replay-subscribe. Also hide the slider.
    const el = this.renderRoot?.querySelector?.('.strip') as HTMLDivElement | null;
    if (el) el.style.backgroundImage = '';
    const slider = this.renderRoot?.querySelector?.('.size-slider') as HTMLInputElement | null;
    if (slider) slider.style.display = 'none';
    this._lastFrameWidth = 0;
    this._setActive(false);
  }

  private async _onFrame(frame: FilmstripFrame | null): Promise<void> {
    // null = sender stopped (explicit stop signal or inactivity TTL).
    // Drain the queue, stop animation, clear bg-image so the avatar
    // shows through, hide the size slider.
    if (frame === null) {
      if (this._animTimer !== null) {
        window.clearTimeout(this._animTimer);
        this._animTimer = null;
      }
      this._queue = [];
      this._started = false;
      const el = this.renderRoot.querySelector('.strip') as HTMLDivElement | null;
      if (el) el.style.backgroundImage = '';
      const slider = this.renderRoot.querySelector('.size-slider') as HTMLInputElement | null;
      if (slider) slider.style.display = 'none';
      filmstripController.setBufferDepth(this.agentPubKeyB64, 0);
      this._setActive(false);
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
        width: frame.width,
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
    // same clip. Size is set by _applyScale based on the slider.
    const desiredBg = `url("${f.url}")`;
    if (el.style.backgroundImage !== desiredBg) {
      el.style.backgroundImage = `url(${f.url})`;
      el.style.backgroundSize = `100% ${f.count * 100}%`;
      this._lastFrameWidth = f.width;
      this._applyScale();
      // Show the slider — a clip is now being displayed. Need an
      // explicit value (not '') to override the stylesheet's
      // `display: none` default.
      const slider = this.renderRoot.querySelector('.size-slider') as HTMLInputElement | null;
      if (slider) slider.style.display = 'block';
      this._setActive(true);
    }
    el.style.backgroundPositionY =
      f.count > 1 ? `${(f.index / (f.count - 1)) * 100}%` : '0%';
  }

  /**
   * Set the strip's height to a linear interpolation between the
   * capture size (at scale 0) and the pane height (at scale 100), via
   * CSS calc(). Width is derived from `aspect-ratio: 1/1` in the
   * stylesheet so the strip stays a square in any pane shape — in a
   * 16:9 square-view pane, setting both width and height would resolve
   * `100%` differently for each axis and stretch the strip into a
   * rectangle. Setting only height, then letting aspect-ratio compute
   * width, keeps it square (paneHeight × paneHeight) and centered.
   */
  private _applyScale(): void {
    const el = this.renderRoot.querySelector('.strip') as HTMLDivElement | null;
    if (!el) return;
    // Clear any inline width so the stylesheet's aspect-ratio drives it.
    el.style.width = '';
    if (this._lastFrameWidth === 0) {
      el.style.height = '100%';
      return;
    }
    const cap = `${this._lastFrameWidth}px`;
    const pct = this._scalePercent / 100;
    el.style.height = `calc(${cap} + (100% - ${cap}) * ${pct})`;
  }

  render() {
    // Static template — always renders an empty .strip div and the
    // size slider. _applyFrame sets bg-image imperatively. Until the
    // first clip is displayed the .strip is transparent, so the
    // parent's avatar shows through; once playback starts, the .strip
    // stays painted with the current bg-image until the host is
    // unmounted.
    return html`
      <input
        type="range"
        class="size-slider"
        min="0"
        max="100"
        step="1"
        title="Display scale: 0% = capture size, 100% = pane size"
        .value=${String(this._scalePercent)}
        @input=${(e: Event) => this._onSlider(e)}
      />
      <div class="strip"></div>
    `;
  }

  private _onSlider(e: Event): void {
    const v = Number((e.target as HTMLInputElement).value);
    if (Number.isNaN(v)) return;
    this._scalePercent = Math.max(0, Math.min(100, v));
    this._applyScale();
  }
}
