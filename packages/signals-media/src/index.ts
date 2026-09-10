/**
 * Public barrel for @lightningrodlabs/signals-media.
 *
 * Task 1 exports the host seam and the pure decision helpers copied out of
 * Presence; the carrier and playback classes land in Tasks 2 and 3.
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
