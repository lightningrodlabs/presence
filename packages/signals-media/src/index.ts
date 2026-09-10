/**
 * Public barrel for @lightningrodlabs/signals-media.
 *
 * The host seam, the pure decision helpers copied out of Presence, and the
 * voice and filmstrip carriers.
 *
 * The WASM Opus backend is deliberately NOT exported here — it lives behind
 * the `./opus-wasm` subpath so hosts that never target pre-Safari-26 WebKit
 * never pull `libopus-wasm` (design spec decision 5b).
 */

export type {
  PeerId,
  MediaClock,
  TrackHandle,
  MediaKind,
  MediaHost,
  VoiceHost,
  FilmstripHost,
  VoiceRxStats,
  OpusPacket,
  OpusEncoder,
  OpusDecoder,
  OpusCodec,
} from './types.js';

export { decidePlayout, decidePlayoutLegacy } from './voice-playout.js';
export type { PlayoutDecision, PlayoutReason } from './voice-playout.js';

export {
  decideVoiceAdmission,
  nextVoiceEpoch,
  VOICE_SESSION_ADOPT_GAP_MS,
} from './voice-admission.js';
export type { VoiceAdmission, VoiceAdmissionSnapshot } from './voice-admission.js';

export { estimatePlayoutSenderTimeMs, framePaceMs } from './av-sync.js';
export type { PlayoutAnchor } from './av-sync.js';

export {
  decideSignalsMediaCadence,
  SIGNALS_RTT_DEGRADED_MS,
  SIGNALS_RTT_COLLAPSED_MS,
} from './signals-cadence-policy.js';
export type { SignalsMediaCadence } from './signals-cadence-policy.js';

export { bytesToBase64, base64ToBytes } from './base64.js';

export {
  VoiceCarrier,
  VOICE_BATCH_FRAMES,
  packVoiceFrames,
  unpackVoicePayload,
} from './voice-carrier.js';
export type { VoiceFrame, VoiceFramePayload } from './voice-carrier.js';

export {
  VoiceCapture,
  VOICE_SAMPLE_RATE,
  VOICE_FRAME_SAMPLES,
} from './voice-capture.js';

export { webCodecsOpus } from './opus-webcodecs.js';

export {
  FilmstripCarrier,
  FILMSTRIP_FPS_OPTIONS,
  FILMSTRIP_CAPTURE_SIZES,
  FILMSTRIP_RX_LOG_INTERVAL_MS,
} from './filmstrip-carrier.js';
export type {
  FilmstripFps,
  FilmstripCaptureSize,
  FilmstripFrame,
  VideoSignalsStats,
} from './filmstrip-carrier.js';

export { FilmstripSampler } from './filmstrip-sampler.js';

export {
  FilmstripPlayback,
  BUFFER_CLIPS,
  MAX_BUFFER_CLIPS,
} from './filmstrip-playback.js';
export type { QueuedFrame, FilmstripPlaybackSinks } from './filmstrip-playback.js';

export {
  createInlineFilmstripWorker,
  voiceWorkletModuleUrl,
} from './inline-sources.js';
