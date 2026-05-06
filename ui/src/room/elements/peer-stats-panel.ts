import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { StreamsStore } from '../../streams-store';
import { filmstripController } from '../modules/video-filmstrip';

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
  /** Variant suffix for the WebRTC carrier — distinguishes the impl. */
  private _lastImpl: 'sp' | 'fsm' | null = null;
  private _lastRtt: number | null = null;
  private _lastJitter: number | null = null;
  private _lastLoss: number | null = null;
  private _lastFlow: 'both' | 'tx' | 'rx' | 'idle' | 'muted' = 'idle';
  // Video filmstrip stats (only shown when present — i.e. when this peer
  // is currently sending us a filmstrip).
  private _lastVidFps: number | null = null;
  private _lastVidJitter: number | null = null;
  private _lastVidTransit: number | null = null;
  private _lastVidBuf: number | null = null;
  private _lastVidLoss: number | null = null;

  static styles = css`
    :host {
      display: inline-flex;
      flex-direction: column;
      gap: 2px;
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
      align-self: flex-start;
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
    const carrierLabel = carrier === 'webrtc' && this._lastImpl
      ? `webrtc ${this._lastImpl}`
      : carrier;
    const fmt = (v: number | null, unit: string) =>
      v === null ? '-' : `${v}${unit}`;
    const flowGlyph =
      this._lastFlow === 'both' ? '⇅'
      : this._lastFlow === 'tx' ? '↑'
      : this._lastFlow === 'rx' ? '↓'
      : this._lastFlow === 'muted' ? '∅'
      : '·';
    const flowColor =
      this._lastFlow === 'idle' ? '#e07070'
      : this._lastFlow === 'muted' ? '#c3c9eb'
      : '#7adc7a';
    const hasVid = this._lastVidFps !== null;
    return html`
      <div class="panel">
        <span class="carrier">${carrierLabel}</span>
        <span class="flow" style="color: ${flowColor}" title="audio flow: ${
          this._lastFlow === 'both' ? 'transmitting & receiving'
          : this._lastFlow === 'tx' ? 'transmitting'
          : this._lastFlow === 'rx' ? 'receiving'
          : this._lastFlow === 'muted' ? 'peer is muted'
          : 'idle'
        }">${flowGlyph}</span>
        <span><span class="label">rtt</span> <span class="value">${fmt(this._lastRtt, 'ms')}</span></span>
        <span><span class="label">jit</span> <span class="value">${fmt(this._lastJitter, 'ms')}</span></span>
        <span><span class="label">loss</span> <span class="value">${fmt(this._lastLoss, '%')}</span></span>
      </div>
      ${hasVid ? html`
        <div class="panel" title="video filmstrip stats">
          <span class="carrier">vid</span>
          <span><span class="label">fps</span> <span class="value">${fmt(this._lastVidFps, '')}</span></span>
          <span><span class="label">jit</span> <span class="value">${fmt(this._lastVidJitter, 'ms')}</span></span>
          <span><span class="label">tr</span> <span class="value">${fmt(this._lastVidTransit, 'ms')}</span></span>
          <span><span class="label">buf</span> <span class="value">${fmt(this._lastVidBuf, '')}</span></span>
          <span><span class="label">loss</span> <span class="value">${fmt(this._lastVidLoss, '%')}</span></span>
        </div>
      ` : html``}
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
    const impl: 'sp' | 'fsm' | null = isWebrtc
      ? this.streamsStore.webrtcImplFor(this.agentPubKeyB64) === 'fsm' ? 'fsm' : 'sp'
      : null;
    const stats = isWebrtc
      ? this.streamsStore.webrtcStats.get(this.agentPubKeyB64)
      : this.streamsStore.signalsStats.get(this.agentPubKeyB64);

    const rtt = stats?.rttMs ?? null;
    const jitter = stats?.jitterMs ?? null;
    const loss = stats?.lossPercent ?? null;

    // Flow detection: is audio actually moving in each direction right now?
    // The stats panel historically inferred carrier from _openConnections
    // presence alone, which can lie — pong RTT populates signalsStats even
    // when the local voice encoder is idle, and a lingering _openConnections
    // entry can show "webrtc" while media has stopped flowing. The flow
    // glyph surfaces the truth: recent frames in/out, per direction.
    const FLOW_WINDOW_MS = 2000;
    const now = Date.now();
    let tx = false;
    let rx = false;
    if (carrier === 'signals') {
      const encoderRunning = this.streamsStore.voiceEncoderRunning;
      const lastSent = this.streamsStore.signalsLastSent.get(this.agentPubKeyB64);
      const lastRecv = this.streamsStore.signalsLastRecv.get(this.agentPubKeyB64);
      tx = !!encoderRunning && !!lastSent && now - lastSent < FLOW_WINDOW_MS;
      rx = !!lastRecv && now - lastRecv < FLOW_WINDOW_MS;
    } else {
      // WebRTC: approximate flow from conn.audio/video presence.
      // Receiving counts as rx; sending is implied by our own mic being
      // unmuted while the connection is audio-enabled.
      const conn = this.streamsStore.openConnectionInfo(this.agentPubKeyB64);
      rx = !!conn?.audio;
      tx = !!conn?.connected;
    }
    let flow: 'both' | 'tx' | 'rx' | 'idle' | 'muted' =
      tx && rx ? 'both' : tx ? 'tx' : rx ? 'rx' : 'idle';
    // Idle silence is misleading when the silence is intentional. The
    // muted glyph wins over idle but never over actual flow.
    if (flow === 'idle') {
      const link = this.streamsStore.audioLinkFor(this.agentPubKeyB64);
      if (link === 'muted') flow = 'muted';
    }

    // Video filmstrip stats (only for peers actively sending us video).
    // We pull from the controller's map; the controller clears the map
    // on _clearPeerDisplay so when video stops the row disappears.
    const vid = filmstripController.signalsVideoStats.get(this.agentPubKeyB64);
    const vidFps = vid?.fpsActual ?? null;
    const vidJitter = vid?.jitterMs ?? null;
    const vidTransit = vid?.transitMs ?? null;
    const vidBuf = vid?.bufferDepth ?? null;
    const vidLoss = vid?.lossPercent ?? null;

    if (
      carrier !== this._lastCarrier ||
      impl !== this._lastImpl ||
      rtt !== this._lastRtt ||
      jitter !== this._lastJitter ||
      loss !== this._lastLoss ||
      flow !== this._lastFlow ||
      vidFps !== this._lastVidFps ||
      vidJitter !== this._lastVidJitter ||
      vidTransit !== this._lastVidTransit ||
      vidBuf !== this._lastVidBuf ||
      vidLoss !== this._lastVidLoss
    ) {
      this._lastCarrier = carrier;
      this._lastImpl = impl;
      this._lastRtt = rtt;
      this._lastJitter = jitter;
      this._lastLoss = loss;
      this._lastFlow = flow;
      this._lastVidFps = vidFps;
      this._lastVidJitter = vidJitter;
      this._lastVidTransit = vidTransit;
      this._lastVidBuf = vidBuf;
      this._lastVidLoss = vidLoss;
      this.requestUpdate();
    }
  };
}
