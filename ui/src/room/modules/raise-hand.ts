import { html } from 'lit';
import { get } from '@holochain-open-dev/stores';
import {
  mdiHandBackRight,
  mdiNumeric1Circle,
  mdiNumeric2Circle,
  mdiNumeric3Circle,
  mdiNumeric4Circle,
  mdiNumeric5Circle,
  mdiNumeric6Circle,
  mdiNumeric7Circle,
  mdiNumeric8Circle,
  mdiNumeric9Circle,
  mdiNumeric9PlusCircle,
} from '@mdi/js';
import { wrapPathInSvg } from '@holochain-open-dev/elements';
import { registerModule } from './registry';
import type { ModuleDefinition, ModuleRenderContext, ModuleStateEnvelope } from './types';

interface RaiseHandPayload {
  note?: string;
}

const numericCircleIcons = [
  mdiNumeric1Circle,
  mdiNumeric2Circle,
  mdiNumeric3Circle,
  mdiNumeric4Circle,
  mdiNumeric5Circle,
  mdiNumeric6Circle,
  mdiNumeric7Circle,
  mdiNumeric8Circle,
  mdiNumeric9Circle,
  mdiNumeric9PlusCircle,
];

function getNumericCircleIcon(position: number): string {
  if (position <= 0 || position > 10) return mdiNumeric9PlusCircle;
  return numericCircleIcons[position - 1];
}

/**
 * Collect all raised hands across peers and self, sorted by updatedAt (oldest first).
 * Returns the 1-based position of the given agent, or 0 if not found / only one hand.
 */
function getHandPosition(agentPubKeyB64: string, context: ModuleRenderContext): number {
  const store = context.streamsStore;
  const allHands: { agent: string; updatedAt: number }[] = [];

  // Self
  const myStates = get(store._myModuleStates);
  const myHand = myStates['raise-hand'];
  if (myHand?.active) {
    allHands.push({ agent: context.myPubKeyB64, updatedAt: myHand.updatedAt });
  }

  // Peers
  const peerStates = get(store._peerModuleStates);
  for (const [peerB64, modules] of Object.entries(peerStates)) {
    const hand = modules['raise-hand'];
    if (hand?.active) {
      allHands.push({ agent: peerB64, updatedAt: hand.updatedAt });
    }
  }

  if (allHands.length <= 1) return 0;

  allHands.sort((a, b) => a.updatedAt - b.updatedAt);
  const idx = allHands.findIndex(h => h.agent === agentPubKeyB64);
  return idx >= 0 ? idx + 1 : 0;
}

const raiseHandModule: ModuleDefinition = {
  id: 'raise-hand',
  type: 'agent',
  label: 'Raise Hand',
  icon: mdiHandBackRight,
  activationControl: 'sender',

  defaultState() {
    return JSON.stringify({ note: '' } satisfies RaiseHandPayload);
  },

  renderOverlay(
    agentPubKeyB64: string,
    state: ModuleStateEnvelope | null,
    context: ModuleRenderContext,
  ) {
    if (!state?.active) return html``;
    const position = getHandPosition(agentPubKeyB64, context);

    return html`
      <div style="position: absolute; top: 5%; left: 50%; transform: translateX(-50%); z-index: 5;">
        <div style="position: relative; display: inline-block;">
          <sl-icon
            style="color: #ffd700; height: 40px; width: 40px; filter: drop-shadow(0 0 4px rgba(0,0,0,0.5));"
            .src=${wrapPathInSvg(mdiHandBackRight)}
          ></sl-icon>
          ${position > 0 ? html`
            <sl-icon
              style="position: absolute; bottom: -4px; right: -8px;
                     color: #4caf50; height: 22px; width: 22px;
                     filter: drop-shadow(0 0 2px rgba(0,0,0,0.5));"
              .src=${wrapPathInSvg(getNumericCircleIcon(position))}
            ></sl-icon>
          ` : html``}
        </div>
      </div>
    `;
  },

  renderReplace(
    _agentPubKeyB64: string,
    state: ModuleStateEnvelope | null,
    _context: ModuleRenderContext,
  ) {
    let note = '';
    try {
      const data: RaiseHandPayload = JSON.parse(state?.payload || '{}');
      note = data.note || '';
    } catch { /* empty */ }

    return html`
      <div style="display: flex; flex-direction: column; align-items: center; justify-content: center;
                  width: 100%; height: 100%; background: #1a1a2e; color: #e0e0e0; padding: 16px; box-sizing: border-box;">
        <sl-icon
          style="color: #ffd700; height: 64px; width: 64px; margin-bottom: 12px;"
          .src=${wrapPathInSvg(mdiHandBackRight)}
        ></sl-icon>
        ${note
          ? html`<div style="font-size: 1.1em; text-align: center; max-width: 90%; word-break: break-word;">${note}</div>`
          : html`<div style="font-size: 0.9em; opacity: 0.6;">Hand raised</div>`}
      </div>
    `;
  },

  renderToolbarButton(
    myState: ModuleStateEnvelope | null,
    toggle: () => void,
  ) {
    const active = !!myState;
    return html`
      <sl-tooltip content="${active ? 'Lower Hand' : 'Raise Hand'}" hoist>
        <div
          class="toggle-btn ${active ? '' : 'btn-off'}"
          tabindex="0"
          @click=${toggle}
          @keypress=${(e: KeyboardEvent) => {
            if (e.key === 'Enter') toggle();
          }}
        >
          <sl-icon
            class="toggle-btn-icon ${active ? '' : 'btn-icon-off'}"
            .src=${wrapPathInSvg(mdiHandBackRight)}
          ></sl-icon>
        </div>
      </sl-tooltip>
    `;
  },
};

registerModule(raiseHandModule);
