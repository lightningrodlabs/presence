import { html } from 'lit';
import {
  mdiVideo,
  mdiMicrophoneOff,
  mdiPhoneRefresh,
  mdiHub,
} from '@mdi/js';
import { wrapPathInSvg } from '@holochain-open-dev/elements';
import { decodeHashFromBase64 } from '@holochain/client';
import { registerModule } from './registry';
import type { ModuleDefinition, ModuleIconDefinition, ModuleRenderContext, ModuleStateEnvelope } from './types';
import type { OpenConnectionInfo } from '../../types';

/** State icon indices for the mute indicator */
enum MuteIcon { Muted = 0 }

/** State icon indices for the relay indicator */
enum RelayIcon { Relayed = 0 }

/** State icon indices for the reconnect button */
enum ReconnectIcon { Available = 0 }

const videoModule: ModuleDefinition = {
  id: 'video',
  type: 'agent',
  label: 'Video',
  icon: mdiVideo,
  activationControl: 'sender',

  getStateIcons(
    agentPubKeyB64: string,
    _state: ModuleStateEnvelope | null,
    context: ModuleRenderContext,
  ): ModuleIconDefinition[] {
    const conn = context.extra?.conn as OpenConnectionInfo | undefined;
    if (!conn) return [];

    const icons: ModuleIconDefinition[] = [];

    // Mute indicator -- visible when peer audio is off
    icons.push({
      states: [
        { icon: mdiMicrophoneOff, tooltip: 'Muted', color: 'red' },
      ],
      currentState: conn.audio ? undefined : MuteIcon.Muted,
    });

    // Relay indicator -- visible when connection uses TURN
    icons.push({
      states: [
        { icon: mdiHub, tooltip: 'Relayed via TURN server', color: '#e7a008' },
      ],
      currentState: conn.relayed ? RelayIcon.Relayed : undefined,
    });

    // Reconnect button -- visible when connected but video is missing or muted
    const needsReconnect = conn.videoMuted || (conn.connected && !conn.video);
    icons.push({
      states: [
        { icon: mdiPhoneRefresh, tooltip: 'Reconnect', color: '#e7a008' },
      ],
      currentState: needsReconnect ? ReconnectIcon.Available : undefined,
      onSelect: needsReconnect
        ? () => context.streamsStore.disconnectFromPeerVideo(agentPubKeyB64)
        : undefined,
    });

    return icons;
  },

  renderReplace(
    agentPubKeyB64: string,
    _state: ModuleStateEnvelope | null,
    context: ModuleRenderContext,
  ) {
    const conn = context.extra?.conn as OpenConnectionInfo | undefined;
    if (!conn) return html``;

    return html`
      <video
        style="${conn.video ? '' : 'display: none;'}"
        id="${conn.connectionId}"
        class="video-el"
      ></video>
      <avatar-with-nickname
        .hideNickname=${true}
        .agentPubKey=${decodeHashFromBase64(agentPubKeyB64)}
        style="width: 35%;${!conn.connected || conn.video ? ' display: none;' : ''}"
      ></avatar-with-nickname>
      <div
        style="color: #b98484; ${conn.connected ? 'display: none' : ''}"
      >
        establishing connection...
      </div>
      <div
        style="color: #b9a884; ${conn.connected && !conn.video && conn.videoMuted ? '' : 'display: none'}"
      >
        connecting media...
      </div>
    `;
  },
};

registerModule(videoModule);
