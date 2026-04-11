import { html } from 'lit';
import { get } from '@holochain-open-dev/stores';
import { decodeHashFromBase64 } from '@holochain/client';
import { mdiMonitorScreenshot, mdiPhoneRefresh } from '@mdi/js';
import { wrapPathInSvg } from '@holochain-open-dev/elements';
import { registerModule } from './registry';
import type { ModuleDefinition, ModuleRenderContext, ModuleStateEnvelope } from './types';

/**
 * DOM ids for screen-share <video> elements. These are referenced both by
 * renderShare() (which creates the elements) and by room-view's
 * peer-screen-share-stream / my-screen-share-on event handlers (which set
 * srcObject after the stream arrives). Keep them in one place so the two
 * sides can't drift.
 */
export const MY_OWN_SCREEN_VIDEO_ID = 'my-own-screen';
export const peerScreenVideoId = (pubKeyB64: string) => `video-screen-${pubKeyB64}`;

const screenShareModule: ModuleDefinition = {
  id: 'screen-share',
  type: 'share',
  label: 'Screen Share',
  icon: mdiMonitorScreenshot,
  activationControl: 'sender',
  shareWrapperClass: 'video-container screen-share',

  renderShare(
    agentPubKeyB64: string,
    _state: ModuleStateEnvelope | null,
    context: ModuleRenderContext,
  ) {
    const store = context.streamsStore;
    const isMe = context.isMe;

    // Self side: render own screen stream
    if (isMe) {
      return html`
        <video
          muted
          id="${MY_OWN_SCREEN_VIDEO_ID}"
          class="video-el"
        ></video>
        <div
          style="display: flex; flex-direction: row; align-items: center; position: absolute; bottom: 10px; right: 10px; background: none;"
        >
          <avatar-with-nickname
            .size=${36}
            .agentPubKey=${decodeHashFromBase64(agentPubKeyB64)}
            style="height: 36px;"
          ></avatar-with-nickname>
        </div>
      `;
    }

    // Peer side: look up incoming connection by pubkey
    const incomingConnections = get(store._screenShareConnectionsIncoming);
    const incomingConn = incomingConnections[agentPubKeyB64];
    const videoElId = peerScreenVideoId(agentPubKeyB64);

    return html`
      <video
        style="${incomingConn?.connected ? '' : 'display: none;'}"
        id="${videoElId}"
        class="video-el"
      ></video>
      <div style="color: #b98484; ${incomingConn?.connected ? 'display: none' : ''}">
        establishing connection...
      </div>
      <div
        style="display: flex; flex-direction: row; align-items: center; position: absolute; bottom: 10px; right: 10px; background: none;"
      >
        <avatar-with-nickname
          .size=${36}
          .agentPubKey=${decodeHashFromBase64(agentPubKeyB64)}
          style="height: 36px;"
        ></avatar-with-nickname>
        <sl-tooltip content="reconnect" class="tooltip-filled">
          <sl-icon-button
            class="phone-refresh"
            style="margin-left: 4px; margin-bottom: -5px;"
            .src=${wrapPathInSvg(mdiPhoneRefresh)}
            @click=${() => store.disconnectFromPeerScreen(agentPubKeyB64)}
          ></sl-icon-button>
        </sl-tooltip>
      </div>
    `;
  },

  renderToolbarButton(myState, _toggle, streamsStore) {
    const active = !!myState;
    const handler = async () => {
      if (active) {
        await streamsStore.screenShareOff();
        await streamsStore.deactivateModule('screen-share');
      } else {
        // Activate module first so the video element renders before
        // screenShareOn() fires the my-screen-share-on event. Between
        // activation and the picker resolving, peers see the module as
        // active with no stream — handled by the renderShare peer branch's
        // "establishing connection..." placeholder.
        await streamsStore.activateModule('screen-share');
        await streamsStore.screenShareOn();
        // If acquisition was canceled, no stream — roll back the activation
        if (!streamsStore.screenShareStream) {
          await streamsStore.deactivateModule('screen-share');
        }
      }
    };
    return html`
      <sl-tooltip content="${active ? 'Stop Screen Share' : 'Share Screen'}" hoist>
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
            .src=${wrapPathInSvg(mdiMonitorScreenshot)}
          ></sl-icon>
        </div>
      </sl-tooltip>
    `;
  },
};

registerModule(screenShareModule);
