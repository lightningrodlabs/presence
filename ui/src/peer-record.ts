/**
 * PeerRecord — the ONE per-peer state record (store-decomposition round
 * one; docs/superpowers/specs/2026-09-02-peer-record-consolidation-design.md).
 * Fields are grouped by lifecycle class; `resetPeerRecord` (Task 4) is
 * the one authority for what survives which teardown.
 *
 * INVARIANT: record existence is never a liveness predicate. Presence
 * and membership have their own authorities (`_presentPeers`,
 * `_activeAgents`, `_knownAgents`); nothing may iterate `_peerRecords`
 * or test row existence to answer "who is here". A row may outlive the
 * peer (the leave reset keeps `connectionEpoch` — monotonic for the
 * session, see docs/WEBRTC_RECONNECT_IDENTITY.md).
 */
import type { AgentPubKeyB64 } from '@holochain/client';
import type { PendingInit } from './types';

export type PeerRecord = {
  // — media-session bookkeeping: reset on media close
  /**
   * Timestamp at which a video peer's iceConnectionState most recently
   * entered 'disconnected', for the grace-period recovery window in
   * stale cleanup. Maintained by `_handleMediaIceDiagnostic` from the
   * transport's `ice-diagnostic` events; the invariant is that this is
   * set iff the connection's iceConnectionState is currently
   * 'disconnected'. Cleared on entry to any other ICE state, on
   * close-cleanup, and on the supersede paths.
   */
  iceDisconnectedAt?: number;
  /** Last bytesReceived value per track kind, for dead-track detection via getStats(). */
  lastBytesReceived?: { audio: number; video: number };
  /** Consecutive health-check cycles where bytesReceived did not increase. */
  staleCycles?: { audio: number; video: number };
  /** Consecutive reconciliation attempts, for exponential backoff of the cooldown. */
  reconcileAttemptCount?: number;
  /**
   * Last-emitted quality bucket, e.g. `"webrtc:ok:clean"`. Dedupes so
   * QualityBucketChange events only fire when the bucket actually
   * changes rather than every poll cycle.
   */
  qualityBucket?: string;
  /**
   * Most recent reason this peer left the `connected` webrtc phase,
   * captured from the FSM transition that took it out of `connected`
   * (e.g. "disconnectFromPeerVideo", "peer left", "transport failure:
   * dtls-failed"). Read by `_handleMediaClosed` to annotate the
   * `CarrierSwitch fsm->signals` downgrade with *why* webrtc was
   * abandoned (§6.6).
   */
  webrtcExitReason?: string;
  videoStream?: MediaStream;
  pendingInits?: PendingInit[];
  /** clock.setTimeout handle; the executor disarms before dropping. */
  sdpTimeoutTimer?: number;
  analyser?: { node: AnalyserNode; buffer: Uint8Array };
  /** Managed solely by the outage sweep — no reset arm touches it. */
  outageState?: { startedAt: number; emitted: boolean };
  // — screen-share session: reset on the screen-share close rows
  screenShareStream?: MediaStream; // incoming
  screenShareIceDisconnectedAt?: number; // outgoing
  // — close survivors: reset only on peer-leave
  lastDisconnectTime?: number;
  lastReconcileTime?: number;
  signalsRttEwma?: number;
  // — session survivor: never reset
  connectionEpoch: number;
};

export function initialPeerRecord(): PeerRecord {
  return { connectionEpoch: 0 };
}

// AgentPubKeyB64 re-exported so streams-store's helper signatures can
// reference it without a second import line.
export type { AgentPubKeyB64 };
