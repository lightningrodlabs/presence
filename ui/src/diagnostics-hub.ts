/**
 * DiagnosticsHub — owner of the diagnostic-log request/response pipeline
 * (store-decomposition round two, Task 3; see
 * docs/superpowers/specs/2026-09-03-owner-extraction-design.md). Owns the
 * three diagnostic `Writable`s, the conversation-participants set, the
 * retry-driven request loop, the merged-log builders, and the two
 * DiagnosticRequest/DiagnosticResponse signal handlers.
 */
import {
  AgentPubKey,
  AgentPubKeyB64,
  decodeHashFromBase64,
  encodeHashToBase64,
} from '@holochain/client';
import { get, writable, type Writable } from '@holochain-open-dev/stores';
import type { DiagnosticSnapshot, RoomSignal } from './types';
import type { SignalMsgType } from './transport/wire-contract';
import { buildDiagnosticSnapshot } from './diagnostic-snapshot-policy';
import { parseSignalPayload } from './signal-payload';
import type { PresenceLogger } from './logging';

export type DiagnosticsHubBindings = {
  /** deps.bus.sendMessage, late-bound. */
  sendMessage: (
    toAgents: AgentPubKey[],
    msgType: SignalMsgType,
    payload?: string
  ) => Promise<void>;
  logger: PresenceLogger;
  now: () => number;
  /** clock.setTimeout, late-bound. The moved body never disarms this
   *  timer (it self-guards via `stillPending`/attempt-number checks on
   *  fire), so there is no `clearTimeout` binding — matches the origin
   *  file, which has no clearTimeout call site for these timers. */
  setTimeout: (fn: () => void, ms: number) => number;
  myPubKeyB64: () => AgentPubKeyB64;
  /** StreamsStore.globalPresenceSet(), late-bound (recipient list). */
  globalPresenceSet: () => Set<AgentPubKeyB64>;
  /** peer record's signalsRttEwma, read-only (RTT-scaled timeout). */
  peerRttEwma: (k: AgentPubKeyB64) => number | undefined;
};

export class DiagnosticsHub {
  /**
   * Diagnostic logs received from remote peers via Holochain signals
   */
  _receivedDiagnosticLogs: Writable<Record<AgentPubKeyB64, DiagnosticSnapshot>> = writable({});

  /**
   * Peers a diagnostic request is in-flight for. Value carries the
   * current retry attempt (1-based). Removed on response receipt or
   * when retries are exhausted (and moved to `_failedDiagnosticRequests`).
   */
  _pendingDiagnosticRequests: Writable<Record<AgentPubKeyB64, { attempts: number; startedAt: number }>> = writable({});

  /**
   * Peers that exhausted retries with no response. UI surfaces these
   * so the user can see partial coverage and (optionally) re-try.
   */
  _failedDiagnosticRequests: Writable<Record<AgentPubKeyB64, true>> = writable({});

  /**
   * Peers we have actually had a WebRTC media connection with this
   * session — added the first time a connection to them reaches the
   * `connected` state. Session-scoped; entries are kept even after the
   * peer disconnects, because a peer who dropped mid-call is exactly who
   * we want diagnostic logs from. Drives `requestDiagnosticLogs()`'s
   * recipient list so a room-level request targets genuine call
   * participants rather than every known (incl. merely heard-about) agent.
   */
  private _conversationParticipants = new Set<AgentPubKeyB64>();

  constructor(private readonly b: DiagnosticsHubBindings) {}

  /**
   * Record a peer as a genuine call participant for diagnostic-log
   * targeting. Called from `_handleMediaConnected` the first time a
   * connection to them reaches `connected`.
   */
  noteConversationParticipant(pubKeyB64: AgentPubKeyB64): void {
    this._conversationParticipants.add(pubKeyB64);
  }

  /**
   * Clear cached diagnostic results so the request button returns to its
   * default requestable colour. Called after the merged log is downloaded
   * (results consumed). With no argument, clears every peer.
   */
  clearReceivedDiagnostics(pubKeyB64?: AgentPubKeyB64): void {
    this._receivedDiagnosticLogs.update(curr => {
      if (!pubKeyB64) return {};
      const next = { ...curr };
      delete next[pubKeyB64];
      return next;
    });
    this._failedDiagnosticRequests.update(curr => {
      if (!pubKeyB64) return {};
      const next = { ...curr };
      delete next[pubKeyB64];
      return next;
    });
  }

