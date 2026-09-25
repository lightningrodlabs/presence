import { mdiSubtitlesOutline } from '@mdi/js';
import type { AgentPubKeyB64 } from '@holochain/client';
import type { AsrFinalEvent, AsrSession } from '@theweave/api';
import { get, writable, Writable } from '@holochain-open-dev/stores';
import { registerModule } from './registry';
import type { ModuleDefinition, ModuleStateEnvelope } from './types';
import type { StreamsStore } from '../../streams-store';
import type { MicAcquireResult } from '../../mic-source';
import { readLocalStorage } from '../../utils';
import { parseConversationPayload } from './conversation';
import { transcriptId, type StoredTranscript, type TranscriptStore } from '../transcripts/store';
import type { LabelFor } from '../transcripts/export';

export const AUTO_ACCEPT_KEY = 'autoAcceptTranscriptionRequests';
/**
 * localStorage flag. When "true", every PCM frame pushed to Moss is also
 * kept in memory and downloaded as a WAV when capture stops, so the audio
 * that left Presence can be compared against what Moss committed
 * (moss `yarn asr:diagnose --reference <that wav>`).
 */
export const DEBUG_RECORD_KEY = 'transcriptionDebugRecord';

/**
 * Structured diagnostic log for the transcription pipeline. Emits
 * `[transcription HH:MM:SS.mmm] <event> <k=v ...>` lines so the user
 * can grep the browser console and correlate against Moss's
 * `[asr-session]` output. Kept on-by-default: the volume is low
 * (≤ a few lines per second at peak) and diagnosing "dropped audio"
 * complaints requires after-the-fact correlation, which means we
 * need the logs without asking the user to enable anything.
 */
function txLog(event: string, fields: Record<string, unknown> = {}): void {
  const d = new Date();
  const stamp = d.toISOString().slice(11, 23); // HH:MM:SS.mmm
  const parts = Object.entries(fields).map(([k, v]) => {
    if (typeof v === 'string') return `${k}=${JSON.stringify(v)}`;
    return `${k}=${v}`;
  });
  const suffix = parts.length > 0 ? ' ' + parts.join(' ') : '';
  console.log(`[transcription ${stamp}] ${event}${suffix}`);
}

/**
 * Transcription module — self-transcription via Moss's local ASR
 * pipeline (`weaveClient.localModels.asr`).
 *
 * Each speaker transcribes their own microphone stream locally and
 * broadcasts committed utterance finals to peers over the existing
 * module-data signal channel. No other peer transcribes them in
 * Phase 1; volunteer fallback is Phase 2.
 *
 * UX is deliberately minimal: one room participant "requests"
 * call-wide transcription (broadcast as `requested: true`); other
 * participants get a yes/no notification and either opt in (setting
 * their own `enabled: true`) or ignore it. A per-device setting can
 * auto-accept future requests.
 *
 * See moss-ai-transcription/docs/build/transcription.md for the host-
 * side API contract. Key invariants we follow there:
 *
 *   - No client-side VAD. Moss commits finals after ~500 ms of silence,
 *     which is already the natural "broadcast during speaker pauses"
 *     cadence we want.
 *   - Push native sample rate. Moss resamples.
 *   - Errors are terminal — open a new session to recover.
 */

// =========================================================================
// Payload
// =========================================================================

export interface TranscriptionPayload {
  /** True while this agent is producing transcripts from their own mic. */
  enabled: boolean;
  /**
   * True when this agent has requested call-wide transcription. The
   * request is simply a broadcast flag; each peer reacts locally by
   * showing a yes/no dialog or auto-accepting per setting.
   */
  requested: boolean;
  /**
   * Highest seq this agent has broadcast so far. Updated periodically
   * (not on every final) so receivers can detect missing frames at
   * room-exit time. Undefined until we've emitted anything.
   */
  maxCommittedSeq?: number;
  /**
   * Set only in the deactivation envelope. Highest seq that will ever
   * be broadcast by this transcriber in this session. Receivers use
   * this to tell "transcript is complete" vs "transcriber left with
   * unknown-completeness".
   */
  finalSeq?: number;
}

export const DEFAULT_TRANSCRIPTION_PAYLOAD: TranscriptionPayload = {
  enabled: false,
  requested: false,
};

export function parseTranscriptionPayload(
  envelope: ModuleStateEnvelope | null,
): TranscriptionPayload | null {
  if (!envelope || !envelope.active) return null;
  try {
    const raw = JSON.parse(envelope.payload);
    return {
      enabled: !!raw.enabled,
      requested: !!raw.requested,
      maxCommittedSeq:
        typeof raw.maxCommittedSeq === 'number' ? raw.maxCommittedSeq : undefined,
      finalSeq: typeof raw.finalSeq === 'number' ? raw.finalSeq : undefined,
    };
  } catch {
    return null;
  }
}

// =========================================================================
// Broadcast frame
// =========================================================================

/**
 * One committed utterance, broadcast via `sendModuleData('transcription', …)`
 * as JSON. In Phase 1 `speaker === transcriber` always; the distinction
 * matters once volunteer transcription lands.
 */
export interface TranscriptFrame {
  speaker: AgentPubKeyB64;
  transcriber: AgentPubKeyB64;
  seq: number;
  /** ms from session start (speaker-local clock). */
  tStart: number;
  tEnd: number;
  /**
   * Sender's wall-clock `Date.now()` at the moment this final was
   * committed. Unlike `tStart`/`tEnd` (which are relative to the
   * speaker's own session start and therefore not comparable across
   * transcribers who started at different times), this timestamp is
   * the single anchor we sort by for chronological transcript
   * display and for the markdown export.
   */
  committedAtMs: number;
  text: string;
  confidence?: number;
  lang?: string;
}

/**
 * Accumulated per-speaker transcript record. The receiver accumulator
 * on StreamsStore stores these grouped by speaker AgentPubKeyB64.
 * We retain `seq` (per-transcriber monotonic) for gap detection at
 * exit time; `transcriber` lets Phase 2 volunteer merging distinguish
 * self-transcription from a volunteer.
 */
export interface TranscriptEntry {
  seq: number;
  tStart: number;
  tEnd: number;
  /** Sender's wall-clock Date.now() at utterance commit — used for
   *  chronological ordering and [HH:MM:SS] display in the export. */
  committedAtMs: number;
  text: string;
  transcriber: AgentPubKeyB64;
  confidence?: number;
  lang?: string;
}

