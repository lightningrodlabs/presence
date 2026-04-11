import { html } from 'lit';
import { mdiBroadcast } from '@mdi/js';
import { wrapPathInSvg } from '@holochain-open-dev/elements';
import { registerModule } from './registry';
import type { ModuleDefinition } from './types';
import type { StreamsStore } from '../../streams-store';

/**
 * Voice module — sends audio to all peers in the room over Holochain remote
 * signals (the same channel `screen-share` uses for SDP). No WebRTC. No new
 * zome calls. The signal envelope reuses `ModuleData` so the existing
 * sendModuleData / handleModuleData / onData wiring carries everything.
 *
 * Capture: getUserMedia(audio) → MediaStreamTrackProcessor → AudioEncoder (Opus)
 * Wire   : { seq, ts, type, data(base64) } in JSON, sent via sendModuleData
 * Play   : AudioDecoder → AudioBufferSourceNode scheduled into a small jitter buffer
 *
 * NOTE: this is intentionally minimal v1. No AEC beyond what getUserMedia
 * provides, no PLC, no FEC, no per-peer subscription model — every peer in
 * `_knownAgents` receives every frame. See research notes for the path to
 * datagram transport / native AEC.
 */

// WebCodecs types are not in lib.dom for older TS targets, so use locals.
type AnyEncodedAudioChunk = any;
type AnyAudioData = any;

interface VoiceFramePayload {
  seq: number;
  ts: number; // microseconds (matches WebCodecs timestamp)
  type: 'key' | 'delta';
  data: string; // base64-encoded chunk bytes
}

interface PeerVoiceState {
  decoder: any; // AudioDecoder
  /** audioContext.currentTime at which the next decoded chunk should start */
  nextPlaybackTime: number;
  /** highest seq seen from this peer (for drop-old-packets) */
  lastSeq: number;
}

const JITTER_BUFFER_MS = 80;
const PLAYBACK_RESET_DRIFT_MS = 400;

class VoiceController {
  private store: StreamsStore | null = null;

  // Send-side state
  private mediaStream: MediaStream | null = null;
  private encoder: any = null; // AudioEncoder
  private encoderReader: ReadableStreamDefaultReader<any> | null = null;
  private seq = 0;
  private muted = false;

  // Receive-side state
  private audioContext: AudioContext | null = null;
  private peers = new Map<string, PeerVoiceState>();

  bind(store: StreamsStore) {
    this.store = store;
  }

  unbind() {
    this.stopCapture().catch(() => {});
    for (const [_, p] of this.peers) {
      try { p.decoder.close(); } catch {}
    }
    this.peers.clear();
    if (this.audioContext) {
      try { this.audioContext.close(); } catch {}
      this.audioContext = null;
    }
    this.store = null;
  }

  // ----- send side --------------------------------------------------------

