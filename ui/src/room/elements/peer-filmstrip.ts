import { LitElement, html, css, PropertyValues } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import {
  filmstripController,
  FilmstripFrame,
} from '../modules/video-filmstrip';

/**
 * Self-updating filmstrip overlay for one peer.
 *
 * Subscribes to the FilmstripController for `agentPubKeyB64`. When a
 * filmstrip arrives (JPEG with N frames stacked vertically), it sets
 * the JPEG as a CSS background-image with `background-size: 100% Nx00%`,
 * then steps `background-position-y` at the original sample period —
 * the seatcamp animation pattern. CSS does the work; we just rotate
 * the offset.
 *
 * Lifecycle: shows the last received filmstrip until the element is
 * unmounted by the parent (which mounts us only when WebRTC video is
 * NOT live — `!conn.video`). Intentionally has NO inactivity TTL: a
 * 2 s clip cadence with normal signal jitter will routinely exceed any
 * reasonable TTL, and the alternative — flashing the avatar through
 * between clips — looks broken. A frozen last-loop is the better
 * "sender stalled" fallback. If the sender stops entirely, the parent
 * will swap us out (e.g. WebRTC reconnects, peer leaves).
 *
 * Positioned `position: absolute; inset: 0` so the parent video-container
 * mounts it as an overlay; render is a no-op until the first frame
 * arrives, so the avatar shows through until then.
 */

@customElement('peer-filmstrip')
export class PeerFilmstrip extends LitElement {
  @property({ type: String })
  agentPubKeyB64 = '';

  /**
   * Latest frame, set imperatively (NOT via @state) so Lit does not
   * re-render the .strip div when a new clip arrives. Re-renders here
   * cause a brief paint where the new bg-image hasn't taken effect yet
   * and the avatar (in the parent's light DOM) flashes through. With
   * imperative DOM updates the bg-image swap is atomic on the existing
   * div — no rebuild, no flash.
   */
  private _frame: FilmstripFrame | null = null;

  private _unsubscribe: (() => void) | null = null;
  private _animTimer: number | null = null;
  private _frameIndex = 0;

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
      window.clearInterval(this._animTimer);
      this._animTimer = null;
    }
    this._frame = null;
    this._frameIndex = 0;
    // Clear the imperative bg-image so a stale image from a previous
    // peer doesn't linger if `agentPubKeyB64` is reassigned without an
    // immediate replay-subscribe.
    const el = this.renderRoot?.querySelector?.('.strip') as HTMLDivElement | null;
    if (el) el.style.backgroundImage = '';
  }

  private async _onFrame(frame: FilmstripFrame): Promise<void> {
    // Pre-decode the new JPEG so when we swap the bg-image the browser
    // already has the pixel data ready. Without this the swap can paint
    // an empty bg for one frame while the new image decodes (visible as
    // an avatar-flash through the transparent host).
    try {
      const probe = new Image();
      probe.src = frame.url;
      await probe.decode();
    } catch {
      // Decode rejected (rare — corrupt JPEG, revoked URL). Fall through
      // and let the browser handle it the normal way.
    }
    // The element may have been unmounted while we awaited decode; bail
    // if a teardown happened in the meantime.
    if (!this._unsubscribe) return;
    // A newer frame may also have started decoding — check that this
    // frame is still the latest before applying it.
    const latest = filmstripController.getLatest(this.agentPubKeyB64);
    if (latest && latest.url !== frame.url) return;

    this._frame = frame;
    this._frameIndex = 0;
    const el = this.renderRoot.querySelector('.strip') as HTMLDivElement | null;
    if (el) {
      el.style.backgroundImage = `url(${frame.url})`;
      el.style.backgroundSize = `100% ${frame.frameCount * 100}%`;
      el.style.backgroundPositionY = '0%';
    }
    this._restartAnim(frame);
  }

  private _restartAnim(frame: FilmstripFrame): void {
    if (this._animTimer !== null) {
      window.clearInterval(this._animTimer);
      this._animTimer = null;
    }
    if (frame.frameCount <= 1) return;
    // Step through frames 0..N-1 once, then stop. Holding on the last
    // frame until the next clip arrives is the correct behaviour: the
    // sender captures roughly one clip's worth of video per CLIP_TARGET_MS,
    // so playback that takes the same wall-clock time and then waits is
    // the natural reproduction. Looping would replay the same frames
    // when a clip is delayed by network jitter — visible as a stutter
    // rather than a brief freeze.
    this._animTimer = window.setInterval(() => {
      const f = this._frame;
      if (!f) return;
      if (this._frameIndex >= f.frameCount - 1) {
        if (this._animTimer !== null) {
          window.clearInterval(this._animTimer);
          this._animTimer = null;
        }
        return;
      }
      this._frameIndex += 1;
      this._applyFrameIndex();
    }, frame.periodMs);
  }

  private _applyFrameIndex(): void {
    const el = this.renderRoot.querySelector('.strip') as HTMLDivElement | null;
    if (!el || !this._frame) return;
    const N = this._frame.frameCount;
    el.style.backgroundPositionY =
      N > 1 ? `${(this._frameIndex / (N - 1)) * 100}%` : '0%';
  }

  render() {
    // Static template — always renders an empty .strip div. _onFrame
    // sets bg-image imperatively. Until the first clip arrives the
    // .strip is transparent, so the parent's avatar shows through; once
    // a clip lands, the .strip stays painted with the latest bg-image
    // until the host is unmounted.
    return html`<div class="strip"></div>`;
  }
}