// =========================================================================
// Controller
// =========================================================================

// WebCodecs types aren't in lib.dom for older TS targets; mirror the
// escape hatch used in voice.ts.
type AnyAudioData = any;

class TranscriptionController {
  private store: StreamsStore | null = null;

  /**
   * Peers whose transcription module currently has `requested: true`
   * AND we have not yet responded. Room-view subscribes and renders a
   * prompt from this set. Removed when: user responds, peer clears the
   * flag, or peer leaves. A peer only appears here when auto-accept
   * is false; otherwise we activate silently.
   */
  pendingRequests: Writable<Set<AgentPubKeyB64>> = writable(new Set());

  /**
   * True iff the local ASR session is open and the mic pump is
   * feeding it. Distinct from the module payload's `enabled` /
   * `requested` — those flip as soon as the user clicks, while this
   * only flips once capabilities have been checked, the session has
   * opened, and the MediaStreamTrackProcessor pump is live.
   * Room-view uses this to drive the "actively transcribing" visual
   * on the toolbar button.
   */
  isCapturing: Writable<boolean> = writable(false);
  /**
   * True from the moment a session open is requested until the host
   * answers. Covers the speech model's cold start, which the UI shows
   * as its own state rather than as "paused".
   */
  isStarting: Writable<boolean> = writable(false);

  /**
   * User-facing failure messages from the controller, for room-view
   * to surface via notifyError. Set on any failure path that the
   * user cares about (Moss ASR absent / disabled, openSession reject,
   * session onError event). Consumers read + clear; setting to null
   * clears. The value is short and actionable; verbose diagnostics
   * go to console.error separately.
   */
  lastError: Writable<string | null> = writable(null);

  // Capture-side state
  private micHandle: MicAcquireResult | null = null;
  private reader: ReadableStreamDefaultReader<any> | null = null;
  /** Rolling counters for the periodic stats line. Reset on
   *  startCapture. `framesSkippedMuted` is retained as 0 for log
   *  schema stability — every frame is now pushed regardless of
   *  mute state, so this counter stays at 0 in healthy operation. */
  private framesPushed = 0;
  private framesSkippedMuted = 0;
  /** Frames pushed since the pump started, kept only under DEBUG_RECORD_KEY. */
  private debugRecording: Int16Array[] = [];
  private finalsReceived = 0;
  private statsInterval: number | null = null;
  /**
   * Monotonic generation for the capture pipeline. Increments on every
   * (re)build so a pump loop can notice that it's been superseded by a
   * device-change path and exit cleanly.
   */
  private pipelineGeneration = 0;

  // ASR session state
  private session: AsrSession | null = null;
  private sessionOffFinal: (() => void) | null = null;
  private sessionOffError: (() => void) | null = null;
  private sessionOffPartial: (() => void) | null = null;
  private seq = 0;

  /**
   * The call visit being recorded: one StoredTranscript from bind to
   * endVisit, holding every frame from every speaker. Written to the
   * store at most once per VISIT_WRITE_INTERVAL_MS while frames arrive,
   * and once more when the visit ends.
   */
  private visit: StoredTranscript | null = null;
  private visitStore: TranscriptStore | null = null;
  private visitDirty = false;
  private visitWriteTimer: ReturnType<typeof setTimeout> | null = null;
  private labelFor: LabelFor | null = null;
  private static readonly VISIT_WRITE_INTERVAL_MS = 2000;
  /** The live visit for the transcripts dialog; null outside a room. */
  readonly liveVisit: Writable<StoredTranscript | null> = writable(null);

  bind(store: StreamsStore) {
    this.store = store;
    // Start the model now so a later openSession() returns at once.
    // Older hosts have no warmUp, and a host with Transcription off rejects;
    // neither is an error here.
    const asr = store.localModels?.asr;
    if (typeof asr?.warmUp === 'function') {
      asr.warmUp().catch(() => undefined);
    }
    // Frame numbering is per speaker per room: receivers drop a repeated
    // (transcriber, seq), so every capture session in this room must
    // continue the count, and only a new room starts over.
    this.seq = 0;
    this.openVisit(store);
  }

  unbind() {
    // Moss delivers the closing commit's final while `stopCapture`'s
    // session.close() is in flight (see stopCapture's comment), and
    // handleFinal/ingestFrame both bail when `this.store` is null — so
    // the store has to stay reachable until capture has fully stopped,
    // not be cleared synchronously here. Any sendModuleData attempted
    // on a disconnecting store during that window already has its
    // rejection caught (see handleFinal), so this is harmless.
    const store = this.store;
    // Captured so the deferred close below only ever closes the visit
    // that was open when unbind() was called — a bind() for a new room
    // during this pending teardown opens its own visit and must not
    // have it swept by this one.
    const v = this.visit;
    // The resolver belongs to the room-view that is leaving; a room-view
    // for the next room replaces it on firstUpdated, possibly before this
    // close runs, and must not label this visit's speakers.
    const labelFor = this.labelFor;
    const stopped = this.stopCapture().catch(() => {});
    this.pendingRequests.set(new Set());
    void stopped.then(() => {
      if (this.store === store) this.store = null;
      if (this.visit === v) void this.endVisit(labelFor);
    });
  }

  /** Display name for the visit, learned by room-view once room info loads. */
  setVisitRoomName(name: string): void {
    if (this.visit && this.visit.roomName !== name) {
      this.visit.roomName = name;
      this.markVisitDirty();
    }
  }

  /** Nickname lookup used to freeze speaker labels when the visit ends. */
  setSpeakerLabelResolver(fn: LabelFor | null): void {
    this.labelFor = fn;
  }

  private openVisit(store: StreamsStore): void {
    // A rebind before an earlier unbind's deferred close has run must
    // not orphan that visit without an `endedAt` and must not leave it
    // to be closed later by that deferred call finding a *different*
    // `this.visit` (this one). End it now instead; endVisit detaches
    // `this.visit`/`this.visitStore` synchronously before its first
    // await, so this is safe to leave unawaited.
    if (this.visit) void this.endVisit();
    const t = store.transcripts;
    if (!t) return;
    const startedAt = Date.now();
    this.visitStore = t.store;
    this.visit = {
      id: transcriptId(t.roomKey, startedAt),
      roomKey: t.roomKey,
      roomName: '',
      startedAt,
      frames: [],
      labels: {},
    };
    this.liveVisit.set(this.visit);
  }

