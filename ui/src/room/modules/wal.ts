import { html } from 'lit';
import { decodeHashFromBase64 } from '@holochain/client';
import { mdiCubeOutline } from '@mdi/js';
import { registerModule } from './registry';
import type { ModuleDefinition, ModuleRenderContext, ModuleStateEnvelope } from './types';
import type { SharedWalPayload } from '../../types';

function parseWalPayload(state: ModuleStateEnvelope | null): SharedWalPayload | null {
  if (!state?.payload) return null;
  try {
    return JSON.parse(state.payload) as SharedWalPayload;
  } catch {
    return null;
  }
}

const walModule: ModuleDefinition = {
  id: 'wal',
  type: 'share',
  label: 'Shared Asset',
  icon: mdiCubeOutline,
  activationControl: 'sender',
  shareWrapperClass: 'shared-wal-container',

  renderShare(
    agentPubKeyB64: string,
    state: ModuleStateEnvelope | null,
    context: ModuleRenderContext,
  ) {
    const wal = parseWalPayload(state);
    if (!wal) return html``;

    return html`
      <shared-wal-embed
        .src=${wal.weaveUrl}
        .closable=${context.isMe}
        @close=${() => context.streamsStore.deactivateModule('wal')}
        style="flex: 1;"
      ></shared-wal-embed>
      <div class="shared-wal-footer">
        <avatar-with-nickname
          .size=${36}
          .agentPubKey=${decodeHashFromBase64(agentPubKeyB64)}
          style="height: 36px;"
        ></avatar-with-nickname>
      </div>
    `;
  },
};

registerModule(walModule);
