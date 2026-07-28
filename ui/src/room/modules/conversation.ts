import {
  mdiMicrophone,
  mdiMicrophoneOff,
  mdiTransitConnectionVariant,
  mdiPhoneRefresh,
  mdiVideo,
} from '@mdi/js';
import { wrapPathInSvg } from '@holochain-open-dev/elements';
import type { AgentPubKeyB64 } from '@holochain/client';
import { registerModule } from './registry';
import type {
  ModuleDefinition,
  ModuleIconDefinition,
  ModuleRenderContext,
  ModuleStateEnvelope,
} from './types';
import type { OpenConnectionInfo } from '../../types';
import type { StreamsStore } from '../../streams-store';
import { CAP_SDP_FSM, WIRE_CAPS } from '../../transport/wire-contract';

/**
 * Conversation module — unified owner of "we're talking" presence.
 *
 * Encapsulates audio (mic), video (camera), and the transport plumbing
 * beneath both (WebRTC + signals). The user activates "conversation" by
 * joining the room (auto-activated on room join, like the old `video`
 * module). Mic and camera are sub-controls: turning on the mic flips
 * `micMuted` in the payload; turning on the camera calls the existing
 * `videoOn`/`videoOff` path.
 *
 * Transport is automatic: audio flows via WebRTC when a peer connection
 * exists, via Holochain signals when it doesn't. The only manual
 * override is `disableWebrtcWith` — a per-peer flag that suppresses
 * WebRTC initiation for that link, making signals the permanent carrier.
 *
 * Replaces the separate `video`, `mic`, and (partially) `voice` modules.
 */

// =========================================================================
// Payload
// =========================================================================

/** WebRTC implementation choice broadcast in the conversation payload.
 *  Symmetric union over the global `webrtcImpl` field: the effective
 *  default for a link is `'fsm'` if either side picks it, else
 *  `'simplepeer'`. Per-link overrides via `peerImpl` (below) take
 *  precedence over the global default. Default is `'fsm'` — the more
 *  capable carrier on marginal NATs; auto-flip falls back to
 *  `'simplepeer'` on failure.
 *
 *  All of that is *preference*, and preference is subordinate to
 *  capability: `resolveWebrtcImpl` pins the link to `'simplepeer'` unless
 *  `conversationPayloadSupportsFsm` says the peer's build can parse
 *  `SdpFsm` at all. A missing `webrtcImpl` field parses to `'simplepeer'`,
 *  but that alone never protected pre-FSM peers — the union resolved the
 *  link to `'fsm'` on our own global regardless, and we sent them a signal
 *  type their build has no handler for. */
export type WebrtcImpl = 'simplepeer' | 'fsm';

export interface ConversationPayload {
  /** True when user's mic is muted (track.enabled = false). */
  micMuted: boolean;
  /**
   * Global WebRTC kill switch. When true, this agent will not initiate
   * or accept WebRTC with anyone. Broadcast so remote peers can skip
   * InitRequest attempts entirely rather than timing out.
   */
  webrtcDisabled: boolean;
  /**
   * Peers for whom WebRTC is disabled. Neither side will initiate or
   * accept WebRTC for this link. Audio flows via signals instead.
   * Symmetric union: if either side lists the other, WebRTC is off.
   */
  disableWebrtcWith: AgentPubKeyB64[];
  /** Preferred WebRTC implementation for this agent's links. */
  webrtcImpl: WebrtcImpl;
  /** Per-peer impl override. Each entry pins the impl for that one link
   *  regardless of global `webrtcImpl`. Symmetric union: if both sides
   *  set an override for the same link and the values disagree,
   *  **`'fsm'` wins** (`auto-flip-policy.ts:resolveWebrtcImpl`, asserted by
   *  its own tests). Note the consequence: a peer cannot unilaterally pin a
   *  link back to simplepeer, so the automated toggle below cannot use an
   *  override to escape a failing FSM link on its own. An override cannot
   *  reach `'fsm'` for a peer whose build lacks the `SdpFsm` handler
   *  either — capability is checked first.
   *
   *  Used both by the developer per-peer toggle and by the Phase 3
   *  automated failure toggle, which flips a peer's override when an
   *  `AudibilityOutage` fires on the current impl. */
  peerImpl: Record<AgentPubKeyB64, WebrtcImpl>;
  /**
   * Wire capabilities this agent's *build* declares (Phase 1.5 item 3).
   * The vocabulary and the emission rule live in
   * `transport/wire-contract.ts`; capability *reads* go through
   * `conversationPayloadCaps` below, never through this parsed field —
   * see the parse note on `parseConversationPayload`.
   */
  caps: string[];
}

export const DEFAULT_CONVERSATION_PAYLOAD: ConversationPayload = {
  micMuted: true,
  webrtcDisabled: false,
  disableWebrtcWith: [],
  webrtcImpl: 'fsm',
  peerImpl: {},
  caps: [...WIRE_CAPS],
};