  async startCapture(): Promise<boolean> {
    if (!this.store) return false;
    if (this.mediaStream) return true;

    const g: any = globalThis as any;
    if (!g.AudioEncoder || !g.MediaStreamTrackProcessor) {
      console.error('voice: WebCodecs / MediaStreamTrackProcessor not available');
      return false;
    }

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: 48000,
        },
        video: false,
      });
    } catch (e) {
      console.error('voice: getUserMedia failed', e);
      return false;
    }

    const track = this.mediaStream.getAudioTracks()[0];
    if (!track) {
      console.error('voice: no audio track');
      this.stopCapture().catch(() => {});
      return false;
    }

    try {
      this.encoder = new g.AudioEncoder({
        output: (chunk: AnyEncodedAudioChunk) => this.handleEncodedChunk(chunk),
        error: (e: any) => console.error('voice: encoder error', e),
      });
      this.encoder.configure({
        codec: 'opus',
        sampleRate: 48000,
        numberOfChannels: 1,
        bitrate: 24000,
      });
    } catch (e) {
      console.error('voice: encoder configure failed', e);
      this.stopCapture().catch(() => {});
      return false;
    }

    try {
      const processor = new g.MediaStreamTrackProcessor({ track });
      this.encoderReader = processor.readable.getReader();
    } catch (e) {
      console.error('voice: failed to create MediaStreamTrackProcessor', e);
      this.stopCapture().catch(() => {});
      return false;
    }

    this.pumpEncoder().catch(e => console.error('voice: pump error', e));
    return true;
  }

  private async pumpEncoder() {
    if (!this.encoderReader || !this.encoder) return;
    while (this.encoderReader && this.encoder) {
      let read: ReadableStreamReadResult<any>;
      try {
        read = await this.encoderReader.read();
      } catch (e) {
        break;
      }
      if (read.done) break;
      const audioData = read.value as AnyAudioData;
      if (!audioData) continue;
      try {
        if (this.muted) {
          continue;
        }
        if (this.encoder && this.encoder.state === 'configured') {
          this.encoder.encode(audioData);
        }
      } catch (e) {
        console.error('voice: encode failed', e);
      } finally {
        try { audioData.close(); } catch {}
      }
    }
  }

  private handleEncodedChunk(chunk: AnyEncodedAudioChunk) {
    if (!this.store) return;
    const buf = new Uint8Array(chunk.byteLength);
    chunk.copyTo(buf);
    const payload: VoiceFramePayload = {
      seq: this.seq++,
      ts: chunk.timestamp,
      type: chunk.type,
      data: bytesToBase64(buf),
    };
    this.store.sendModuleData('voice', JSON.stringify(payload)).catch(() => {});
  }

  async stopCapture(): Promise<void> {
    if (this.encoderReader) {
      try { await this.encoderReader.cancel(); } catch {}
      this.encoderReader = null;
    }
    if (this.encoder) {
      try { this.encoder.close(); } catch {}
      this.encoder = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(t => t.stop());
      this.mediaStream = null;
    }
    this.seq = 0;
  }

  setMuted(muted: boolean) {
    this.muted = muted;
  }

  // ----- receive side -----------------------------------------------------

  receiveFrame(agentPubKeyB64: string, chunk: string) {
    let payload: VoiceFramePayload;
    try {
      payload = JSON.parse(chunk);
    } catch {
      return;
    }
    let state = this.peers.get(agentPubKeyB64);
    if (!state) {
      const created = this.openPeer(agentPubKeyB64);
      if (!created) return;
      state = created;
    }
    if (payload.seq <= state.lastSeq && state.lastSeq !== 0) {
      // out-of-order or duplicate; cheap drop
      return;
    }
    state.lastSeq = payload.seq;

    const data = base64ToBytes(payload.data);
    const g: any = globalThis as any;
    let encChunk: AnyEncodedAudioChunk;
    try {
      encChunk = new g.EncodedAudioChunk({
        type: payload.type,
        timestamp: payload.ts,
        data,
      });
    } catch (e) {
      console.error('voice: failed to construct EncodedAudioChunk', e);
      return;
    }
    try {
      if (state.decoder.state === 'configured') {
        state.decoder.decode(encChunk);
      }
    } catch (e) {
      console.error('voice: decode failed', e);
    }
  }

  private ensureAudioContext(): AudioContext | null {
    if (this.audioContext) return this.audioContext;
    try {
      this.audioContext = new AudioContext({ sampleRate: 48000 });
      // best-effort unlock; in Electron this normally succeeds without a gesture
      const ac = this.audioContext;
      ac.resume().catch(() => {});
      return ac;
    } catch (e) {
      console.error('voice: failed to create AudioContext', e);
      return null;
    }
  }

  private openPeer(agentPubKeyB64: string): PeerVoiceState | null {
    const g: any = globalThis as any;
    if (!g.AudioDecoder || !g.EncodedAudioChunk) {
      console.error('voice: WebCodecs decoder not available');
      return null;
    }
    const ctx = this.ensureAudioContext();
    if (!ctx) return null;

    const state: PeerVoiceState = {
      decoder: null,
      nextPlaybackTime: 0,
      lastSeq: 0,
    };
    try {
      state.decoder = new g.AudioDecoder({
        output: (data: AnyAudioData) => this.playAudioData(state, data),
        error: (e: any) =>
          console.error(`voice: decoder error ${agentPubKeyB64.slice(0, 8)}`, e),
      });
      state.decoder.configure({
        codec: 'opus',
        sampleRate: 48000,
        numberOfChannels: 1,
      });
    } catch (e) {
      console.error('voice: decoder configure failed', e);
      return null;
    }
    this.peers.set(agentPubKeyB64, state);
    return state;
  }

  private playAudioData(state: PeerVoiceState, data: AnyAudioData) {
    const ctx = this.audioContext;
    if (!ctx) {
      try { data.close(); } catch {}
      return;
    }
    try {
      const sampleRate: number = data.sampleRate;
      const numberOfFrames: number = data.numberOfFrames;
      const numberOfChannels: number = data.numberOfChannels;
      const buffer = ctx.createBuffer(numberOfChannels, numberOfFrames, sampleRate);
      for (let ch = 0; ch < numberOfChannels; ch++) {
        const channel = new Float32Array(numberOfFrames);
        try {
          data.copyTo(channel, { planeIndex: ch, format: 'f32-planar' });
        } catch {
          // some implementations only expose 'f32' (interleaved); for mono this
          // gives the same result. fall back without specifying format.
          data.copyTo(channel, { planeIndex: ch });
        }
        buffer.copyToChannel(channel, ch);
      }
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);

      const now = ctx.currentTime;
      const jitterSec = JITTER_BUFFER_MS / 1000;
      const driftSec = PLAYBACK_RESET_DRIFT_MS / 1000;
      // (Re)initialize playback head if first frame, behind real time, or
      // unreasonably far ahead (peer paused/network burst).
      if (
        state.nextPlaybackTime < now ||
        state.nextPlaybackTime > now + jitterSec + driftSec
      ) {
        state.nextPlaybackTime = now + jitterSec;
      }
      source.start(state.nextPlaybackTime);
      state.nextPlaybackTime += numberOfFrames / sampleRate;
    } catch (e) {
      console.error('voice: playback error', e);
    } finally {
      try { data.close(); } catch {}
    }
  }
}

