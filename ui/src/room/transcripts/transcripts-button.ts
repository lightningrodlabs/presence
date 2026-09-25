import { LitElement, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { consume } from '@lit/context';
import { localized, msg } from '@lit/localize';
import { mdiTextBoxMultipleOutline } from '@mdi/js';
import { wrapPathInSvg } from '@holochain-open-dev/elements';
import { ProfilesStore, profilesStoreContext } from '@holochain-open-dev/profiles';
import type { AgentPubKeyB64 } from '@holochain/client';
import '@shoelace-style/shoelace/dist/components/icon/icon.js';
import '@shoelace-style/shoelace/dist/components/tooltip/tooltip.js';

import { getTranscriptStore } from './store';
import { SpeakerLabels, profileNicknameFetcher } from './speaker-labels';
import './transcripts-dialog';

/**
 * Round icon button that opens one room's transcripts dialog. Styled as
 * the twin of `wal-to-pocket-btn` (same `--bg-color`/`--bg-color-hover`
 * properties) so the two sit together on a room card.
 */
@localized()
@customElement('transcripts-button')
export class TranscriptsButton extends LitElement {
  /** See `roomTranscriptKey`. */
  @property({ type: String }) roomKey = '';
  @property({ type: String }) roomName = '';

  @consume({ context: profilesStoreContext, subscribe: true })
  @state()
  private _profilesStore: ProfilesStore | undefined;

  @state() private _open = false;

  private _labels: SpeakerLabels | null = null;
  private _labelsFor: ProfilesStore | undefined;

  /** Built per profiles store, so a replaced context never serves stale lookups. */
  private _speakerLabels(): SpeakerLabels | null {
    const store = this._profilesStore;
    if (!store) return null;
    if (this._labelsFor !== store) {
      this._labels = new SpeakerLabels(profileNicknameFetcher(store));
      this._labelsFor = store;
    }
    return this._labels;
  }

  private _renderDialog() {
    if (!this._open) return html``;
    return html`
      <transcripts-dialog
        .store=${getTranscriptStore()}
        .roomKey=${this.roomKey}
        .labelFor=${(pk: AgentPubKeyB64) => this._speakerLabels()?.get(pk)}
        .refreshLabels=${async (pks: AgentPubKeyB64[]) => {
          await this._speakerLabels()?.refresh(pks, { retryFailed: true });
        }}
        @transcripts-close=${() => {
          this._open = false;
          // The store opens lazily and may have failed while the dialog was
          // open; re-render so the tooltip re-reads `degraded`.
          this.requestUpdate();
        }}
      ></transcripts-dialog>
    `;
  }

  render() {
    const tooltip = getTranscriptStore().degraded
      ? msg('Transcripts (not stored in this browser)')
      : msg('Transcripts');
    return html`
      <sl-tooltip content=${tooltip}>
        <div
          class="btn"
          tabindex="0"
          aria-label=${msg('Transcripts')}
          @click=${() => (this._open = true)}
          @keypress=${(e: KeyboardEvent) => {
            if (e.key === 'Enter') this._open = true;
          }}
        >
          <sl-icon .src=${wrapPathInSvg(mdiTextBoxMultipleOutline)}></sl-icon>
        </div>
      </sl-tooltip>
      ${this._renderDialog()}
    `;
  }

  static styles = css`
    .btn {
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--bg-color, white);
      padding: 9px;
      border-radius: 50%;
      box-shadow: 1px 1px 3px #6b6b6b;
      cursor: pointer;
    }
    .btn:hover {
      background: var(--bg-color-hover, #e4e4e4);
    }
  `;
}