  private appendToVisit(frame: TranscriptFrame): void {
    const v = this.visit;
    if (!v) return;
    if (v.frames.some(f => f.transcriber === frame.transcriber && f.seq === frame.seq)) return;
    v.frames.push({ ...frame });
    // A fresh object reference so subscribers re-render on every frame.
    this.liveVisit.set({ ...v });
    this.markVisitDirty();
  }

  private markVisitDirty(): void {
    this.visitDirty = true;
    if (this.visitWriteTimer !== null) return;
    this.visitWriteTimer = setTimeout(() => {
      this.visitWriteTimer = null;
      void this.writeVisit();
    }, TranscriptionController.VISIT_WRITE_INTERVAL_MS);
  }

  private async writeVisit(): Promise<void> {
    if (!this.visit || !this.visitStore || !this.visitDirty) return;
    // The store only holds visits with content; a visit becomes a record
    // on its first frame.
    if (this.visit.frames.length === 0) return;
    this.visitDirty = false;
    try {
      await this.visitStore.put(this.visit);
    } catch (e) {
      console.error('transcription: visit write failed', e);
    }
  }

  /**
   * Close the visit: freeze speaker labels through `labelFor`, stamp the
   * end, and write it. A visit that never received a frame is never
   * written; the delete makes sure no record of it remains.
   */
  async endVisit(labelFor: LabelFor | null = this.labelFor): Promise<void> {
    const v = this.visit;
    const s = this.visitStore;
    this.visit = null;
    this.visitStore = null;
    this.liveVisit.set(null);
    if (this.visitWriteTimer !== null) {
      clearTimeout(this.visitWriteTimer);
      this.visitWriteTimer = null;
    }
    this.visitDirty = false;
    if (!v || !s) return;
    try {
      if (v.frames.length === 0) {
        await s.delete(v.id);
        return;
      }
      v.endedAt = Date.now();
      for (const pk of new Set(v.frames.map(f => f.speaker))) {
        const label = labelFor?.(pk);
        if (label) v.labels[pk] = label;
      }
      await s.put(v);
    } catch (e) {
      console.error('transcription: visit close failed', e);
    }
  }

  /**
   * Respond to a peer's `requested` flag transition. Called from the
   * module hooks below (onPeerStateChange and onModulePayloadChange).
   *
   * If `isRequested` goes true and we haven't opted in:
   *   - auto-accept on → activate own transcription silently
   *   - otherwise   → add peer to pendingRequests so room-view can
   *                   render a yes/no dialog
   *
   * If `isRequested` goes false, drop the peer from pendingRequests —
   * the request was withdrawn.
   */
  private handleRequestChange(
    peerPubKeyB64: AgentPubKeyB64,
    wasRequested: boolean,
    isRequested: boolean,
  ): void {
    if (!this.store) return;

    if (wasRequested && !isRequested) {
      this.pendingRequests.update(s => {
        if (!s.has(peerPubKeyB64)) return s;
        const next = new Set(s);
        next.delete(peerPubKeyB64);
        return next;
      });
      return;
    }

    if (!isRequested || wasRequested) return;

    // isRequested just flipped true. Skip self-originated requests.
    if (peerPubKeyB64 === this.store.myPubKeyB64) return;

    // A host without local models cannot transcribe: there is nothing to
    // ask the user, and accepting would only advertise `enabled` with no
    // capture behind it.
    if (!this.store.localModels) return;

    // Already opted in? Nothing to do.
    const myEnvelope = get(this.store._myModuleStates)['transcription'];
    const myState = parseTranscriptionPayload(myEnvelope ?? null);
    if (myState?.enabled) return;

    // Auto-accept short-circuits the dialog.
    const autoAccept = readLocalStorage<boolean>(AUTO_ACCEPT_KEY, false);
    if (autoAccept) {
      this.acceptRequest(peerPubKeyB64).catch(e =>
        console.error('transcription: auto-accept failed', e),
      );
      return;
    }

    this.pendingRequests.update(s => {
      if (s.has(peerPubKeyB64)) return s;
      const next = new Set(s);
      next.add(peerPubKeyB64);
      return next;
    });
  }

  /**
   * User said yes (or auto-accept did on their behalf). Activate our
   * transcription module with enabled=true; clear the pending flag
   * for the requester.
   */
  async acceptRequest(requesterPubKeyB64: AgentPubKeyB64): Promise<void> {
    if (!this.store) return;
    const payload: TranscriptionPayload = {
      enabled: true,
      requested: false,
    };
    await this.store.activateModule('transcription', JSON.stringify(payload));
    this.pendingRequests.update(s => {
      if (!s.has(requesterPubKeyB64)) return s;
      const next = new Set(s);
      next.delete(requesterPubKeyB64);
      return next;
    });
  }

  /**
   * User said no. Drop the pending flag without activating.
   */
  declineRequest(requesterPubKeyB64: AgentPubKeyB64): void {
    this.pendingRequests.update(s => {
      if (!s.has(requesterPubKeyB64)) return s;
      const next = new Set(s);
      next.delete(requesterPubKeyB64);
      return next;
    });
  }

  /**
   * Called by the module hook when a peer's transcription envelope
   * transitions or changes payload. Dispatches to handleRequestChange.
   */
  onPeerTranscriptionChange(
    peerPubKeyB64: AgentPubKeyB64,
    prev: ModuleStateEnvelope | null,
    next: ModuleStateEnvelope | null,
  ): void {
    const prevReq = !!parseTranscriptionPayload(prev)?.requested;
    const nextReq = !!parseTranscriptionPayload(next)?.requested;
    if (prevReq === nextReq) return;
    this.handleRequestChange(peerPubKeyB64, prevReq, nextReq);
  }

  /** In-flight startCapture promise. Concurrent callers get the same
   *  promise so `onActivate`'s fire-and-forget call and room-view's
   *  explicit await don't race into two openSession attempts. */
  private _startingCapture: Promise<boolean> | null = null;

  /** Unsubscribe from the module-states subscription that drives
   *  pump start/stop in response to the conversation module's mute
   *  state. Null when not subscribed. */
  private statesUnsub: (() => void) | null = null;

  /** Most recent mic-on / mic-off value observed from the conversation
   *  module payload. Only transitions trigger start/stopPump. */
  private lastMicOn: boolean = false;