  /** Maximum number of attempts before marking a diagnostic request failed. */
  private static readonly DIAGNOSTIC_MAX_ATTEMPTS = 3;
  /** Per-attempt timeout (ms) before retrying or giving up — the no-RTT-
   *  sample default, and the floor for the RTT-scaled timeout below.
   *  Diagnostic attempt cadence, NOT a liveness predicate. */
  private static readonly DIAGNOSTIC_ATTEMPT_TIMEOUT_MS = 8_000;
  /** Ceiling for the RTT-scaled diagnostic attempt timeout
   *  (`_computeDiagnosticAttemptTimeout`). Diagnostic attempt cadence,
   *  NOT a liveness predicate. Field observation (2026-08-11): diagnostic
   *  requests failed 3x8s against the same 20-58s signals RTTs that were
   *  blowing the SDP-exchange ceiling — the retries were noise, not
   *  recovery attempts. */
  private static readonly DIAGNOSTIC_ATTEMPT_TIMEOUT_MAX_MS = 30_000;
  /** RTT multiplier for the diagnostic attempt timeout
   *  (`_computeDiagnosticAttemptTimeout`). */
  private static readonly DIAGNOSTIC_TIMEOUT_RTT_MULTIPLIER = 4;

  /**
   * Request diagnostic logs from a specific peer (or, with no argument,
   * every peer in this conversation) via Holochain signal. Retries up to
   * DIAGNOSTIC_MAX_ATTEMPTS times if no response arrives within the
   * per-attempt timeout (`_computeDiagnosticAttemptTimeout` — RTT-scaled,
   * DIAGNOSTIC_ATTEMPT_TIMEOUT_MS with no RTT sample). Peers that exhaust
   * retries land in `_failedDiagnosticRequests`.
   *
   * The room-level recipient set is the union of `_conversationParticipants`
   * (peers we have had a media connection with this session, incl. ones who
   * have since dropped) and the current `globalPresenceSet()`. This
   * deliberately excludes merely heard-about (`'told'`) agents who were
   * never in the call — requesting from them only produced timeouts and
   * polluted the merged log.
   *
   * Calling again for a peer already in pending/failed re-starts the
   * retry loop from attempt 1 — lets the user manually retry from the UI.
   */
  async requestDiagnosticLogs(pubKeyB64?: AgentPubKeyB64) {
    const targetKeys = pubKeyB64
      ? [pubKeyB64]
      : [
          ...new Set<AgentPubKeyB64>([
            ...this._conversationParticipants,
            ...this.b.globalPresenceSet(),
          ]),
        ].filter(a => a !== this.b.myPubKeyB64());
    if (targetKeys.length === 0) return;

    // Clear any prior failed state for these peers — manual re-trigger.
    this._failedDiagnosticRequests.update(curr => {
      const next = { ...curr };
      targetKeys.forEach(k => delete next[k]);
      return next;
    });

    targetKeys.forEach(k => this._startDiagnosticAttempt(k, 1));

    this.b.logger.logCustomMessage(
      `Requested diagnostic logs from ${targetKeys.map(k => k.slice(0, 8)).join(', ')}`
    );
  }

  /**
   * RTT-scaled diagnostic-attempt timeout (ms) for `peerB64`. Reuses the
   * same signals RTT EWMA that scales the SDP-exchange timeout
   * (`_computeSdpTimeout`) — a slow signals path gets a diagnostic
   * round-trip window it can actually clear instead of retrying blind.
   * No RTT sample yet -> the fixed DIAGNOSTIC_ATTEMPT_TIMEOUT_MS default
   * (unchanged behaviour). Diagnostic attempt cadence, NOT a liveness
   * predicate.
   */
  private _computeDiagnosticAttemptTimeout(peerB64: AgentPubKeyB64): number {
    const rtt = this.b.peerRttEwma(peerB64);
    if (rtt === undefined || rtt <= 0) {
      return DiagnosticsHub.DIAGNOSTIC_ATTEMPT_TIMEOUT_MS;
    }
    return Math.min(
      DiagnosticsHub.DIAGNOSTIC_ATTEMPT_TIMEOUT_MAX_MS,
      Math.max(
        DiagnosticsHub.DIAGNOSTIC_ATTEMPT_TIMEOUT_MS,
        Math.round(rtt * DiagnosticsHub.DIAGNOSTIC_TIMEOUT_RTT_MULTIPLIER)
      )
    );
  }

