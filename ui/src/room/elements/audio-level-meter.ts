import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { StreamsStore } from '../../streams-store';

/**
 * Self-updating audio level meter for a peer. Polls at 10fps, reads
 * from whichever carrier is active for this peer:
 *
 *   - WebRTC connected → reads from the AnalyserNode on the incoming stream
 *   - No WebRTC → reads from the signals carrier's peak level map
 *
 * Renders as a vertical stack of 5 small bricks: bottom 3 green, 4th
 * amber, 5th red. Fully decoupled from Lit's reactive render cycle.
 */
@customElement('audio-level-meter')
export class AudioLevelMeter extends LitElement {
  @property({ attribute: false })
  streamsStore!: StreamsStore;

  @property({ type: String })
  agentPubKeyB64 = '';

  private _intervalId = 0;
  private _brickEls: HTMLElement[] = [];
  private _lastBricks = -1;

  static styles = css`
    :host {
      display: inline-flex;
      flex-direction: column-reverse;
      gap: 1px;
      height: 20px;
      vertical-align: middle;
      margin-right: 4px;
    }
    .brick {
      width: 6px;
      height: 3px;
      border-radius: 1px;
      background: rgba(255, 255, 255, 0.15);
    }
  `;

  private static COLORS = ['#7adc7a', '#7adc7a', '#7adc7a', '#e7a008', '#c72100'];

  render() {
    return html`
      <div class="brick"></div>
      <div class="brick"></div>
      <div class="brick"></div>
      <div class="brick"></div>
      <div class="brick"></div>
    `;
  }

  firstUpdated() {
    this._brickEls = Array.from(this.shadowRoot!.querySelectorAll('.brick'));
  }

  connectedCallback() {
    super.connectedCallback();
    // Armed here, not in firstUpdated: Lit DOM reuse inside repeat()
    // disconnects and reconnects an element without ever running
    // firstUpdated again, so a firstUpdated-armed interval stayed dead
    // after reuse and the meter froze (Round 3 item 4b(4) — the inverse
    // of the teardown leaks; clock.ts/timer.ts/peer-filmstrip.ts are the
    // template). The guard keeps the first connect + firstUpdated pair
    // from double-arming.
    if (!this._intervalId) {
      this._intervalId = window.setInterval(this._tick, 100);
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = 0;
    }
  }

  private _tick = () => {
    if (!this.streamsStore) return;

    // Pick the active carrier's level source for this peer
    const level = this.streamsStore.getWebrtcAudioLevel(this.agentPubKeyB64)
      || (this.streamsStore.signalsAudioLevels.get(this.agentPubKeyB64) ?? 0);

    const bricks = Math.min(5, Math.round(Math.sqrt(level) * 5));

    if (bricks !== this._lastBricks) {
      this._lastBricks = bricks;
      for (let i = 0; i < 5; i++) {
        this._brickEls[i].style.background =
          i < bricks ? AudioLevelMeter.COLORS[i] : 'rgba(255,255,255,0.15)';
      }
    }
  };
}