  /** In-flight pump-transition promise. Serializes startPump/stopPump
   *  so back-to-back mute toggles can't interleave an acquire with a
   *  release on the same MicSource consumer slot. */
  private _pumpTransition: Promise<void> = Promise.resolve();

  /**
   * Open an ASR session (if one isn't already open), acquire the mic,
   * start the pump loop. Returns true on success, false if the host
   * doesn't expose ASR or the session couldn't open.
   *
   * On failure, sets `lastError` with a user-facing message so
   * room-view can surface it via notifyError. Consumers should clear
   * `lastError` after displaying.
   */
  async startCapture(): Promise<boolean> {
    if (this._startingCapture) return this._startingCapture;
    // The failure revert rides inside the shared promise, so every
    // caller (onActivate for the header button AND for acceptRequest /
    // auto-accept) gets it exactly once.
    const p = this._doStartCapture().then(async ok => {
      if (!ok) await this._revertAdvertisedEnabled();
      return ok;
    });
    this._startingCapture = p;
    try {
      return await p;
    } finally {
      this._startingCapture = null;
    }
  }

  /**
   * The ONE revert for a capture that failed without the user stopping
   * it: if our own module state still advertises `enabled`, deactivate
   * it, so peers do not show us as transcribing (subtitles icon,
   * "transcribing:" list) while we send no frames. Two callers: a start
   * that failed (startCapture's shared promise) and a running session
   * that failed (the session's onError handler). The caller has already
   * set `lastError`.
   *
   * `at`, when given, is what the caller saw when the failure happened:
   * the store and our transcription envelope. The revert runs only if
   * both are still the same objects, so a re-enable (a fresh envelope
   * from activateModule) or a bind() to another room between the failure
   * and this call is left alone.
   */
  private async _revertAdvertisedEnabled(at?: {
    store: StreamsStore;
    envelope: ModuleStateEnvelope | null;
  }): Promise<void> {
    const store = this.store;
    if (!store) return;
    const envelope = get(store._myModuleStates)['transcription'] ?? null;
    if (at && (at.store !== store || at.envelope !== envelope)) return;
    if (!parseTranscriptionPayload(envelope)?.enabled) return;
    try {
      await store.deactivateModule('transcription');
    } catch (e) {
      console.error('transcription: revert of advertised enabled failed', e);
    }
  }

  private async _doStartCapture(): Promise<boolean> {
    if (!this.store) return false;
    if (this.session) return true;

    const g: any = globalThis as any;
    if (!g.MediaStreamTrackProcessor) {
      const msg = 'Your browser does not support the audio capture API required for transcription.';
      console.error('transcription: MediaStreamTrackProcessor not available');
      this.lastError.set(msg);
      return false;
    }

    // Feature-detect the Moss ASR pipeline. Absence or `available: false`
    // means local transcription isn't enabled for this Moss install or
    // this tool. Either surfaces to the user via lastError so they can
    // investigate.
    const localModels = this.store.localModels;
    if (!localModels) {
      console.warn('transcription: weaveClient.localModels not available');
      this.lastError.set(
        'Transcription is not enabled in Moss. Open Moss settings → Services → Transcription to enable it.',
      );
      return false;
    }
    let available = false;
    try {
      const caps = await localModels.capabilities();
      available = !!caps.asr?.available;
    } catch (e) {
      console.error('transcription: capabilities() failed', e);
      this.lastError.set(
        'Could not reach the Moss transcription service. See the developer console for details.',
      );
      return false;
    }
    if (!available) {
      console.warn('transcription: host reports asr.available=false');
      this.lastError.set(
        'Moss reports no transcription model is configured. Open Moss settings → Services → Transcription.',
      );
      return false;
    }

    // Open the Moss ASR session. We do NOT touch the microphone here.
    // The mic is owned by the conversation/WebRTC path; transcription
    // only piggybacks on it once the user has actually unmuted via the
    // mic button. This makes two user-visible guarantees:
    //   1. Clicking "Transcribe call" never triggers the browser
    //      microphone permission prompt. That prompt is tied to
    //      clicking the mic button.
    //   2. While the mic button shows muted, nothing flows to whisper.
    // MicSource pins its shared AudioContext to 48 kHz, so we declare
    // 48000 up front and verify in startPump when the real track
    // becomes available.
    const SAMPLE_RATE_HINT = 48_000;
    this.isStarting.set(true);
    try {
      this.session = await localModels.asr.openSession({
        language: 'en',
        sampleRate: SAMPLE_RATE_HINT,
        channels: 1,
        // Moderate silence-commit threshold. Slightly above Moss's
        // 500 ms default: catches sentence-end pauses, ignores
        // micro-pauses that would over-fragment the decode (our 200 ms
        // experiment produced short windows whisper decoded into
        // confabulations like "I want this to test."). Expected chunk
        // size 4–10 s with this setting, which is whisper's sweet
        // spot for coherent output.
        //
        // Moss accepts this per-session at runtime; @theweave/api
        // hasn't declared it in the public type yet — hence the cast.
        vadSilenceMs: 600,
      } as Parameters<typeof localModels.asr.openSession>[0]);
    } catch (e) {
      console.error('transcription: openSession failed', e);
      this.lastError.set(
        'Moss refused to open a transcription session. Transcription may be disabled in Moss settings or denied for this tool.',
      );
      return false;
    } finally {
      this.isStarting.set(false);
    }

    this.sessionOffFinal = this.session.onFinal((ev: AsrFinalEvent) => {
      this.handleFinal(ev);
    });
    this.sessionOffError = this.session.onError((err: Error) => {
      console.error('transcription: session error', err);
      txLog('session-error', { message: err?.message ?? String(err) });
      // A stop is told apart from a failure by state read synchronously
      // when the error fires, never by promise ordering: `stopInFlight`
      // is set for the whole of any stop (toggle off, stopAndAnnounce,
      // unbind, or an earlier error's own teardown) — its end-of-
      // utterance push, while `this.session` is still set, and its
      // close(). An error inside that window belongs to the stop.
      if (this.stopInFlight) return;
      this.lastError.set(
        `Transcription session ended unexpectedly: ${err?.message ?? 'unknown error'}.`,
      );
      // Session is already closed by Moss when onError fires (the API
      // declares it terminal; host-side closes such as access revoked or
      // view closed arrive here too). Tear down the local pipeline so the
      // next startCapture opens a fresh session, then stop advertising
      // `enabled` — measured against the store and envelope as they are
      // NOW, at the failure, not after the stop has finished.
      const store = this.store;
      const at = store
        ? { store, envelope: get(store._myModuleStates)['transcription'] ?? null }
        : undefined;
      void this.stopCapture()
        .catch(() => {})
        .then(() => (at ? this._revertAdvertisedEnabled(at) : undefined));
    });
    // Wire partial subscription even though v1 doesn't emit — makes
    // the upgrade to streaming partials a one-line change later.
    this.sessionOffPartial = this.session.onPartial(() => {});

    this.framesPushed = 0;
    this.framesSkippedMuted = 0;
    this.finalsReceived = 0;

    // Subscribe to our own module states so we can react to mic
    // mute/unmute transitions. The conversation module's `micMuted`
    // payload is the authoritative "user intends to be heard" signal.
    this.statesUnsub = this.store._myModuleStates.subscribe(states => {
      const convo = parseConversationPayload(states['conversation'] ?? null);
      const micOn = convo ? !convo.micMuted : false;
      if (micOn === this.lastMicOn) return;
      this.lastMicOn = micOn;
      // Serialize transitions so a quick mute→unmute can't race into
      // an acquire happening after a release.
      this._pumpTransition = this._pumpTransition.then(() =>
        micOn ? this.startPump() : this.stopPump(),
      ).catch(e => console.error('transcription: pump transition failed', e));
    });

    // Check current mic state — if the user activated transcription
    // while the mic was already unmuted, kick off the pump now.
    const currentStates = get(this.store._myModuleStates);
    const currentConvo = parseConversationPayload(
      currentStates['conversation'] ?? null,
    );
    const initialMicOn = currentConvo ? !currentConvo.micMuted : false;
    this.lastMicOn = initialMicOn;

    // Periodic stats so the user can see pumping is alive even when
    // no finals are being emitted.
    if (this.statsInterval !== null) window.clearInterval(this.statsInterval);
    this.statsInterval = window.setInterval(() => {
      txLog('stats', {
        pushed: this.framesPushed,
        pumping: !!this.micHandle,
        finals: this.finalsReceived,
        micOn: this.lastMicOn,
      });
    }, 5000);

    txLog('session-opened', {
      sampleRate: SAMPLE_RATE_HINT,
      initialMicOn,
    });

    if (initialMicOn) {
      this._pumpTransition = this._pumpTransition.then(() => this.startPump())
        .catch(e => console.error('transcription: initial pump start failed', e));
    }

    // Note: isCapturing tracks *actively pumping audio to whisper*,
    // not "session is open and listening." The button color drives
    // off isCapturing, so the user only sees the active-color when
    // audio is really flowing to the transcriber.
    return true;
  }

