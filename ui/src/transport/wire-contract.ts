/**
 * Phase 1.5 — the wire surface, declared once.
 *
 * Two mechanism failures motivate this file (MAINTAINABILITY_ASSESSMENT.md
 * Phase 1.5). First, `SdpFsm` entered the wire (2026-05-01, `2d20e93`) with
 * nothing that forced anyone to notice the wire had changed; reconstructing
 * which releases could parse it required `git grep` archaeology over old tags
 * (§3.8). Second, capability was *inferred* by probing for fields that happened
 * to ship in the same commit, rather than *declared* — so every future wire
 * feature would have needed its own bespoke probe.
 *
 * This module is the single declaration of:
 *
 *   1. The signal-type union (`SignalMsgType`). `RoomClient.sendMessage` is
 *      typed against it and `StreamsStore._processSignal` switches
 *      exhaustively over it, so a new msg_type cannot be sent or handled
 *      without adding it here — and adding it here is a **compile error**
 *      until `WIRE_CONTRACT` gains its row (the `routeTransportPhase`
 *      exhaustiveness trick: `Record<SignalMsgType, …>` fails to typecheck
 *      with a missing key).
 *   2. What each type requires of the peer before we may emit it
 *      (`requiresCap`). The rule, adopted 2026-07-28: **never emit a signal
 *      type the peer has not declared a capability for; no declaration ⇒ the
 *      baseline set** (`requiresCap: null` rows — the types every released
 *      build parses). `emittableSignalTypes` is the one implementation.
 *   3. The conversation-payload fields written and read
 *      (`CONVERSATION_PAYLOAD_WRITES` / `_READS`), completeness-checked
 *      against `ConversationPayload` at compile time.
 *
 * `wire-contract.test.ts` snapshot-tests all of this against
 * `fixtures/wire-contract.json`. Changing the wire without updating the
 * fixture fails `verify`; updating the fixture is the deliberate ceremony
 * that did not exist when `SdpFsm` shipped. `compat-corpus.test.ts` then
 * checks the declared surface against every released wire shape in
 * `fixtures/compat/`.
 *
 * Pure by construction: no runtime imports, plain data and two small
 * functions, table-tested without mocks.
 */

import type { ConversationPayload } from '../room/modules/conversation';

// ---------------------------------------------------------------------------
// Signal types
// ---------------------------------------------------------------------------

/**
 * Every `msg_type` this build can put on or take off the wire. The wire
 * encoding is `RoomSignal { type: 'Message', msg_type, payload }` — see
 * `types.ts:RoomSignal` and `room-client.ts:sendMessage`.
 */
export const SIGNAL_MSG_TYPES = [
  'PingUi',
  'PongUi',
  'InitRequest',
  'InitAccept',
  'SdpData',
  'SdpFsm',
  'SdpFsmScreen',
  'LeaveUi',
  'DiagnosticRequest',
  'DiagnosticResponse',
  'ModuleState',
  'ModuleData',
] as const;

export type SignalMsgType = (typeof SIGNAL_MSG_TYPES)[number];

/** Narrow an incoming wire string. A peer on a newer build may legitimately
 *  send a type this build does not know; callers drop it with a warn, never
 *  throw (`signal-payload.ts` rule: a bad payload drops one signal, never
 *  the session). */
