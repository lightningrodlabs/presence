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
 *  precedence over the global default. This avoids a signaling-channel
 *  mismatch (Sdp vs SdpFsm). Default is `'fsm'` — the more capable carrier
 *  on marginal NATs; auto-flip falls back to `'simplepeer'` on failure.
 *  The parser still treats a *missing* field as `'simplepeer'` so peers
 *  running pre-FSM code (which omit the field entirely) are still
 *  recognised as simplepeer clients. */
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
   *  **`'fsm'` wins** (`auto-flip-policy.ts:149-152`, asserted by its own
   *  tests). Note the consequence: a peer cannot unilaterally pin a link
   *  back to simplepeer, so the automated toggle below cannot use an
   *  override to escape a failing FSM link on its own.
   *
   *  Used both by the developer per-peer toggle and by the Phase 3
   *  automated failure toggle, which flips a peer's override when an
   *  `AudibilityOutage` fires on the current impl. */
  peerImpl: Record<AgentPubKeyB64, WebrtcImpl>;
}

export const DEFAULT_CONVERSATION_PAYLOAD: ConversationPayload = {
  micMuted: true,
  webrtcDisabled: false,
  disableWebrtcWith: [],
  webrtcImpl: 'fsm',
  peerImpl: {},
};

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
    );
    const nextImpl = streamsStore.webrtcImplForGiven(
      streamsStore.myWebrtcImpl(),
      myPeerImplMap[agentPubKeyB64],
      nextPayload.webrtcImpl,
      nextPayload.peerImpl?.[myPubKey],
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