  /**
   * Acquire the mic and start the pump loop. Called when the
   * conversation module's `micMuted` flips to false — i.e., the user
   * hit the unmute button. If the device isn't yet open, MicSource's
   * acquire triggers getUserMedia here, but that's exactly the
   * permission prompt tied to the mic button's action, not the
   * transcription button.
   */
  private async startPump(): Promise<void> {
    if (!this.store || !this.session) return;
    if (this.micHandle) return; // already pumping

    const handle = await this.store.micSource.acquire({
      id: 'transcription',
      onTrackChanged: (newTrack: MediaStreamTrack) => {
        this.onMicTrackChanged(newTrack).catch(e =>
          console.error('transcription: onMicTrackChanged failed', e),
        );
      },
    });
    if (!handle) {
      console.error('transcription: micSource.acquire failed on unmute');
      this.lastError.set('Could not acquire the microphone for transcription.');
      return;
    }
    this.micHandle = handle;

    const settings = handle.track.getSettings();
    const trackRate = settings.sampleRate ?? 48_000;
    if (trackRate !== 48_000) {
      // MicSource pins its AudioContext to 48 kHz so this should not
      // happen. Log loudly if it does — we declared 48000 to Moss and
      // any mismatch means audio is interpreted at the wrong rate.
      console.warn(
        `transcription: track sampleRate=${trackRate} ≠ declared 48000`,
      );
    }

    if (!this.buildTrackReader(handle.track)) {
      try { handle.release(); } catch {}
      this.micHandle = null;
      return;
    }

    this.pipelineGeneration += 1;
    const gen = this.pipelineGeneration;
    // Anchor the decode-window clock at pump start so the first
    // frame after unmute isn't counted against time spent muted.
    this.lastCommitOrFlushMs = Date.now();
    this.pumpLoop(gen).catch(e =>
      console.error('transcription: pump loop error', e),
    );

    this.isCapturing.set(true);
    txLog('pump-started', {
      trackRate,
      trackEnabled: handle.track.enabled,
    });
  }

  /**
   * Signal Moss that the current utterance is over (user muted),
   * stop the pump loop, and release the mic handle. The ASR session
   * stays open — startPump can rebuild the pump without re-opening.
   *
   * Releasing the handle matters: even though MicSource refcounts and
   * won't physically close the device while WebRTC still holds it, we
   * want to stop reading frames ourselves so nothing reaches whisper
   * while the user believes they're muted.
   */
  private async stopPump(): Promise<void> {
    if (!this.micHandle) return;

    // Commit whatever utterance is buffered on the Moss side. This
    // is the proper semantic — mute IS end-of-utterance — rather than
    // pushing silence frames hoping the VAD notices.
    if (this.session) {
      try {
        await this.session.pushAudio(new Int16Array(0), true);
      } catch (e) {
        console.warn('transcription: end-of-utterance signal failed', e);
      }
    }

    this.pipelineGeneration += 1;
    if (this.reader) {
      try { await this.reader.cancel(); } catch {}
      this.reader = null;
    }

    try { this.micHandle.release(); } catch {}
    this.micHandle = null;

    this.flushDebugRecording();

    this.isCapturing.set(false);
    txLog('pump-stopped', {
      pushed: this.framesPushed,
      finals: this.finalsReceived,
    });
  }

  private get debugRecordEnabled(): boolean {
    return readLocalStorage<boolean | string>(DEBUG_RECORD_KEY, false) === true
      || readLocalStorage<boolean | string>(DEBUG_RECORD_KEY, false) === 'true';
  }

