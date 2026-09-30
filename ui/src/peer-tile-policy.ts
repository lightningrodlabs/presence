/**
 * peer-tile-policy — the ONE decision that turns a per-peer snapshot into
 * what the peer tile shows: what the user can hear, what they can see,
 * and whether to wait or act. Pure: snapshot in, tagged record out,
 * `reason` on every arm, table-pinned against the grid in
 * docs/superpowers/specs/2026-09-30-peer-tile-state-design.md
 * (`__tests__/peer-tile-policy.test.ts`).
 *
 * The carrier never appears in a status line (spec decision 2, pinned by
 * a negative grep in the test): WebRTC vs signals is connection-details
 * material. Flow beats everything (decision 3): while audio is arriving
 * the line is empty regardless of negotiation phase.
 *
 * Copy lives here and in `intent-diff-policy.ts` (`VIDEO_PACED_COPY`,
 * shared with the own-side camera badge) — `intent-diff-surfaces.test.ts`
 * pins that no render file re-embeds any of it.
 *
 * Replaces (spec decision 1): `describeLinkEstablishment` and
 * `StreamsStore.peerReconnecting`, room-view's inline
 * `connecting media...` literal, its `!conn.connected` avatar-hiding arm,
 * the amber signaling-held dot, and `_renderAudioLevelMeter`'s
 * meter-removed-when-muted arm.
 */
import type { AudioLinkState } from './types';
import { INTENT_DIFF_GRACE_MS, VIDEO_PACED_COPY } from './intent-diff-policy';

/**
 * How long nothing may flow before the tile suggests a manual Reconnect.
 * UI-feedback pacing, NOT liveness (working agreement 2): the link
 * authorities (`decideAudioLink`, the FSM, `computePresentPeers`) keep
 * their own clocks; this only decides when copy escalates from "wait"
 * to "act". Measured from `PeerRecord.audioSilentSince`, stamped on the
 * presence tick by `decideSilenceStamps`.
 */
export const LINK_STUCK_ACT_MS = 30_000;

export type PeerTileSlot = {
  connected: boolean;
  video: boolean;
  videoMuted?: boolean;
};

export type PeerTileInputs = {
  /** `decideWebrtcEligibility(...).eligible` for this peer. */
  webrtcExpected: boolean;
  /** `audioLinkFor(peer)` — the flow authority. */
  audioLink: AudioLinkState;
  /** The peer's broadcast `micMuted`. */
  peerMicMuted: boolean;
  /** The peer's broadcast `cameraOn`; undefined = payload absent or a
   *  build that predates the field (spec decision 7). */
  peerCameraOn: boolean | undefined;
  /** The `_openConnections` slot, if any. */
  slot: PeerTileSlot | undefined;
  /** Filmstrip frames within MEDIA_LIVE_WINDOW_MS (the store's read). */
  filmstripLive: boolean;
  audioSilentSince: number | undefined;
  videoSilentSince: number | undefined;
  /** `PeerRecord.qualityBucket`, concatenated segments like `type:quality:noise:latency`. */
  qualityBucket: string | undefined;
  now: number;
};

export type PeerTileState = {
  background: 'avatar' | 'video' | 'filmstrip';
  /** live = meter lit; silent = meter dark; muted = the muted glyph. */
  audio: 'live' | 'silent' | 'muted';
  quality: 'ok' | 'poor' | 'bad' | 'unknown';
  /** Exact user copy; at most one line. */
  statusLine: string | undefined;
  attention: 'none' | 'wait' | 'act';
  reason: string;
};

const NO_AUDIO_COPY = 'no audio — reconnecting…';
const CANT_CONNECT_COPY = "can't connect — try Reconnect";
const CONNECTING_VIDEO_COPY = 'connecting video…';

function qualityOf(bucket: string | undefined): PeerTileState['quality'] {
  const seg = bucket?.split(':')[1];
  return seg === 'ok' || seg === 'poor' || seg === 'bad' ? seg : 'unknown';
}

/** A video track that can carry frames: the slot is `connected` (a track
 *  before DTLS carries nothing — the circle-tile oval fix's measured
 *  trigger), present, unmuted, and the peer has not said the camera is
 *  off (spec decision 7's show rule). */
function webrtcVideoLive(s: Pick<PeerTileInputs, 'slot' | 'peerCameraOn'>): boolean {
  return (
    !!s.slot?.connected &&
    !!s.slot.video &&
    !s.slot.videoMuted &&
    s.peerCameraOn !== false
  );
}