const controller = new VoiceController();

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  // chunk to avoid stack overflow on large inputs (Opus frames are ~200B so
  // unnecessary, but keeps this safe).
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + CHUNK))
    );
  }
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const voiceModule: ModuleDefinition = {
  id: 'voice',
  type: 'agent',
  label: 'Voice',
  icon: mdiBroadcast,
  activationControl: 'sender',

  defaultState() {
    return '{}';
  },

  onActivate(ctx) {
    controller.bind(ctx.streamsStore);
  },

  onDeactivate() {
    controller.unbind();
  },

  onData(agentPubKeyB64, chunk) {
    controller.receiveFrame(agentPubKeyB64, chunk);
  },

  getStateIcons(_agentPubKeyB64, state, _context) {
    // The icon strip only invokes getStateIcons for modules that are present
    // in this agent's state map, so by the time we're called the module is
    // active for that agent. Show a broadcast badge so peers can tell that
    // *this* agent is talking via voice-over-signals as opposed to WebRTC.
    if (!state?.active) return [];
    return [
      {
        states: [
          { icon: mdiBroadcast, tooltip: 'Voice (signals)', color: '#7adc7a' },
        ],
        currentState: 0,
      },
    ];
  },

  renderToolbarButton(myState, _toggle, streamsStore) {
    const active = !!myState;
    const handler = async () => {
      if (active) {
        await controller.stopCapture();
        await streamsStore.deactivateModule('voice');
      } else {
        await streamsStore.activateModule('voice');
        const ok = await controller.startCapture();
        if (!ok) {
          await streamsStore.deactivateModule('voice');
        }
      }
    };
    return html`
      <sl-tooltip content="${active ? 'Stop Voice (signals)' : 'Voice (signals)'}" hoist>
        <div
          class="toggle-btn ${active ? '' : 'btn-off'}"
          tabindex="0"
          @click=${handler}
          @keypress=${(e: KeyboardEvent) => {
            if (e.key === 'Enter') handler();
          }}
        >
          <sl-icon
            class="toggle-btn-icon ${active ? '' : 'btn-icon-off'}"
            .src=${wrapPathInSvg(mdiBroadcast)}
          ></sl-icon>
        </div>
      </sl-tooltip>
    `;
  },
};

registerModule(voiceModule);
