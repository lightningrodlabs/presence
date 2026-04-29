import { LitElement, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { mdiEmoticonHappyOutline } from '@mdi/js';
import 'emoji-picker-element';
import { registerModule } from './registry';
import type { ModuleDefinition, ModuleRenderContext, ModuleStateEnvelope } from './types';

interface Reaction {
  emoji: string;
  x: number; // percentage 0-100
  y: number; // percentage 0-100
}

interface ReactionsPayload {
  reactions: Reaction[];
}

function parseReactions(state: ModuleStateEnvelope | null): Reaction[] {
  if (!state?.payload) return [];
  try {
    const data: ReactionsPayload = JSON.parse(state.payload);
    return data.reactions || [];
  } catch {
    return [];
  }
}

@customElement('module-reactions-overlay')
export class ModuleReactionsOverlay extends LitElement {
  @property({ attribute: false }) agentPubKeyB64 = '';
  @property({ attribute: false }) moduleState: ModuleStateEnvelope | null = null;
  @property({ attribute: false }) context!: ModuleRenderContext;

  @state() private _pickerOpen = false;
  @state() private _clickX = 50;
  @state() private _clickY = 50;

  private _pickerEl: HTMLElement | null = null;

  private _onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this._pickerOpen) {
      this._closePicker();
    }
  };

  private _onDocumentClick = (e: MouseEvent) => {
    if (!this._pickerOpen) return;
    const path = e.composedPath();
    if (this._pickerEl && !path.includes(this._pickerEl) &&
        !path.some(el => el instanceof HTMLElement && el.tagName === 'EMOJI-PICKER')) {
      this._closePicker();
    }
  };

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener('click', this._onDocumentClick, true);
    document.addEventListener('keydown', this._onKeyDown);
  }

  disconnectedCallback() {
    this._closePicker();
    document.removeEventListener('click', this._onDocumentClick, true);
    document.removeEventListener('keydown', this._onKeyDown);
    super.disconnectedCallback();
  }

  static styles = css`
    :host {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 4;
    }
    .click-area {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: auto;
      cursor: crosshair;
    }
    .reaction {
      position: absolute;
      font-size: 28px;
      transform: translate(-50%, -50%);
      pointer-events: auto;
      cursor: pointer;
      user-select: none;
      filter: drop-shadow(0 1px 2px rgba(0,0,0,0.5));
      transition: transform 0.1s;
    }
    .reaction:hover {
      transform: translate(-50%, -50%) scale(1.3);
    }
  `;

  private _onPaneClick(e: MouseEvent) {
    if ((e.target as HTMLElement).closest('.reaction')) return;
    const rect = this.getBoundingClientRect();
    this._clickX = ((e.clientX - rect.left) / rect.width) * 100;
    this._clickY = ((e.clientY - rect.top) / rect.height) * 100;
    this._openPicker(e.clientX, e.clientY);
  }

  private _openPicker(screenX: number, screenY: number) {
    this._closePicker();

    const container = document.createElement('div');
    container.style.cssText = `position: fixed; left: ${screenX}px; top: ${screenY}px; z-index: 99999;`;
    const picker = document.createElement('emoji-picker');
    picker.addEventListener('emoji-click', (e: Event) => this._onEmojiClick(e as CustomEvent));
    container.appendChild(picker);
    document.body.appendChild(container);
    this._pickerEl = container;
    this._pickerOpen = true;
  }

  private _closePicker() {
    if (this._pickerEl) {
      this._pickerEl.remove();
      this._pickerEl = null;
    }
    this._pickerOpen = false;
  }

  private _onEmojiClick(e: CustomEvent) {
    const emoji = e.detail.unicode;
    if (!emoji) return;
    this._closePicker();
    const reactions = parseReactions(this.moduleState);
    reactions.push({ emoji, x: this._clickX, y: this._clickY });
    this._updateReactions(reactions);
  }

  private _removeReaction(index: number) {
    if (!this.context?.isMe) return;
    const reactions = parseReactions(this.moduleState);
    reactions.splice(index, 1);
    this._updateReactions(reactions);
  }

  private _updateReactions(reactions: Reaction[]) {
    const payload = JSON.stringify({ reactions } satisfies ReactionsPayload);
    this.context.streamsStore.updateModuleState('reactions', payload);
  }

  render() {
    const reactions = parseReactions(this.moduleState);
    const isMe = this.context?.isMe;

    return html`
      ${isMe ? html`
        <div class="click-area" @click=${(e: MouseEvent) => this._onPaneClick(e)}></div>
      ` : html``}

      ${reactions.map((r, i) => html`
        <span
          class="reaction"
          style="left: ${r.x}%; top: ${r.y}%;"
          title=${isMe ? 'Click to remove' : ''}
          @click=${isMe ? () => this._removeReaction(i) : undefined}
        >${r.emoji}</span>
      `)}
    `;
  }
}

const reactionsModule: ModuleDefinition = {
  id: 'reactions',
  type: 'agent',
  label: 'Reactions',
  icon: mdiEmoticonHappyOutline,
  activationControl: 'sender',

  overlayElement: 'module-reactions-overlay',

  defaultState() {
    return JSON.stringify({ reactions: [] } satisfies ReactionsPayload);
  },
};

registerModule(reactionsModule);
