import { html } from 'lit';
import {
  mdiVideo,
  mdiVideoOff,
  mdiMicrophoneOff,
  mdiRefresh,
  mdiHub,
  mdiPhoneRefresh,
} from '@mdi/js';
import { wrapPathInSvg } from '@holochain-open-dev/elements';
import { get } from '@holochain-open-dev/stores';
import { registerModule } from './registry';
import type { ModuleDefinition, ModuleIconDefinition, ModuleRenderContext, ModuleStateEnvelope } from './types';
import type { OpenConnectionInfo } from '../../types';

/** State icon indices for the mute indicator */
enum MuteIcon { Muted = 0 }

/** State icon indices for the relay indicator */
enum RelayIcon { Relayed = 0 }

/** State icon indices for reset media button */
enum ResetMedia { Available = 0 }

/** State icon indices for full WebRTC reconnect */
enum Reconnect { Available = 0 }


const videoModule: ModuleDefinition = {
  id: 'video',
  type: 'agent',
  label: 'Video/Audio',
  icon: mdiVideo,
  activationControl: 'sender',

  defaultState() {
    return '{}';
  },

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

    // Reset media -- visible when video track is degraded (muted or missing)
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

    // Full WebRTC reconnect -- always available when connected
    icons.push({
      states: [
        { icon: mdiPhoneRefresh, tooltip: 'Reconnect', color: '#ffe100' },
      ],
      currentState: Reconnect.Available,
      onSelect: () => context.streamsStore.disconnectFromPeerVideo(agentPubKeyB64),
    });

    return icons;
  },

  // Video does NOT provide renderReplace. The pane's inline template handles
  // video rendering directly because:
  // - Self pane needs local-only concerns (this._camera, muted, mirrored)
  // - Peer pane's default content IS the video view (inline, not overlay)
  // - Wrapping in .module-replace-content (absolute positioning) breaks layout
  // The video module's role is: state propagation + icon strip contribution.

  renderToolbarButton(myState, _toggle, streamsStore) {
    const active = !!myState;
    const handler = async () => {
      if (active) {
        // Tear down all open WebRTC video connections immediately.
        const openConns = get(streamsStore._openConnections);
        for (const pubKeyB64 of Object.keys(openConns)) {
          streamsStore.disconnectFromPeerVideo(pubKeyB64);
        }
        // Drop local mic/camera tracks too — they only exist to feed WebRTC.
        await streamsStore.audioOff();
        await streamsStore.videoOff();
        await streamsStore.deactivateModule('video');
        window.localStorage.setItem('disableAutoVideo', 'true');
      } else {
        await streamsStore.activateModule('video');
        window.localStorage.removeItem('disableAutoVideo');
      }
    };
    return html`
      <sl-tooltip content="${active ? 'Disable WebRTC' : 'Enable WebRTC'}" hoist>
        <div
          class="toggle-btn ${active ? '' : 'btn-off'}"
          tabindex="0"
          @click=${handler}
          @keypress=${(e: KeyboardEvent) => {
            if (e.key === 'Enter') handler();
          }}
        >
          <sl-icon
            class="toggle-btn-icon ${active ? '' : 'btn-icon-off'}"
            .src=${active ? wrapPathInSvg(mdiVideo) : wrapPathInSvg(mdiVideoOff)}
          ></sl-icon>
        </div>
      </sl-tooltip>
    `;
  },
};

registerModule(videoModule);