/**
 * The wire capabilities a peer's *build* holds, read from their
 * conversation payload (Phase 1.5 item 3).
 *
 * One rule, from `transport/wire-contract.ts`: never emit a signal type the
 * peer has not declared a capability for; **no declaration ⇒ the baseline
 * set**. Concretely:
 *
 *   - A payload carrying a `caps` array is a declaration and is taken
 *     verbatim — including an *empty* array, which declares "baseline
 *     only". Declared capability outranks any inference.
 *   - A payload without `caps` (every release through v0.14.8) falls back
 *     to the legacy field-presence probe `conversationPayloadSupportsFsm`
 *     below, which is demoted to exactly this role: the interpretation of
 *     "no declaration".
 *
 * Deliberately independent of `envelope.active`: whether a peer currently
 * has the conversation module switched on says nothing about what their
 * build understands. `parseConversationPayload` returns `null` for an
 * inactive module, which would otherwise read as "not capable".
 *
 * Absent or unparseable payload means *baseline only*. The conservative
 * direction is the safe one — the baseline types interoperate with every
 * released version.
 *
 * Constrains `auto-flip-policy.ts:resolveWebrtcImpl` rule 0 (via
 * `streams-store.ts:webrtcImplFor`) and
 * `wire-contract.ts:emittableSignalTypes`.
 */
export function conversationPayloadCaps(
  envelope: ModuleStateEnvelope | null,
): ReadonlySet<string> {
  if (!envelope) return new Set();
  let raw: any;
  try {
    raw = JSON.parse(envelope.payload);
  } catch {
    return new Set();
  }
  if (raw && Array.isArray(raw.caps)) {
    return new Set(raw.caps.filter((c: unknown) => typeof c === 'string'));
  }
  return conversationPayloadSupportsFsm(envelope)
    ? new Set([CAP_SDP_FSM])
    : new Set();
}

/**
 * Legacy capability probe — **demoted** (Phase 1.5 item 3) to the
 * interpretation of "no declaration" inside `conversationPayloadCaps`;
 * production code reads capability from that function, not this one.
 *
 * The inference it encodes stays sound for the payloads it was built for:
 * `webrtcImpl`, `fsmWith` and `peerImpl` all entered the conversation
 * payload in the same commit that put `SdpFsm` on the wire (`2d20e93`,
 * 2026-05-01); every release through v0.14.7 contains none of them and no
 * `SdpFsm` handler, so the presence of any one of these fields is an exact
 * marker for a build that can parse the FSM signaling channel. Releases
 * after v0.14.8 declare `caps` and never reach this probe.
 */
export function conversationPayloadSupportsFsm(
  envelope: ModuleStateEnvelope | null,
): boolean {
  if (!envelope) return false;
  try {
    const raw = JSON.parse(envelope.payload);
    return (
      raw?.webrtcImpl !== undefined ||
      raw?.fsmWith !== undefined ||
      raw?.peerImpl !== undefined
    );
  } catch {
    return false;
  }
}

/**
 * Preference parsing only. Capability reads go through
 * `conversationPayloadCaps` above — never through the parsed `caps` field.
 * The distinction matters for the `caps` default below: every payload
 * *write* site round-trips `parseConversationPayload(existing) ??
 * DEFAULT_CONVERSATION_PAYLOAD` before re-stringifying, so a caps-less
 * legacy payload must re-parse to *this build's* caps or the write would
 * emit `caps: []` — an explicit declaration of baseline-only, silently
 * downgrading our own links. That default would be exactly wrong for a
 * peer's payload, which is why peer capability never reads this field.
 */
export function parseConversationPayload(
  envelope: ModuleStateEnvelope | null,
): ConversationPayload | null {
  if (!envelope || !envelope.active) return null;
  try {
    const raw = JSON.parse(envelope.payload);
    const webrtcImpl: WebrtcImpl = raw.webrtcImpl === 'fsm' ? 'fsm' : 'simplepeer';
    const peerImpl: Record<AgentPubKeyB64, WebrtcImpl> = {};
    if (raw.peerImpl && typeof raw.peerImpl === 'object') {
      for (const [k, v] of Object.entries(raw.peerImpl)) {
        if (typeof k === 'string' && (v === 'simplepeer' || v === 'fsm')) {
          peerImpl[k] = v;
        }
      }
    }
    // Backwards compat: pre-Phase-3 payloads encoded per-peer overrides
    // as a `fsmWith` array. Promote those into peerImpl.
    if (Array.isArray(raw.fsmWith)) {
      for (const x of raw.fsmWith) {
        if (typeof x === 'string' && !peerImpl[x]) peerImpl[x] = 'fsm';
      }
    }
    return {
      micMuted: raw.micMuted !== undefined ? !!raw.micMuted : !!raw.muted,
      webrtcDisabled: !!raw.webrtcDisabled,
      disableWebrtcWith: Array.isArray(raw.disableWebrtcWith)
        ? raw.disableWebrtcWith.filter((x: unknown) => typeof x === 'string')
        : Array.isArray(raw.signalsOnlyWith)
          ? raw.signalsOnlyWith.filter((x: unknown) => typeof x === 'string')
          : [],
      webrtcImpl,
      peerImpl,
      caps: Array.isArray(raw.caps)
        ? raw.caps.filter((c: unknown) => typeof c === 'string')
        : [...WIRE_CAPS],
    };
  } catch {
    return null;
  }
}