  /**
   * Single attempt of a diagnostic request to one peer. Sends the signal,
   * schedules a timeout that either retries (attempt + 1) or marks failed.
   * Handler is no-op if a response has already arrived by the time the
   * timeout fires (the peer is no longer pending).
   */
  private _startDiagnosticAttempt(peerB64: AgentPubKeyB64, attempt: number): void {
    this._pendingDiagnosticRequests.update(curr => ({
      ...curr,
      [peerB64]: { attempts: attempt, startedAt: this.b.now() },
    }));

    const peerHash = decodeHashFromBase64(peerB64);
    this.b.sendMessage([peerHash], 'DiagnosticRequest', '').catch(e => {
      this.b.logger.logCustomMessage(
        `DiagnosticRequest send failed [${peerB64.slice(0, 8)}] attempt ${attempt}: ${e?.message ?? e}`
      );
    });

    this.b.setTimeout(() => {
      const stillPending = get(this._pendingDiagnosticRequests)[peerB64];
      // Response arrived (handler cleared pending) or user re-triggered
      // a fresh attempt that supersedes this one.
      if (!stillPending || stillPending.attempts !== attempt) return;

      if (attempt < DiagnosticsHub.DIAGNOSTIC_MAX_ATTEMPTS) {
        this.b.logger.logCustomMessage(
          `DiagnosticRequest timeout [${peerB64.slice(0, 8)}] attempt ${attempt}, retrying`
        );
        this._startDiagnosticAttempt(peerB64, attempt + 1);
      } else {
        this.b.logger.logCustomMessage(
          `DiagnosticRequest failed [${peerB64.slice(0, 8)}] after ${attempt} attempts`
        );
        this._pendingDiagnosticRequests.update(curr => {
          const next = { ...curr };
          delete next[peerB64];
          return next;
        });
        this._failedDiagnosticRequests.update(curr => ({ ...curr, [peerB64]: true }));
      }
    }, this._computeDiagnosticAttemptTimeout(peerB64));
  }

  /**
   * Build a merged diagnostic log combining local and received remote events for a peer.
   */
  exportMergedLogs(pubKeyB64: AgentPubKeyB64): object {
    const localAgentEvents = this.b.logger.getRecentAgentEvents();
    const localCustomLogs = this.b.logger.getRecentCustomLogs();
    const remoteSnapshot = get(this._receivedDiagnosticLogs)[pubKeyB64];

    type MergedEntry = { timestamp: number; source: 'local' | 'remote'; type: string; detail: string; connectionId?: string };
    const merged: MergedEntry[] = [];

    // Add local agent events (all agents, to see the full picture)
    Object.entries(localAgentEvents).forEach(([agent, events]) => {
      events.forEach(e => {
        merged.push({
          timestamp: e.timestamp,
          source: 'local',
          type: 'event',
          detail: `[${agent.slice(0, 8)}] ${e.event}`,
          connectionId: e.connectionId,
        });
      });
    });

    // Add local custom logs
    localCustomLogs.forEach(log => {
      merged.push({
        timestamp: log.timestamp,
        source: 'local',
        type: 'custom',
        detail: log.log,
      });
    });

    // Add remote events if available
    if (remoteSnapshot) {
      Object.entries(
        remoteSnapshot.agentEvents.reduce((acc, e) => {
          (acc[e.agent] = acc[e.agent] || []).push(e);
          return acc;
        }, {} as Record<string, typeof remoteSnapshot.agentEvents>)
      ).forEach(([agent, events]) => {
        events.forEach(e => {
          merged.push({
            timestamp: e.timestamp,
            source: 'remote',
            type: 'event',
            detail: `[${agent.slice(0, 8)}] ${e.event}`,
            connectionId: e.connectionId,
          });
        });
      });

      remoteSnapshot.customLogs.forEach(log => {
        merged.push({
          timestamp: log.timestamp,
          source: 'remote',
          type: 'custom',
          detail: log.log,
        });
      });
    }

    merged.sort((a, b) => a.timestamp - b.timestamp);

    return {
      generatedAt: this.b.now(),
      localAgent: this.b.myPubKeyB64(),
      remoteAgent: pubKeyB64,
      hasRemoteLogs: !!remoteSnapshot,
      remoteSessionId: remoteSnapshot?.sessionId,
      entries: merged,
    };
  }