export function describePeerTile(s: PeerTileInputs): PeerTileState {
  const audioFlowing = s.audioLink === 'webrtc' || s.audioLink === 'signals';
  const background: PeerTileState['background'] = webrtcVideoLive(s)
    ? 'video'
    : s.filmstripLive
      ? 'filmstrip'
      : 'avatar';
  const audio: PeerTileState['audio'] = s.peerMicMuted
    ? 'muted'
    : audioFlowing
      ? 'live'
      : 'silent';
  const quality = qualityOf(s.qualityBucket);
  const out = (
    statusLine: string | undefined,
    attention: PeerTileState['attention'],
    reason: string,
  ): PeerTileState => ({ background, audio, quality, statusLine, attention, reason });

  // Audio line: only for genuine silence — not flowing, not muted, and
  // the peer is evidenced by the signals path (absent/blocked/unknown
  // are not "reconnecting" states; the tile exists only via the present
  // predicate's carrier hold in those cases, and says nothing).
  if (!audioFlowing && !s.peerMicMuted) {
    switch (s.audioLink) {
      case 'absent':
        return out(undefined, 'none', 'absent');
      case 'blocked':
        return out(undefined, 'none', 'blocked');
      case 'unknown':
        return out(undefined, 'none', 'unknown');
      case 'negotiating':
      case 'down': {
        const silentFor =
          s.audioSilentSince === undefined ? 0 : s.now - s.audioSilentSince;
        if (silentFor >= LINK_STUCK_ACT_MS) return out(CANT_CONNECT_COPY, 'act', 'silent-act');
        if (silentFor >= INTENT_DIFF_GRACE_MS) return out(NO_AUDIO_COPY, 'wait', 'silent-wait');
        return out(undefined, 'none', 'silent-under-grace');
      }
      case 'muted':
      case 'webrtc':
      case 'signals':
        // unreachable by the guard above; fall through to the video arms
        break;
      default: {
        const exhaustive: never = s.audioLink;
        void exhaustive;
      }
    }
  }

  // Video line (audio flowing or muted): a track that arrived muted, or a
  // camera the peer says is on whose frames are not arriving.
  if (
    s.slot?.connected &&
    s.slot.video &&
    s.slot.videoMuted &&
    s.peerCameraOn !== false
  ) {
    return out(CONNECTING_VIDEO_COPY, 'wait', 'video-track-muted');
  }
  if (s.peerCameraOn === true && background === 'avatar') {
    const waitingFor =
      s.videoSilentSince === undefined ? 0 : s.now - s.videoSilentSince;
    if (waitingFor >= INTENT_DIFF_GRACE_MS) {
      if (s.webrtcExpected && s.slot?.connected) {
        return out(CONNECTING_VIDEO_COPY, 'wait', 'video-waiting-webrtc');
      }
      // Frames would come over signals; their cadence throttled them.
      return out(VIDEO_PACED_COPY, 'none', 'video-paced');
    }
  }

  return out(undefined, 'none', s.peerMicMuted ? 'muted' : 'audio-flowing');
}

export type SilenceStamps = {
  audioSilentSince: number | undefined;
  videoSilentSince: number | undefined;
};

/**
 * The per-tick stamping rule for the two `PeerRecord` pacing timestamps
 * (spec decision 5). Audio: set while the link is `negotiating`/`down`,
 * cleared on flow, on mute, and on absent/blocked/unknown — so an
 * unmute gets the full grace. Video: set only while the peer says the
 * camera is on and nothing is arriving — so a camera turned on after a
 * long off period gets the full grace too. A stamp is kept, never
 * refreshed, while its condition holds.
 */
export function decideSilenceStamps(s: {
  audioLink: AudioLinkState;
  peerCameraOn: boolean | undefined;
  videoFlowing: boolean;
  prev: SilenceStamps;
  now: number;
}): SilenceStamps {
  const audioSilent = s.audioLink === 'negotiating' || s.audioLink === 'down';
  const videoWaiting = s.peerCameraOn === true && !s.videoFlowing;
  return {
    audioSilentSince: audioSilent ? (s.prev.audioSilentSince ?? s.now) : undefined,
    videoSilentSince: videoWaiting ? (s.prev.videoSilentSince ?? s.now) : undefined,
  };
}