  /** Download what was pushed to Moss during this pump as a 48 kHz mono WAV. */
  private flushDebugRecording(): void {
    const frames = this.debugRecording;
    this.debugRecording = [];
    if (frames.length === 0) return;
    const total = frames.reduce((n, f) => n + f.length, 0);
    const pcm = new Int16Array(total);
    let off = 0;
    for (const f of frames) {
      pcm.set(f, off);
      off += f.length;
    }
    const blob = new Blob([pcm16ToWav(pcm, 48_000, 1)], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    a.href = url;
    a.download = `presence-mic-${ts}.wav`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    txLog('debug-recording-saved', { frames: frames.length, ms: Math.round((total / 48_000) * 1000) });
  }

  /**
   * Called by MicSource when the shared track is replaced (device
   * change). Rebuild the MediaStreamTrackProcessor; the ASR session
   * stays open so seq numbering continues uninterrupted.
   */
  private async onMicTrackChanged(newTrack: MediaStreamTrack): Promise<void> {
    if (!this.session) return;
    // onTrackChanged only fires while we hold an acquire. If we've
    // released the handle (stopPump), skip — the acquire slot is gone
    // and a new pump will be built on next unmute.
    if (!this.micHandle) return;

    if (this.reader) {
      try { await this.reader.cancel(); } catch {}
      this.reader = null;
    }
    if (!this.buildTrackReader(newTrack)) {
      console.error('transcription: failed to rebuild reader after device change');
      return;
    }
    this.pipelineGeneration += 1;
    const gen = this.pipelineGeneration;
    this.pumpLoop(gen).catch(e =>
      console.error('transcription: pump loop error after device change', e),
    );
    txLog('track-changed', { trackEnabled: newTrack.enabled });
  }

  private buildTrackReader(track: MediaStreamTrack): boolean {
    const g: any = globalThis as any;
    try {
      const processor = new g.MediaStreamTrackProcessor({ track });
      this.reader = processor.readable.getReader();
      return true;
    } catch (e) {
      console.error('transcription: failed to create MediaStreamTrackProcessor', e);
      return false;
    }
  }

  private async pumpLoop(gen: number): Promise<void> {
    if (!this.reader) return;
    // Push every frame we read. The loop only runs while the mic is
    // held (startPump→stopPump owns the handle), and stopPump is
    // driven by the conversation module's `micMuted` transitions.
    //
    // Defense in depth: we also check `track.enabled` on each frame
    // and refuse to push if false. This is a belt-and-suspenders
    // guarantee — the loop should not be running at all while muted
    // (stopPump should have cancelled the reader), but if a stray
    // frame arrives during a transition we must not leak it to
    // whisper. The user must be able to trust that mute means mute.
    while (
      this.reader &&
      this.session &&
      gen === this.pipelineGeneration
    ) {
      let read: ReadableStreamReadResult<any>;
      try {
        read = await this.reader.read();
      } catch {
        break;
      }
      if (read.done) break;
      if (gen !== this.pipelineGeneration) {
        try { read.value?.close?.(); } catch {}
        break;
      }
      const audioData = read.value as AnyAudioData;
      if (!audioData) continue;
      try {
        const track = this.micHandle?.track;
        if (!track || track.enabled === false) {
          // Hard refuse. No audio to whisper while the user believes
          // the mic is muted, on any platform, under any condition.
          this.framesSkippedMuted += 1;
          continue;
        }

        const pcm16 = audioDataToPcm16(audioData);
        if (this.session) {
          // Long-buffer guard. Most commits happen via Moss's VAD
          // on natural pauses — nothing to do here in the common
          // case. But if a speaker talks past LONG_BUFFER_GUARD_MS
          // without pausing, Moss's 30 s maxBufferMs will soon fire
          // and cut at an arbitrary sample. Try to beat it to a
          // natural amplitude dip; fall back to a hard cap one
          // frame before Moss would cut anyway.
          const now = Date.now();
          const bufferMs = now - this.lastCommitOrFlushMs;
          let forceFlush = false;
          let flushReason: 'quiet-dip' | 'hard-cap' | null = null;
          if (bufferMs >= TranscriptionController.LONG_BUFFER_HARD_MS) {
            forceFlush = true;
            flushReason = 'hard-cap';
          } else if (bufferMs >= TranscriptionController.LONG_BUFFER_GUARD_MS) {
            if (pcm16Rms(pcm16) < TranscriptionController.QUIET_RMS_THRESHOLD) {
              forceFlush = true;
              flushReason = 'quiet-dip';
            }
          }
          try {
            await this.session.pushAudio(pcm16, forceFlush);
            this.framesPushed += 1;
            if (this.debugRecordEnabled) this.debugRecording.push(pcm16.slice());
            if (forceFlush) {
              txLog('forced-flush', { bufferMs, reason: flushReason });
              this.lastCommitOrFlushMs = now;
            }
          } catch (e) {
            console.error('transcription: pushAudio failed', e);
          }
        }
      } finally {
        try { audioData.close(); } catch {}
      }
    }
  }

  /**
   * Frames broadcast since the last `maxCommittedSeq` envelope
   * refresh. Receivers only need approximate progress — updating
   * module state on every final would flood the signal channel, so
   * batch by N frames.
   */
  private framesSinceCommit = 0;
  private static readonly COMMIT_EVERY_N = 5;

  /**
   * Wall-clock ms of the most recent natural commit (handleFinal)
   * or forced flush (pump loop). Tracks the current un-committed
   * buffer's age on Moss's side so the long-buffer guard can kick
   * in for speakers who never pause. Reset in startPump so
   * mute/unmute cycles don't count silence against the buffer.
   */
  private lastCommitOrFlushMs = 0;

  /**
   * Long-buffer guard — handles speakers who talk past Moss's
   * natural VAD without pausing (monologues, script reading,
   * thinking-aloud). We do nothing for the first LONG_BUFFER_GUARD
   * seconds; past that, we start computing per-frame RMS and flush
   * on the next quiet dip, so the split happens at a real phrase
   * boundary rather than an arbitrary time cut. If we reach
   * LONG_BUFFER_HARD without finding a dip, flush unconditionally
   * to beat Moss's 30 s `maxBufferMs` which would otherwise cut at
   * a completely arbitrary sample.
   *
   * Values are well above typical conversational turn length, so
   * the guard is a rare-case safety net — normal speech commits
   * via VAD well before this fires.
   */
  private static readonly LONG_BUFFER_GUARD_MS = 20_000;
  private static readonly LONG_BUFFER_HARD_MS = 28_000;
  /**
   * RMS threshold below which a frame counts as "quiet enough to
   * split here". Slightly above Moss's vadSilenceRms default
   * (0.01) because Presence runs with browser noiseSuppression on,
   * which lifts pure silence slightly. Hand-tuned; bisect if the
   * guard never fires or fires too eagerly.
   */
  private static readonly QUIET_RMS_THRESHOLD = 0.015;

  private handleFinal(ev: AsrFinalEvent): void {
    if (!this.store) return;
    this.finalsReceived += 1;
    // Reset the decode-window clock regardless of whether the final
    // carried text — even an empty commit means whisper decoded and
    // flushed its buffer, which is all we need to know.
    this.lastCommitOrFlushMs = Date.now();
    const text = (ev.text ?? '').trim();
    // Moss occasionally commits an empty-text final on a pure-silence
    // flush (endOfUtterance with no speech). Don't broadcast those.
    if (!text) {
      txLog('final-empty', { tStart: ev.tStart, tEnd: ev.tEnd });
      return;
    }
    txLog('final-committed', {
      seq: this.seq,
      tStart: ev.tStart,
      tEnd: ev.tEnd,
      text: text.slice(0, 80),
    });

    const me = this.store.myPubKeyB64;
    const frame: TranscriptFrame = {
      speaker: me,
      transcriber: me,
      seq: this.seq++,
      tStart: ev.tStart,
      tEnd: ev.tEnd,
      committedAtMs: Date.now(),
      text,
      confidence: ev.confidence,
      lang: ev.lang,
    };

    // Broadcast to everyone else. No targets argument → all known
    // agents minus self (sendModuleData's default behavior).
    const json = JSON.stringify(frame);
    this.store.sendModuleData('transcription', json).catch(e =>
      console.error('transcription: broadcast failed', e),
    );

    // Also land it in our own accumulator, which feeds the live pane and
    // the visit. Route through the same ingestion path so the merge rules
    // apply uniformly.
    this.ingestFrame(frame);

    // Periodically publish our progress (`maxCommittedSeq`) in the module
    // payload, as `finalSeq` is published at stop, so a receiver can check
    // the completeness of what it holds from us.
    this.framesSinceCommit++;
    if (this.framesSinceCommit >= TranscriptionController.COMMIT_EVERY_N) {
      this.framesSinceCommit = 0;
      this.publishProgress().catch(e =>
        console.error('transcription: progress publish failed', e),
      );
    }
  }

  /**
   * Push an updated `maxCommittedSeq` into our module payload.
   * Leaves `enabled` / `requested` as they are; the caller should
   * only invoke this while the module is active.
   */
  private async publishProgress(): Promise<void> {
    if (!this.store) return;
    const current = parseTranscriptionPayload(
      get(this.store._myModuleStates)['transcription'] ?? null,
    );
    if (!current) return;
    const next: TranscriptionPayload = {
      ...current,
      maxCommittedSeq: this.seq - 1,
    };
    await this.store.updateModuleState('transcription', JSON.stringify(next));
  }

  /**
   * Tear-down call from the header-button off-toggle or from
   * room-view on exit. Publishes a final state with `finalSeq` set so
   * receivers know our transcript is complete, then deactivates.
   * The subsequent onDeactivate hook releases mic + closes the ASR
   * session.
   */
  async stopAndAnnounce(): Promise<void> {
    if (!this.store) return;
    // Finish capture first: the closing commit may add a last frame, and
    // finalSeq has to cover it or peers record the transcript as a gap.
    await this.stopCapture();
    const current = parseTranscriptionPayload(
      get(this.store._myModuleStates)['transcription'] ?? null,
    );
    if (current) {
      const finalSeq = this.seq > 0 ? this.seq - 1 : undefined;
      const announcement: TranscriptionPayload = {
        ...current,
        enabled: false,
        requested: false,
        maxCommittedSeq: finalSeq,
        finalSeq,
      };
      try {
        await this.store.updateModuleState(
          'transcription',
          JSON.stringify(announcement),
        );
      } catch (e) {
        console.error('transcription: final announcement failed', e);
      }
    }
    await this.store.deactivateModule('transcription');
  }

  /**
   * Insert a TranscriptFrame into the per-speaker accumulator on the
   * store. Slots by `tStart` within the speaker's ordered list. No
   * volunteer-merge logic yet — Phase 1 invariant is speaker ===
   * transcriber, so out-of-order arrival is the only real concern.
   */
  private ingestFrame(frame: TranscriptFrame): void {
    if (!this.store) return;
    const entry: TranscriptEntry = {
      seq: frame.seq,
      tStart: frame.tStart,
      tEnd: frame.tEnd,
      committedAtMs:
        typeof frame.committedAtMs === 'number' ? frame.committedAtMs : Date.now(),
      text: frame.text,
      transcriber: frame.transcriber,
      confidence: frame.confidence,
      lang: frame.lang,
    };
    this.store._transcriptLog.update(log => {
      const existing = log.get(frame.speaker) ?? [];
      // Drop duplicates (same transcriber + seq).
      if (existing.some(e => e.transcriber === entry.transcriber && e.seq === entry.seq)) {
        return log;
      }
      // Insertion sort by tStart. Typical path appends at the end.
      let i = existing.length;
      while (i > 0 && existing[i - 1].tStart > entry.tStart) i--;
      const next = [...existing.slice(0, i), entry, ...existing.slice(i)];
      const nextLog = new Map(log);
      nextLog.set(frame.speaker, next);
      return nextLog;
    });
    this.appendToVisit(frame);
  }

  /**
   * In-flight stopCapture promise, shared across concurrent callers.
   * `StreamsStore.disconnect()` has no re-entry guard and runs up to
   * three times per room leave (the quit button, then teardown from
   * both room-view and room-container), and every call reaches this
   * method via unbind(). A second call must wait on the same close()
   * Moss is already running rather than start a fresh no-op stop that
   * would resolve before the real one delivers the closing commit —
   * unbind()'s deferred store-clear/endVisit would then run too early
   * and drop that final.
   */
  private stopInFlight: Promise<void> | null = null;

  async stopCapture(): Promise<void> {
    if (this.stopInFlight) return this.stopInFlight;
    const p = this._doStopCapture();
    this.stopInFlight = p;
    try {
      await p;
    } finally {
      this.stopInFlight = null;
    }
  }

  private async _doStopCapture(): Promise<void> {
    // Unsubscribe first so state changes during teardown don't trigger
    // a new startPump after we've started closing the session.
    if (this.statesUnsub) {
      try { this.statesUnsub(); } catch {}
      this.statesUnsub = null;
    }
    this.lastMicOn = false;
    this.framesSinceCommit = 0;
    if (this.statsInterval !== null) {
      window.clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
    txLog('session-closing', {
      pushed: this.framesPushed,
      skippedMuted: this.framesSkippedMuted,
      finals: this.finalsReceived,
    });

    // Stop the pump first so the end-of-utterance signal reaches Moss
    // before close(). Moss commits that audio while closing and delivers
    // the resulting finals before close() resolves, so the listeners
    // stay attached until then or the last utterance is lost.
    await this.stopPump();

    if (this.session) {
      const s = this.session;
      this.session = null;
      try { await s.close(); } catch {}
    }

    if (this.sessionOffFinal) { try { this.sessionOffFinal(); } catch {} }
    if (this.sessionOffError) { try { this.sessionOffError(); } catch {} }
    if (this.sessionOffPartial) { try { this.sessionOffPartial(); } catch {} }
    this.sessionOffFinal = null;
    this.sessionOffError = null;
    this.sessionOffPartial = null;

    this.isCapturing.set(false);
  }

  /**
   * Handle a transcript frame arriving from a peer via
   * `sendModuleData('transcription', …)`. The `_fromAgent` parameter
   * is the signal sender — redundant with `frame.transcriber` in
   * Phase 1 (they must match) but kept as an integrity check.
   */
  receiveFrame(fromAgent: AgentPubKeyB64, chunk: string): void {
    if (!this.store) return;
    let frame: TranscriptFrame;
    try {
      frame = JSON.parse(chunk);
    } catch {
      console.warn('transcription: malformed frame from', fromAgent);
      return;
    }
    // Phase 1 invariant: signal sender must be the transcriber. A peer
    // claiming to transcribe someone else is a Phase 2 (volunteer)
    // thing and should be ignored here.
    if (frame.transcriber !== fromAgent) {
      console.warn('transcription: frame transcriber ≠ signal sender', {
        fromAgent,
        transcriber: frame.transcriber,
      });
      return;
    }
    if (frame.speaker !== frame.transcriber) {
      // Same reason — self-transcription only in Phase 1.
      return;
    }
    txLog('recv', {
      from: fromAgent.slice(0, 10),
      seq: frame.seq,
      text: frame.text.slice(0, 80),
    });
    this.ingestFrame(frame);
  }
}

/**
 * Convert an AudioData frame (f32 planar, typically 480 samples at
 * 48 kHz = 10 ms per chunk in the Electron renderer) to Int16Array
 * PCM16 that Moss's ASR session expects.
 *
 * The clamp + scale uses the asymmetric range convention (negative
 * values scaled by 0x8000, positive by 0x7fff) so a full-scale
 * negative sample doesn't wrap to +32767.
 */
/**
 * RMS amplitude of a PCM16 frame, normalized to 0..1 so the
 * threshold is expressed in the same units as Moss's
 * vadSilenceRms. Used by the long-buffer guard to find a natural
 * amplitude dip to split a very long turn at. O(samples) — a
 * single 10 ms frame at 48 kHz is 480 samples, negligible cost.
 */
function pcm16ToWav(pcm: Int16Array, sampleRate: number, channels: number): ArrayBuffer {
  const dataLength = pcm.length * 2;
  const buf = new ArrayBuffer(44 + dataLength);
  const v = new DataView(buf);
  const ascii = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + dataLength, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * 2, true);
  v.setUint16(32, channels * 2, true);
  v.setUint16(34, 16, true);
  ascii(36, 'data');
  v.setUint32(40, dataLength, true);
  new Int16Array(buf, 44).set(pcm);
  return buf;
}

function pcm16Rms(pcm: Int16Array): number {
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) {
    const s = pcm[i];
    sum += s * s;
  }
  return Math.sqrt(sum / pcm.length) / 0x8000;
}

