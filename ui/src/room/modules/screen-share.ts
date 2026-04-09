import { html } from 'lit';
import { get } from '@holochain-open-dev/stores';
import { decodeHashFromBase64 } from '@holochain/client';
import { mdiMonitorScreenshot } from '@mdi/js';
import { wrapPathInSvg } from '@holochain-open-dev/elements';
import { registerModule } from './registry';
import type { ModuleDefinition, ModuleRenderContext, ModuleStateEnvelope } from './types';

const screenShareModule: ModuleDefinition = {
  id: 'screen-share',
  type: 'share',
  label: 'Screen Share',
  icon: mdiMonitorScreenshot,
  activationControl: 'sender',
  shareWrapperClass: 'video-container screen-share',

  defaultState() {
    return '{}';
  },

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
          id="my-own-screen"
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
    const videoElId = `video-screen-${agentPubKeyB64}`;

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
        // screenShareOn() fires the my-screen-share-on event
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
