import { mdiBroadcast } from '@mdi/js';
import { get } from '@holochain-open-dev/stores';
import { registerModule } from './registry';
import type { ModuleDefinition } from './types';
import type { StreamsStore } from '../../streams-store';
import type { MicAcquireResult } from '../../mic-source';

/**
 * Voice module — sends audio to all peers in the room over Holochain remote
 * signals (the same channel `screen-share` uses for SDP). No WebRTC. No new
 * zome calls. The signal envelope reuses `ModuleData` so the existing
 * sendModuleData / handleModuleData / onData wiring carries everything.
 *
 * Capture: MicSource (shared mic track) → MediaStreamTrackProcessor → AudioEncoder (Opus)
 * Wire   : { seq, ts, type, data(base64) } in JSON, sent via sendModuleData
 * Play   : AudioDecoder → AudioBufferSourceNode scheduled into a small jitter buffer
 *
 * Phase 4 moved the mic acquisition out of this module: voice now acquires
 * a handle from `streamsStore.micSource` instead of calling `getUserMedia`
 * itself. Consequences:
 *
 *   - WebRTC and voice share a single device. Toggling the mic button mutes
 *     both (via `track.enabled = false`), no separate voice mute path.
 *   - Device changes from the audio chevron replace the shared track; voice
 *     rebuilds its MediaStreamTrackProcessor on the `onTrackChanged`
 *     consumer callback.
 *   - Voice no longer owns an `AudioContext`; it borrows the single shared
 *     one that MicSource owns. The squelch synth and future playback
 *     consumers all schedule into that one context.
 *
 * NOTE: still intentionally minimal v1 on the wire protocol. No AEC beyond
 * what getUserMedia provides, no PLC, no FEC, no per-peer subscription —
 * every peer in `_knownAgents` receives every frame. See research notes
 * for the path to datagram transport / native AEC.
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

  // Send-side state (capture pipeline)
  private micHandle: MicAcquireResult | null = null;
  private encoder: any = null; // AudioEncoder
  private encoderReader: ReadableStreamDefaultReader<any> | null = null;
  /**
   * Monotonic generation counter for the capture pipeline. Incremented on
   * every (re)build — startCapture, stopCapture, device change. The pump
   * loop captures its generation on entry and exits when the counter moves
   * out from under it. Prevents racing pump loops from two overlapping
   * MediaStreamTrackProcessors after a device change.
   */
  private pipelineGeneration = 0;
  private seq = 0;

  // Receive-side state
  private audioContext: AudioContext | null = null;
  private peers = new Map<string, PeerVoiceState>();

  /**
   * Per-peer peak audio level from the most recent decoded frame.
   * Range 0.0–1.0. Written in playAudioData, read by the UI on its
   * existing render cycle (no reactive store — plain Map to avoid
   * triggering re-renders at 50 fps). Entries are removed when a peer's
   * decoder is closed.
   */
  peerAudioLevels = new Map<string, number>();

  bind(store: StreamsStore) {
    this.store = store;
  }

  unbind() {
    this.stopCapture().catch(() => {});
    for (const [_, p] of this.peers) {
      try { p.decoder.close(); } catch {}
    }
    this.peers.clear();
    this.peerAudioLevels.clear();
    // AudioContext is owned by MicSource now — don't close it here. It
    // stays alive across voice deactivate/reactivate and is disposed by
    // StreamsStore.disconnect → MicSource.dispose.
    this.audioContext = null;
    this.store = null;
  }

  // ----- arrival/leave squelch (synth, no assets) ------------------------
  //
  // Cheap walkie-talkie idiom: a short burst of band-limited noise with a
  // sharp attack and a quick decay. Two slightly different tunings for
  // arrive vs leave so the ear can tell them apart even at low volume.

  playSquelch(direction: 'up' | 'down') {
    const ctx = this.ensureAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const dur = 0.09; // 90 ms

    // Short white-noise buffer.
    const sampleCount = Math.floor(ctx.sampleRate * dur);
    const buffer = ctx.createBuffer(1, sampleCount, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < sampleCount; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Bandpass filter — different center for up vs down.
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = direction === 'up' ? 1800 : 1100;
    filter.Q.value = 4;

    // Gain envelope: fast attack, exponential decay.
    const gain = ctx.createGain();
    const peak = 0.18;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(peak, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);

    source.start(now);
    source.stop(now + dur + 0.02);
  }

  // ----- send side --------------------------------------------------------

  async startCapture(): Promise<boolean> {
    if (!this.store) return false;
    if (this.micHandle) return true;

    const g: any = globalThis as any;
    if (!g.AudioEncoder || !g.MediaStreamTrackProcessor) {
      console.error('voice: WebCodecs / MediaStreamTrackProcessor not available');
      return false;
    }

    // Acquire the mic from MicSource. If WebRTC is already holding it, the
    // underlying device is not reopened — both consumers share the same
    // track. If nothing is holding it yet, MicSource calls getUserMedia on
    // our behalf.
    const handle = await this.store.micSource.acquire({
      id: 'voice',
      onTrackChanged: (newTrack: MediaStreamTrack) => {
        this.onMicTrackChanged(newTrack).catch(e =>
          console.error('voice: onMicTrackChanged failed', e)
        );
      },
    });
    if (!handle) {
      console.error('voice: micSource.acquire failed');
      return false;
    }
    this.micHandle = handle;

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

    // Build the track processor + reader pair bound to the current track.
    const ok = this.buildTrackReader(handle.track);
    if (!ok) {
      this.stopCapture().catch(() => {});
      return false;
    }

    this.pipelineGeneration += 1;
    const gen = this.pipelineGeneration;
    this.pumpEncoder(gen).catch(e => console.error('voice: pump error', e));
    return true;
  }

  /**
   * Called by MicSource when the shared track is replaced (device change).
   * We must rebuild the MediaStreamTrackProcessor because it's bound to
   * the specific track instance. The encoder stays — it's track-agnostic
   * — so seq numbers and timestamps continue uninterrupted and peers'
   * decoders don't see a discontinuity.
   */
  private async onMicTrackChanged(newTrack: MediaStreamTrack): Promise<void> {
    if (!this.micHandle) return;

    // Cancel the existing reader to wake up the pump loop; bump the
    // generation so the old pump exits cleanly when its read() returns.
    if (this.encoderReader) {
      try { await this.encoderReader.cancel(); } catch {}
      this.encoderReader = null;
    }

    const ok = this.buildTrackReader(newTrack);
    if (!ok) {
      console.error('voice: failed to rebuild track reader after device change');
      return;
    }

    this.pipelineGeneration += 1;
    const gen = this.pipelineGeneration;
    this.pumpEncoder(gen).catch(e =>
      console.error('voice: pump error after device change', e)
    );
  }

  private buildTrackReader(track: MediaStreamTrack): boolean {
    const g: any = globalThis as any;
    try {
      const processor = new g.MediaStreamTrackProcessor({ track });
      this.encoderReader = processor.readable.getReader();
      return true;
    } catch (e) {
      console.error('voice: failed to create MediaStreamTrackProcessor', e);
      return false;
    }
  }

  private async pumpEncoder(gen: number) {
    if (!this.encoderReader || !this.encoder) return;
    while (
      this.encoderReader &&
      this.encoder &&
      gen === this.pipelineGeneration
    ) {
      let read: ReadableStreamReadResult<any>;
      try {
        read = await this.encoderReader.read();
      } catch (e) {
        break;
      }
      if (read.done) break;
      // Another pump loop may have taken over while we were awaiting
      // read() — drop the value and exit.
      if (gen !== this.pipelineGeneration) {
        try { read.value?.close?.(); } catch {}
        break;
      }
      const audioData = read.value as AnyAudioData;
      if (!audioData) continue;
      try {
        // Read mute state directly from the shared track's enabled flag.
        // MicSource.setMuted(true) flips this across every consumer at
        // once, so muting via the mic button automatically silences voice
        // without voice having to subscribe to any separate mute event.
        const track = this.micHandle?.track;
        if (track && track.enabled === false) {
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
    // Read the precomputed signals targets set. This is a cached derived
    // store value — no per-chunk recomputation, just a property read.
    const targets = get(this.store._signalsTargets);
    if (targets.size === 0) return;
    const buf = new Uint8Array(chunk.byteLength);
    chunk.copyTo(buf);
    const payload: VoiceFramePayload = {
      seq: this.seq++,
      ts: chunk.timestamp,
      type: chunk.type,
      data: bytesToBase64(buf),
    };
    this.store.sendModuleData('voice', JSON.stringify(payload), targets).catch(() => {});
  }

  async stopCapture(): Promise<void> {
    // Invalidate any in-flight pump loop.
    this.pipelineGeneration += 1;
    if (this.encoderReader) {
      try { await this.encoderReader.cancel(); } catch {}
      this.encoderReader = null;
    }
    if (this.encoder) {
      try { this.encoder.close(); } catch {}
      this.encoder = null;
    }
    if (this.micHandle) {
      try { this.micHandle.release(); } catch {}
      this.micHandle = null;
    }
    this.seq = 0;
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
    // Borrow the shared context from MicSource. When unbind runs, we drop
    // our reference but don't close it — MicSource.dispose does that.
    if (!this.store) return null;
    const ac = this.store.micSource.ensureAudioContext();
    this.audioContext = ac;
    return ac;
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
        output: (data: AnyAudioData) => this.playAudioData(state, agentPubKeyB64, data),
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

  private playAudioData(state: PeerVoiceState, agentPubKeyB64: string, data: AnyAudioData) {
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

        // Peak detection for the volume indicator. Sample every 10th
        // value — 96 iterations for a typical 960-sample Opus frame.
        // ~1 microsecond per peer, zero allocations.
        if (ch === 0) {
          let peak = 0;
          for (let i = 0; i < channel.length; i += 10) {
            const v = channel[i] < 0 ? -channel[i] : channel[i];
            if (v > peak) peak = v;
          }
          this.peerAudioLevels.set(agentPubKeyB64, peak);
        }
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

/** Exported for streams-store to drive the encoder lifecycle. */
export { controller as voiceController };

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

/**
 * Voice module — receive-only registration. The voice encoder is now
 * driven by streams-store's `_reconcileSignalsAudio` (automatic carrier
 * routing), not by a user toolbar button. This module definition exists
 * solely to provide the `onData` hook so incoming voice frames get
 * routed to the VoiceController's decoder.
 *
 * No toolbar button, no user-facing activation, no state icons.
 */
const voiceModule: ModuleDefinition = {
  id: 'voice',
  type: 'agent',
  label: 'Voice',
  icon: mdiBroadcast,
  activationControl: 'sender',

  onData(agentPubKeyB64, chunk) {
    controller.receiveFrame(agentPubKeyB64, chunk);
  },
};

registerModule(voiceModule);
