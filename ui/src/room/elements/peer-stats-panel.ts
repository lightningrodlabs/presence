import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { StreamsStore } from '../../streams-store';
import { MEDIA_LIVE_WINDOW_MS } from '../../presence-policy';
import { filmstripController } from '../modules/video-filmstrip';

/**
 * Small semi-transparent panel showing per-peer carrier stats.
 *
 * Reads `streamsStore.statsFor(peer)` — the one carrier+stats authority
 * (`transport/carrier-stats-policy.ts`):
 *   - carrier 'webrtc' (ICE + DTLS up) → webrtcStats (RTT from
 *     remote-inbound-rtp, jitter + loss from inbound-rtp)
 *   - carrier 'signals' → signalsStats (RTT from ping-pong echo,
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
  private _lastFlow: 'both' | 'tx' | 'rx' | 'idle' | 'muted' = 'idle';
  // Video filmstrip stats (only shown when present — i.e. when this peer
  // is currently sending us a filmstrip).
  private _lastVidFps: number | null = null;
  private _lastVidJitter: number | null = null;
  private _lastVidTransit: number | null = null;
  private _lastVidBuf: number | null = null;
  private _lastVidLoss: number | null = null;
  /** A/V skew (ms, sender timebase): positive = video lags audio. */
  private _lastVidSkew: number | null = null;

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
    const carrierLabel = carrier;
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
          <span title="A/V skew: positive = video lags audio"><span class="label">skew</span> <span class="value">${fmt(this._lastVidSkew, 'ms')}</span></span>
        </div>
      ` : html``}
    `;
  }

  connectedCallback() {
    super.connectedCallback();
    // Armed here, not in firstUpdated: Lit DOM reuse inside repeat()
    // reconnects an element without re-running firstUpdated, so the
    // 1Hz poll stayed dead after reuse and the panel froze (Round 3
    // item 4b(4); clock.ts/timer.ts/peer-filmstrip.ts are the template).
    if (!this._intervalId) {
      this._intervalId = window.setInterval(this._tick, 1000);
      this._tick();
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

    // Carrier + numbers come from the one authority (Phase 4 item 2):
    // statsFor keys the carrier on `connected` (ICE + DTLS up, via
    // carrierFor) — the panel used to key on "any _openConnections entry
    // exists", which claimed webrtc for half-open negotiations while
    // signals carried the audio.
    const peerStats = this.streamsStore.statsFor(this.agentPubKeyB64);
    const carrier = peerStats.carrier;
    const rtt = peerStats.rttMs;
    const jitter = peerStats.jitterMs;
    const loss = peerStats.lossPercent;

    // Flow detection: is audio actually moving in each direction right now?
    // Carrier says who OWNS the link; the flow glyph surfaces whether
    // frames are actually moving — recent frames in/out, per direction.
    // Same question as the media-flowing predicate, so it reads that
    // predicate's window (a local 2000ms literal silently disagreed with
    // it until the 2026-08 retro — working agreement 2).
    const FLOW_WINDOW_MS = MEDIA_LIVE_WINDOW_MS;
    // signalsLastRecv/-Sent are stamped from the store clock, so the
    // freshness comparison must read the same clock (PR #4 F2).
    const now = this.streamsStore.clock.now();
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
    const vidSkew = vid?.avSkewMs ?? null;

    if (
      carrier !== this._lastCarrier ||
      rtt !== this._lastRtt ||
      jitter !== this._lastJitter ||
      loss !== this._lastLoss ||
      flow !== this._lastFlow ||
      vidFps !== this._lastVidFps ||
      vidJitter !== this._lastVidJitter ||
      vidTransit !== this._lastVidTransit ||
      vidBuf !== this._lastVidBuf ||
      vidLoss !== this._lastVidLoss ||
      vidSkew !== this._lastVidSkew
    ) {
      this._lastCarrier = carrier;
      this._lastRtt = rtt;
      this._lastJitter = jitter;
      this._lastLoss = loss;
      this._lastFlow = flow;
      this._lastVidFps = vidFps;
      this._lastVidJitter = vidJitter;
      this._lastVidTransit = vidTransit;
      this._lastVidBuf = vidBuf;
      this._lastVidLoss = vidLoss;
      this._lastVidSkew = vidSkew;
      this.requestUpdate();
    }
  };
}
