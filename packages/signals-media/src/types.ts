/**
 * Host interfaces — the seam between this library and whatever application
 * embeds it. The library owns encode/decode, pacing and admission; the host
 * owns the message channel, the devices, the clock and the log sink.
 *
 * Constrains: `src/index.ts` (the public barrel) and every carrier/playback
 * class added in Tasks 2 and 3.
 */

import type { SignalsMediaCadence } from './signals-cadence-policy.js';

export type PeerId = string;

export interface MediaClock {
  now(): number;
}

export interface TrackHandle {
  track: MediaStreamTrack;
  release(): void;
}

export type MediaKind = 'voice' | 'filmstrip';

// One authority for the cadence union: `signals-cadence-policy.ts`, whose
// `decideSignalsMediaCadence` produces it. Re-exported, never redeclared.
export type { SignalsMediaCadence } from './signals-cadence-policy.js';

export interface MediaHost {
  /** Read at every encode; empty = drop. */
  targets(): ReadonlySet<PeerId>;
  /** Host evaluates `decideSignalsMediaCadence`, or returns `'full'`. */
  cadence(): SignalsMediaCadence['mode'];
  send(kind: MediaKind, payload: string, targets: ReadonlySet<PeerId>): Promise<void>;
  clock: MediaClock;
  log(line: string): void;
}

export interface VoiceHost extends MediaHost {
  acquireMic(onTrackChanged: (track: MediaStreamTrack) => void): Promise<TrackHandle | null>;
  /** Shared, user-gesture unlocked; capture AND playout use it. */
  audioContext(): AudioContext | null;
  batchEligible(): boolean;
  /** Override: where `voice-capture-worklet.js` lives. */
  workletModuleUrl?(): string;
  /** Override: the Opus codec backend. Default is WebCodecs when available. */
  codec?(): OpusCodec;
}

export interface FilmstripHost extends MediaHost {
  acquireCamera(onTrackChanged: (track: MediaStreamTrack) => void): Promise<TrackHandle | null>;
  createWorker?(): Worker;
}

export interface VoiceRxStats {
  jitterMs: number | null;
  lossPercent: number | null;
}

/**
 * Codec seam (design spec decision 5b). The library speaks raw Opus packets;
 * a backend is either WebCodecs (`name: 'webcodecs'`) or the WASM fallback
 * (`name: 'wasm'`). Encoders are configured 48 kHz mono, 20 ms frames, with a
 * 24 kbps target — those constants live in `voice-capture.ts`.
 */
export interface OpusPacket {
  type: 'key' | 'delta';
  timestampUs: number;
  data: Uint8Array;
}

export interface OpusEncoder {
  encode(pcm: Float32Array, timestampUs: number): void;
  flush(): Promise<void>;
  close(): void;
}

export interface OpusDecoder {
  decode(packet: OpusPacket): void;
  close(): void;
}

/**
 * Both factories are SYNCHRONOUS and may throw. The receive path is
 * synchronous end to end — `VoiceCarrier.receiveFrame` opens a peer and
 * decodes its frames in the same tick, and `openPeer` returns null (frame
 * dropped) when the decoder cannot be configured, exactly as Presence's
 * `voice.ts` did. Anything genuinely asynchronous belongs in acquiring the
 * BACKEND (`wasmOpus(): Promise<OpusCodec>` instantiates its WASM module),
 * not in creating an encoder or decoder from an acquired one.
 */
export interface OpusCodec {
  name: 'webcodecs' | 'wasm' | string;
  createEncoder(
    onPacket: (p: OpusPacket) => void,
    onError: (e: unknown) => void
  ): OpusEncoder;
  createDecoder(
    onPcm: (pcm: Float32Array, timestampUs: number) => void,
    onError: (e: unknown) => void
  ): OpusDecoder;
}