  /**
   * Build a merged diagnostic log combining local events with every
   * received remote snapshot. The result is a single timeline ordered
   * by timestamp, tagged with which agent emitted each entry. Used by
   * the room-level bulk download path.
   */
  exportMergedLogsAll(): object {
    const localAgentEvents = this.b.logger.getRecentAgentEvents();
    const localCustomLogs = this.b.logger.getRecentCustomLogs();
    const allRemote = get(this._receivedDiagnosticLogs);

    type MergedEntry = {
      timestamp: number;
      source: AgentPubKeyB64; // emitter of the entry
      sourceLabel: 'local' | 'remote';
      type: string;
      detail: string;
      connectionId?: string;
    };
    const merged: MergedEntry[] = [];

    Object.entries(localAgentEvents).forEach(([agent, events]) => {
      events.forEach(e => {
        merged.push({
          timestamp: e.timestamp,
          source: this.b.myPubKeyB64(),
          sourceLabel: 'local',
          type: 'event',
          detail: `[${agent.slice(0, 8)}] ${e.event}${e.detail ? ` ${e.detail}` : ''}`,
          connectionId: e.connectionId,
        });
      });
    });
    localCustomLogs.forEach(log => {
      merged.push({
        timestamp: log.timestamp,
        source: this.b.myPubKeyB64(),
        sourceLabel: 'local',
        type: 'custom',
        detail: log.log,
      });
    });

    const respondingPeers: AgentPubKeyB64[] = [];
    Object.entries(allRemote).forEach(([peerB64, snapshot]) => {
      respondingPeers.push(peerB64);
      snapshot.agentEvents.forEach(e => {
        merged.push({
          timestamp: e.timestamp,
          source: peerB64,
          sourceLabel: 'remote',
          type: 'event',
          detail: `[${e.agent.slice(0, 8)}] ${e.event}${e.detail ? ` ${e.detail}` : ''}`,
          connectionId: e.connectionId,
        });
      });
      snapshot.customLogs.forEach(log => {
        merged.push({
          timestamp: log.timestamp,
          source: peerB64,
          sourceLabel: 'remote',
          type: 'custom',
          detail: log.log,
        });
      });
    });

    merged.sort((a, b) => a.timestamp - b.timestamp);

    return {
      generatedAt: this.b.now(),
      localAgent: this.b.myPubKeyB64(),
      respondingPeers,
      entries: merged,
    };
  }

  /**
   * Handle a DiagnosticRequest signal — gather recent logs and send back.
   */
  async handleDiagnosticRequest(signal: Extract<RoomSignal, { type: 'Message' }>) {
    const allRecentEvents = this.b.logger.getRecentAgentEvents();
    const flatEvents = Object.values(allRecentEvents).flat();
    const recentCustomLogs = this.b.logger.getRecentCustomLogs();

    // The size guard and its self-declaring truncation live in
    // diagnostic-snapshot-policy.ts (Phase 5 item 2).
    const { payload } = buildDiagnosticSnapshot({
      fromAgent: this.b.myPubKeyB64(),
      sessionId: this.b.logger.sessionId,
      agentEvents: flatEvents,
      customLogs: recentCustomLogs,
      generatedAt: this.b.now(),
    });
    await this.b.sendMessage(
      [signal.from_agent],
      'DiagnosticResponse',
      payload,
    );
  }

  /**
   * Handle a DiagnosticResponse signal — store the received logs.
   */
  handleDiagnosticResponse(signal: Extract<RoomSignal, { type: 'Message' }>) {
    const pubkeyB64 = encodeHashToBase64(signal.from_agent);

    try {
      const parsedSnapshot = parseSignalPayload<DiagnosticSnapshot>(signal.payload);
      if (!parsedSnapshot.ok) {
        console.warn(
          `Dropped DiagnosticResponse from ${pubkeyB64.slice(0, 8)}: ${parsedSnapshot.error}`
        );
        return;
      }
      const snapshot = parsedSnapshot.value;
      this._receivedDiagnosticLogs.update(current => ({ ...current, [pubkeyB64]: snapshot }));
      this._pendingDiagnosticRequests.update(curr => {
        const next = { ...curr };
        delete next[pubkeyB64];
        return next;
      });
      this._failedDiagnosticRequests.update(curr => {
        if (!curr[pubkeyB64]) return curr;
        const next = { ...curr };
        delete next[pubkeyB64];
        return next;
      });
      const truncationNote = snapshot.truncated
        ? ` (TRUNCATED: ${snapshot.truncated.events} events, ${snapshot.truncated.customLogs} custom logs dropped at sender)`
        : '';
      this.b.logger.logCustomMessage(
        `Received diagnostic logs from [${pubkeyB64.slice(0, 8)}]: ${snapshot.agentEvents.length} events, ${snapshot.customLogs.length} custom logs${truncationNote}`
      );
    } catch (e) {
      console.warn('Failed to parse DiagnosticResponse:', e);
    }
  }
}