function audioDataToPcm16(frame: AnyAudioData): Int16Array {
  const samples: number = frame.numberOfFrames;
  const fp = new Float32Array(samples);
  try {
    frame.copyTo(fp, { planeIndex: 0, format: 'f32-planar' });
  } catch {
    // Some runtimes only expose 'f32' (interleaved). For mono the
    // layout is identical; fall back without specifying format.
    frame.copyTo(fp, { planeIndex: 0 });
  }
  const out = new Int16Array(samples);
  for (let i = 0; i < samples; i++) {
    let s = fp[i];
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

const controller = new TranscriptionController();
export { controller as transcriptionController };

// =========================================================================
// Module definition
// =========================================================================

const transcriptionModule: ModuleDefinition = {
  id: 'transcription',
  type: 'agent',
  label: 'Transcription',
  icon: mdiSubtitlesOutline,
  activationControl: 'sender',

  defaultState() {
    return JSON.stringify(DEFAULT_TRANSCRIPTION_PAYLOAD);
  },

  onData(agentPubKeyB64, chunk) {
    controller.receiveFrame(agentPubKeyB64, chunk);
  },

  onActivate(context) {
    // Fired after `activateModule('transcription', ...)` updates our
    // own state. Gate capture on `enabled` — a header-button click
    // activates with `{enabled: true, requested: true}` so both sides
    // hold. A future "request without transcribing myself" UX could
    // split them, but v1 couples them.
    const envelope = get(context.streamsStore._myModuleStates)['transcription'];
    const payload = parseTranscriptionPayload(envelope ?? null);
    if (payload?.enabled) {
      controller.startCapture().catch(e =>
        console.error('transcription: startCapture failed', e),
      );
    }
  },

  onDeactivate() {
    controller.stopCapture().catch(e =>
      console.error('transcription: stopCapture failed', e),
    );
  },

  onPeerStateChange(agentPubKeyB64, prev, next) {
    controller.onPeerTranscriptionChange(agentPubKeyB64, prev, next);
  },

  onModulePayloadChange(agentPubKeyB64, prev, next) {
    controller.onPeerTranscriptionChange(agentPubKeyB64, prev, next);
  },
};

registerModule(transcriptionModule);
