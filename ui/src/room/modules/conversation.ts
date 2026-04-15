import {
  mdiMicrophone,
  mdiMicrophoneOff,
  mdiHub,
  mdiRefresh,
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
}

export const DEFAULT_CONVERSATION_PAYLOAD: ConversationPayload = {
  micMuted: true,
  webrtcDisabled: false,
  disableWebrtcWith: [],
};

export function parseConversationPayload(
  envelope: ModuleStateEnvelope | null,
): ConversationPayload | null {
  if (!envelope || !envelope.active) return null;
  try {
    const raw = JSON.parse(envelope.payload);
    return {
      micMuted: raw.micMuted !== undefined ? !!raw.micMuted : !!raw.muted,
      webrtcDisabled: !!raw.webrtcDisabled,
      disableWebrtcWith: Array.isArray(raw.disableWebrtcWith)
        ? raw.disableWebrtcWith.filter((x: unknown) => typeof x === 'string')
        : Array.isArray(raw.signalsOnlyWith)
          ? raw.signalsOnlyWith.filter((x: unknown) => typeof x === 'string')
          : [],
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
enum ResetMedia { Available = 0 }
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
          { icon: mdiHub, tooltip: 'Relayed via TURN server', color: '#e7a008' },
        ],
        currentState: conn.relayed ? RelayIcon.Relayed : undefined,
      });

      // Reset media — visible when video track is degraded
      const needsReset = conn.videoMuted || (conn.connected && !conn.video);
      icons.push({
        states: [
          { icon: mdiRefresh, tooltip: 'Reset media', color: '#e7a008' },
        ],
        currentState: needsReset ? ResetMedia.Available : undefined,
        onSelect: needsReset
          ? () => context.streamsStore.refreshTracksForPeer(agentPubKeyB64)
          : undefined,
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

    if (wasDisabled === isDisabled) return;

    if (isDisabled) {
      streamsStore.disconnectFromPeerVideo(agentPubKeyB64);
    }
  },

  // No toolbar button. The conversation module auto-activates on room
  // join. Mic and camera are controlled by the existing toolbar buttons
  // in room-view.ts. Per-peer WebRTC disable lives in the connection
  // details panel (_renderWebrtcToggle).
};

registerModule(conversationModule);
