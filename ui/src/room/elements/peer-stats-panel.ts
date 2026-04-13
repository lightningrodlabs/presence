import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { StreamsStore } from '../../streams-store';

/**
 * Small semi-transparent panel showing per-peer carrier stats.
 *
 * Reads from whichever carrier is active for this peer:
 *   - WebRTC connected → streamsStore.webrtcStats (RTT from
 *     remote-inbound-rtp, jitter + loss from inbound-rtp)
 *   - No WebRTC → streamsStore.signalsStats (RTT from ping-pong echo,
 *     jitter from voice frame inter-arrival, loss from seq gaps)
 *
 * Polls at 1Hz via setInterval — stats update at most once a second
 * anyway (VoiceController publishes on a 1s window, WebRTC poll runs
 * every 2s).
 */
@customElement('peer-stats-panel')
export class PeerStatsPanel extends LitElement {
  @property({ attribute: false })
  streamsStore!: StreamsStore;

  @property({ type: String })
  agentPubKeyB64 = '';

  private _intervalId = 0;

  /** Cached rendered state so we only requestUpdate when a number changed */
  private _lastCarrier: 'webrtc' | 'signals' | 'none' = 'none';
  private _lastRtt: number | null = null;
  private _lastJitter: number | null = null;
  private _lastLoss: number | null = null;

  static styles = css`
    :host {
      display: inline-block;
      vertical-align: middle;
      font-size: 13px;
      line-height: 1;
      font-family: monospace;
    }
    .panel {
      display: inline-flex;
      gap: 10px;
      padding: 4px 10px;
      background: rgba(0, 0, 0, 0.45);
      border-radius: 4px;
      color: #c3c9eb;
      white-space: nowrap;
    }
    .label {
      opacity: 0.6;
    }
    .value {
      font-weight: 600;
    }
    .carrier {
      opacity: 0.75;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
  `;

  render() {
    const carrier = this._lastCarrier;
    const fmt = (v: number | null, unit: string) =>
      v === null ? '-' : `${v}${unit}`;
    return html`
      <div class="panel">
        <span class="carrier">${carrier}</span>
        <span><span class="label">rtt</span> <span class="value">${fmt(this._lastRtt, 'ms')}</span></span>
        <span><span class="label">jit</span> <span class="value">${fmt(this._lastJitter, 'ms')}</span></span>
        <span><span class="label">loss</span> <span class="value">${fmt(this._lastLoss, '%')}</span></span>
      </div>
    `;
  }

  firstUpdated() {
    this._intervalId = window.setInterval(this._tick, 1000);
    this._tick();
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

    const isWebrtc = this.streamsStore.hasWebrtcConnection(this.agentPubKeyB64);
    const carrier: 'webrtc' | 'signals' = isWebrtc ? 'webrtc' : 'signals';
    const stats = isWebrtc
      ? this.streamsStore.webrtcStats.get(this.agentPubKeyB64)
      : this.streamsStore.signalsStats.get(this.agentPubKeyB64);

    const rtt = stats?.rttMs ?? null;
    const jitter = stats?.jitterMs ?? null;
    const loss = stats?.lossPercent ?? null;

    if (
      carrier !== this._lastCarrier ||
      rtt !== this._lastRtt ||
      jitter !== this._lastJitter ||
      loss !== this._lastLoss
    ) {
      this._lastCarrier = carrier;
      this._lastRtt = rtt;
      this._lastJitter = jitter;
      this._lastLoss = loss;
      this.requestUpdate();
    }
  };
}
