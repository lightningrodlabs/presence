/**
 * Phase 4 item 4 — pure decision logic for the per-peer audio-link
 * roll-up and the pair-wise `PeerLinkSnapshot` broadcast, extracted so
 * the two liveness meanings stay named and separately evidenced:
 *
 *   - **connected** (WebRTC): the transport reports ICE + DTLS up.
 *     Carried by `slot.connected`. No freshness window — the transport
 *     owns that claim and its recovery.
 *   - **reachable** (signals): a pong arrived recently. Carried by the
 *     `LastSeenBucket`. It is evidence about the Holochain signal path,
 *     nothing else.
 *
 * They are inputs to one decision here, but they are never compared or
 * substituted for each other, and the ordering below is the contract:
 *
 * **Observed media flow beats reachability evidence.** Before this
 * extraction, `audioLinkFor` returned 'absent' whenever the signals
 * bucket said gone/unknown — including for a peer with live WebRTC
 * audio. That let a 30s pong outage (a signals-path fact) veto
 * ICE + DTLS + flowing RTP (a WebRTC fact), contradicting the
 * function's own "active flow takes precedence over everything else"
 * comment. Declared behavior change: the two flow checks now run before
 * the reachability veto, so a peer you can actually hear is never
 * 'absent'. The veto still governs every no-flow state — negotiating,
 * muted, down all require the peer to be signals-reachable, because
 * without flow the pong path is the only evidence they exist at all.
 *
 * Constrains `StreamsStore.audioLinkFor` and `StreamsStore.peerLinkFor`.
 */

import type {
  AudioLinkState,
  LastSeenBucket,
  PeerLinkSnapshot,
} from './types';
import { STALE_CYCLES_REFRESH_THRESHOLD } from './transport/track-health-policy';

/** The `_openConnections` fields these decisions read. Deliberately narrow. */
export type LinkSlot = {
  /** True once the transport reports ICE + DTLS up (WebRTC `connected`). */
  connected: boolean;
  /** Remote audio track present on the connection. */
  audio: boolean;
  /** Remote video track present on the connection. */
  video: boolean;
  videoMuted?: boolean;
};

/** The WebRTC negotiation stages that render as 'negotiating'. */
const NEGOTIATING_STATUSES = new Set([
  'AwaitingInit',
  'InitSent',
  'AcceptSent',
  'SdpExchange',
]);

export type AudioLinkInputs = {
  blocked: boolean;
  /**
   * The **signals-reachable** bucket (pong freshness, `lastSeenBucket`).
   * Only ever gates the no-flow states — never the flow arms above it.
   */
  reachableBucket: LastSeenBucket;
  slot: Pick<LinkSlot, 'connected' | 'audio'> | undefined;
  /** Consecutive track-health cycles with no inbound audio bytes. */
  audioStaleCycles: number;
  /** Last signals voice-frame arrival (voiceController.peerLastRecvMs). */
  lastVoiceMs: number | undefined;
  now: number;
  /** MEDIA_LIVE_WINDOW_MS — the one media-flowing window per predicate. */
  mediaLiveWindowMs: number;
  /** Peer's own broadcast micMuted intent. */
  peerMicMuted: boolean;
  /** Local WebRTC negotiation status type, if any. */
  statusType: string | undefined;
};

export function decideAudioLink(s: AudioLinkInputs): AudioLinkState {
  if (s.blocked) return 'blocked';

  // Active flow takes precedence over everything else — including the
  // reachability veto below. If audio is actually arriving, the link is
  // working regardless of any stale intent, status flag, or pong outage.
  // The cycle bound is track-health's: one threshold for "inbound audio is
  // cycle-stale", shared with decideTrackRefresh (a bare `2` here silently
  // duplicated it until the 2026-08 retro — working agreement 2).
  const webrtcAudioLive =
    !!s.slot?.connected &&
    !!s.slot?.audio &&
    s.audioStaleCycles < STALE_CYCLES_REFRESH_THRESHOLD;
  if (webrtcAudioLive) return 'webrtc';

  const signalsLive =
    s.lastVoiceMs !== undefined && s.now - s.lastVoiceMs < s.mediaLiveWindowMs;
  if (signalsLive) return 'signals';

  // No flow: from here on, the peer's existence is evidenced only by the
  // signals path, so signals-reachability is the gate for every arm.
  if (s.reachableBucket === 'gone' || s.reachableBucket === 'unknown') {
    return 'absent';
  }

  // Peer intent comes BEFORE the negotiation check: a stale
  // ConnectionStatus stuck in InitSent/AcceptSent (e.g. left over from
  // before webrtc was globally disabled) would otherwise mask the fact
  // that the peer is intentionally muted. Muted is the more accurate
  // answer when both could apply.
  if (s.peerMicMuted) return 'muted';

  // Genuine in-progress negotiation (no flow, peer not muted).
  if (s.statusType !== undefined && NEGOTIATING_STATUSES.has(s.statusType)) {
    return 'negotiating';
  }

  // Reachable, not muted, no flow and not negotiating — broken.
  return 'down';
}

export type PeerLinkInputs = {
  audioLink: AudioLinkState;
  slot: LinkSlot | undefined;
  /** Filmstrip clip received within the media-flowing window. */
  filmstripLive: boolean;
  /** The signals-reachable bucket, passed through onto the wire. */
  lastSeen: LastSeenBucket;
};

/**
 * The pair-wise snapshot broadcast in pong metadata ("how I see this
 * peer"). Field meanings, so wire readers don't re-conflate them:
 *
 *   - `carrier`: which carrier is linking the pair. The `webrtc` arms
 *     agree with the carrier-active authority (`carrierFor`,
 *     `transport/carrier-coverage.ts`: a connected slot means WebRTC
 *     owns the link even before audio flows). 'none' means no live
 *     audio and no connected slot — deliberately NOT `carrierFor`'s
 *     answer, because that function assigns responsibility for present
 *     peers, while this field reports observation for possibly-absent
 *     ones.
 *   - `audio: 'stale'`: the slot claims connected+audio but the flow
 *     checks failed — a WebRTC claim contradicted by observed bytes,
 *     surfaced instead of silently trusted.
 */
export function buildPeerLinkSnapshot(s: PeerLinkInputs): PeerLinkSnapshot {
  let carrier: PeerLinkSnapshot['carrier'];
  if (s.audioLink === 'webrtc') carrier = 'webrtc';
  else if (s.audioLink === 'signals') carrier = 'signals';
  else if (s.slot?.connected) carrier = 'webrtc';
  else carrier = 'none';

  let audio: PeerLinkSnapshot['audio'];
  if (s.audioLink === 'webrtc' || s.audioLink === 'signals') audio = 'live';
  else if (s.audioLink === 'muted') audio = 'muted';
  else if (s.slot?.connected && s.slot.audio) audio = 'stale';
  else audio = 'off';

  // Video is 'live' if WebRTC has an active video track OR a filmstrip
  // clip arrived within the media-flowing window (signals carrier
  // carrying low-bandwidth video).
  const video: PeerLinkSnapshot['video'] =
    s.slot?.video || s.filmstripLive
      ? 'live'
      : s.slot?.videoMuted
        ? 'muted'
        : 'off';

  return {
    audioLink: s.audioLink,
    carrier,
    audio,
    video,
    lastSeen: s.lastSeen,
  };
}