// =========================================================================
// Icon indices
// =========================================================================

enum MicIcon { On = 0, Muted = 1 }
enum RelayIcon { Relayed = 0 }
enum Reconnect { Available = 0 }

// =========================================================================
// Module definition
// =========================================================================

const conversationModule: ModuleDefinition = {
  id: 'conversation',
  type: 'agent',
  label: 'Conversation',
  icon: mdiVideo,
  activationControl: 'sender',

  defaultState() {
    return JSON.stringify(DEFAULT_CONVERSATION_PAYLOAD);
  },

  getStateIcons(
    agentPubKeyB64: string,
    state: ModuleStateEnvelope | null,
    context: ModuleRenderContext,
  ): ModuleIconDefinition[] {
    // Self pane indicators are on the toolbar; icon strip is for peers.
    if (context.isMe) return [];

    const icons: ModuleIconDefinition[] = [];
    const payload = parseConversationPayload(state);

    // Mic on/muted indicator (from mic module)
    if (payload) {
      icons.push({
        states: [
          { icon: mdiMicrophone, tooltip: 'Mic on', color: '#7adc7a' },
          { icon: mdiMicrophoneOff, tooltip: 'Muted', color: 'red' },
        ],
        currentState: payload.micMuted ? MicIcon.Muted : MicIcon.On,
      });
    }

    // WebRTC transport indicators (from video module)
    const conn = context.extra?.conn as OpenConnectionInfo | undefined;
    if (conn) {
      // Relay indicator — visible when connection uses TURN
      icons.push({
        states: [
          { icon: mdiTransitConnectionVariant, tooltip: 'Relayed via TURN server', color: '#e7a008' },
        ],
        currentState: conn.relayed ? RelayIcon.Relayed : undefined,
      });

      // Full WebRTC reconnect — always available when connected
      icons.push({
        states: [
          { icon: mdiPhoneRefresh, tooltip: 'Reconnect', color: '#ffe100' },
        ],
        currentState: Reconnect.Available,
        onSelect: () => context.streamsStore.disconnectFromPeerVideo(agentPubKeyB64),
      });
    }

    return icons;
  },

  /**
   * React to payload changes from a peer's conversation module.
   * Tear down the WebRTC connection when the peer has disabled WebRTC
   * for this link — either globally (`webrtcDisabled`) or for us
   * specifically (`disableWebrtcWith` includes our pubkey). Without
   * this, recovery would depend on simple-peer's `close` event
   * propagating, which can lag or be missed, leaving `_openConnections`
   * populated and `_signalsTargets` excluding the peer — so audio would
   * not route over signals to them.
   */
  onModulePayloadChange(
    agentPubKeyB64: string,
    prev: ModuleStateEnvelope,
    next: ModuleStateEnvelope,
    streamsStore: StreamsStore,
  ) {
    const prevPayload = parseConversationPayload(prev);
    const nextPayload = parseConversationPayload(next);
    if (!prevPayload || !nextPayload) return;

    const myPubKey = streamsStore.myPubKeyB64;
    const wasDisabled =
      prevPayload.webrtcDisabled ||
      prevPayload.disableWebrtcWith.includes(myPubKey);
    const isDisabled =
      nextPayload.webrtcDisabled ||
      nextPayload.disableWebrtcWith.includes(myPubKey);

    if (wasDisabled !== isDisabled && isDisabled) {
      streamsStore.disconnectFromPeerVideo(agentPubKeyB64);
      return;
    }

    // Detect a webrtcImpl flip for this link. When the effective
    // implementation changes (because the peer flipped its global
    // webrtcImpl, or set/cleared a peerImpl override against us, or the
    // Phase 3 auto-toggle ran on their side), tear down any existing
    // connection so the next pong-driven retry establishes via the
    // newly-selected impl.
    const myPeerImplMap = streamsStore.myPeerImpl();
    const prevImpl = streamsStore.webrtcImplForGiven(
      streamsStore.myWebrtcImpl(),
      myPeerImplMap[agentPubKeyB64],
      prevPayload.webrtcImpl,
      prevPayload.peerImpl?.[myPubKey],
      conversationPayloadCaps(prev).has(CAP_SDP_FSM),
    );
    const nextImpl = streamsStore.webrtcImplForGiven(
      streamsStore.myWebrtcImpl(),
      myPeerImplMap[agentPubKeyB64],
      nextPayload.webrtcImpl,
      nextPayload.peerImpl?.[myPubKey],
      conversationPayloadCaps(next).has(CAP_SDP_FSM),
    );
    if (prevImpl !== nextImpl) {
      streamsStore.disconnectFromPeerVideo(agentPubKeyB64);
    }
  },

  // No toolbar button. The conversation module auto-activates on room
  // join. Mic and camera are controlled by the existing toolbar buttons
  // in room-view.ts. Per-peer WebRTC disable lives in the connection
  // details panel (_renderWebrtcToggle).
};

registerModule(conversationModule);