export function isSignalMsgType(x: string): x is SignalMsgType {
  return (SIGNAL_MSG_TYPES as readonly string[]).includes(x);
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/** The peer's build can parse the `SdpFsm` signal type (FSM signaling
 *  channel; v0.14.8+). */
export const CAP_SDP_FSM = 'sdp-fsm';

/** The peer's build can parse the `SdpFsmScreen` signal type (FSM screen-
 *  share signaling channel; Phase 3 screen-share port, post-v0.14.8).
 *  A peer without it never receives our screen share — v0.14.8 and older
 *  drove screen share over SimplePeer/`SdpData`, which Phase 3 retires. */
export const CAP_SDP_FSM_SCREEN = 'sdp-fsm-screen';

export type WireCap = typeof CAP_SDP_FSM | typeof CAP_SDP_FSM_SCREEN;

/** The capabilities this build declares in its conversation payload
 *  (`ConversationPayload.caps`). A future wire feature adds a string here —
 *  not a bespoke field-presence probe. */
export const WIRE_CAPS = [
  CAP_SDP_FSM,
  CAP_SDP_FSM_SCREEN,
] as const satisfies readonly WireCap[];

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

export type SignalTypeContract = {
  /** This build sends this type. */
  emits: boolean;
  /** This build has a handler arm for this type. */
  parses: boolean;
  /**
   * Capability the peer must hold before we may emit this type to them.
   * `null` = baseline: every released build (v0.13.2+) parses it, no
   * declaration needed.
   */
  requiresCap: WireCap | null;
};

/**
 * Keyed off the real union, so a new `SignalMsgType` member is a compile
 * error here until its row is added — the tripwire that forces the fixture
 * ceremony below.
 *
 * Adding a `requiresCap` row is NOT enough on its own: `emittableSignalTypes`
 * is the declared model, not the production emission path. A new gated type
 * obliges (1) a production gate keyed on the same capability read
 * (`conversationPayloadCaps` — for `SdpFsm` it is `resolveWebrtcImpl`
 * rule 0), and (2) a paired pin in `compat-corpus.test.ts` holding the model
 * and the gate together, as the existing SdpFsm pins do. Without both, the
 * corpus would certify safety the runtime does not enforce.
 */
export const WIRE_CONTRACT: Record<SignalMsgType, SignalTypeContract> = {
  PingUi: { emits: true, parses: true, requiresCap: null },
  PongUi: { emits: true, parses: true, requiresCap: null },
  InitRequest: { emits: true, parses: true, requiresCap: null },
  InitAccept: { emits: true, parses: true, requiresCap: null },
  // RETIRED (Phase 3): SdpData carried the SimplePeer SDP exchange, and
  // SimplePeer is deleted. The type stays in the union so the handler
  // switch keeps an explicit drop-with-log arm (a ≤ v0.14.8 peer still
  // emits it) instead of the anonymous unknown-type warn.
  SdpData: { emits: false, parses: false, requiresCap: null },
  SdpFsm: { emits: true, parses: true, requiresCap: CAP_SDP_FSM },
  // Production gate: `StreamsStore._ensureOutgoingScreenShare` initiates a
  // screen-share connection only when `conversationPayloadCaps` contains
  // this capability; the answering side only ever emits toward a sharer
  // that already emitted. Pinned with the model in compat-corpus.test.ts.
  SdpFsmScreen: { emits: true, parses: true, requiresCap: CAP_SDP_FSM_SCREEN },
  LeaveUi: { emits: true, parses: true, requiresCap: null },
  DiagnosticRequest: { emits: true, parses: true, requiresCap: null },
  DiagnosticResponse: { emits: true, parses: true, requiresCap: null },
  ModuleState: { emits: true, parses: true, requiresCap: null },
  ModuleData: { emits: true, parses: true, requiresCap: null },
};

/**
 * The signal types this build will emit to a peer holding `peerCaps`.
 *
 * This is the one implementation of the emission rule: baseline types
 * always; capability-gated types only when the peer's capability set
 * (declared, or the no-declaration interpretation — see
 * `conversationPayloadCaps`) contains the required capability. At runtime
 * the `SdpFsm` gate is enforced through `resolveWebrtcImpl` rule 0, whose
 * `peerSupportsFsm` input is fed from the same capability set; the corpus
 * test holds the two together.
 */
export function emittableSignalTypes(
  peerCaps: ReadonlySet<string>,
): SignalMsgType[] {
  return SIGNAL_MSG_TYPES.filter(t => {
    const c = WIRE_CONTRACT[t];
    return c.emits && (c.requiresCap === null || peerCaps.has(c.requiresCap));
  });
}

// ---------------------------------------------------------------------------
// Conversation-payload fields
// ---------------------------------------------------------------------------

/** Fields this build writes into its conversation payload. */
export const CONVERSATION_PAYLOAD_WRITES = [
  'micMuted',
  'webrtcDisabled',
  'disableWebrtcWith',
  'webrtcImpl',
  'peerImpl',
  'caps',
] as const;

/** Fields this build reads from a peer's conversation payload — the writes
 *  plus the legacy encodings `parseConversationPayload` and
 *  `conversationPayloadSupportsFsm` still accept. */
export const CONVERSATION_PAYLOAD_READS = [
  ...CONVERSATION_PAYLOAD_WRITES,
  'muted',
  'signalsOnlyWith',
  'fsmWith',
] as const;

// Completeness, both directions: a field added to ConversationPayload but not
// declared here is a compile error, and so is a declared field the payload
// does not have.
type UndeclaredPayloadField = Exclude<
  keyof ConversationPayload,
  (typeof CONVERSATION_PAYLOAD_WRITES)[number]
>;
const _allPayloadFieldsDeclared: [UndeclaredPayloadField] extends [never]
  ? true
  : never = true;
const _allDeclaredFieldsExist: (typeof CONVERSATION_PAYLOAD_WRITES)[number] extends keyof ConversationPayload
  ? true
  : never = true;
void _allPayloadFieldsDeclared;
void _allDeclaredFieldsExist;

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/** The full declared surface as one stable plain object — what the committed
 *  `fixtures/wire-contract.json` pins. */
export function wireContractSnapshot() {
  return {
    signalTypes: Object.fromEntries(
      SIGNAL_MSG_TYPES.map(t => [t, WIRE_CONTRACT[t]]),
    ),
    caps: [...WIRE_CAPS] as string[],
    conversationPayload: {
      writes: [...CONVERSATION_PAYLOAD_WRITES] as string[],
      reads: [...CONVERSATION_PAYLOAD_READS] as string[],
    },
  };
}
