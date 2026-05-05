import { LitElement, css, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { localized, msg } from '@lit/localize';
import type { AgentPubKeyB64 } from '@holochain/client';
import { decodeHashFromBase64 } from '@holochain/client';

import './avatar-with-nickname';

/**
 * Opt-in dialog shown when a peer sets `requested: true` on their
 * transcription module state and we haven't already accepted (and
 * aren't set to auto-accept).
 *
 * Keeps the v1 UX minimal: one requester, yes/no, and a
 * remember-for-next-time checkbox surfaced only on first prompt.
 *
 * Events:
 *   - `transcription-accept` — detail: { requester: AgentPubKeyB64, remember: boolean }
 *   - `transcription-decline` — detail: { requester: AgentPubKeyB64, remember: boolean }
 *
 * The parent (room-view) drives visibility by leaving the element
 * unmounted when there is no pending request.
 */
@localized()
@customElement('transcription-request-dialog')
export class TranscriptionRequestDialog extends LitElement {
  /** AgentPubKeyB64 of the peer whose `requested` flag triggered this prompt. */
  @property({ type: String })
  requester!: AgentPubKeyB64;

  /**
   * When true, render the "Always accept transcription requests"
   * checkbox. Room-view sets this on first-ever prompt (auto-accept
   * setting hasn't been toggled yet).
   */
  @property({ type: Boolean, attribute: 'offer-remember' })
  offerRemember = false;

  private _rememberChecked = false;

  private _accept() {
    this.dispatchEvent(
      new CustomEvent('transcription-accept', {
        detail: { requester: this.requester, remember: this._rememberChecked },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _decline() {
    this.dispatchEvent(
      new CustomEvent('transcription-decline', {
        detail: { requester: this.requester, remember: this._rememberChecked },
        bubbles: true,
        composed: true,
      }),
    );
  }

  render() {
    return html`
      <div class="dialog">
        <div
          class="panel"
          @click=${(e: Event) => e.stopPropagation()}
          @keypress=${() => undefined}
        >
          <div class="column" style="gap: 14px;">
            <div class="row center-content" style="gap: 8px;">
              <avatar-with-nickname
                .agentPubKey=${decodeHashFromBase64(this.requester)}
                .size=${32}
              ></avatar-with-nickname>
              <div class="headline">
                ${msg('wants to transcribe this call.')}
              </div>
            </div>
            <div class="body">
              ${msg(
                'Ok to activate local transcription of what you say to share? You can stop at any time.',
              )}
            </div>
            ${this.offerRemember
              ? html`
                  <label class="row items-center" style="gap: 6px;">
                    <input
                      type="checkbox"
                      @change=${(e: Event) => {
                        this._rememberChecked = (e.target as HTMLInputElement).checked;
                      }}
                    />
                    <span class="remember">
                      ${msg('Always accept transcription requests')}
                    </span>
                  </label>
                `
              : html``}
            <div class="row actions" style="gap: 10px; justify-content: flex-end;">
              <button class="secondary" @click=${() => this._decline()}>
                ${msg('No thanks')}
              </button>
              <button class="primary" @click=${() => this._accept()}>
                ${msg('Transcribe my mic')}
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  static styles = css`
    :host {
      /* Mount-as-overlay pattern — parent controls visibility by unmounting. */
      display: contents;
    }

    .dialog {
      display: flex;
      align-items: center;
      justify-content: center;
      position: fixed;
      top: 0;
      right: 0;
      bottom: 0;
      left: 0;
      z-index: 25;
      background: rgba(0, 0, 0, 0.35);
    }

    .panel {
      background: white;
      color: #222;
      padding: 28px 32px;
      border-radius: 10px;
      box-shadow: 0 0 3px 2px #1a1a1a55;
      max-width: 420px;
      font-family: sans-serif;
    }

    .row {
      display: flex;
      flex-direction: row;
    }

    .column {
      display: flex;
      flex-direction: column;
    }

    .center-content {
      align-items: center;
    }

    .items-center {
      align-items: center;
    }

    .headline {
      font-size: 18px;
      font-weight: 500;
    }

    .body {
      font-size: 14px;
      line-height: 20px;
    }

    .remember {
      font-size: 13px;
      color: #555;
    }

    button {
      padding: 8px 14px;
      border-radius: 6px;
      border: none;
      cursor: pointer;
      font-size: 14px;
    }

    button.primary {
      background: #4a6fff;
      color: white;
    }

    button.primary:hover {
      background: #3a5ae0;
    }

    button.secondary {
      background: #eee;
      color: #222;
    }

    button.secondary:hover {
      background: #ddd;
    }
  `;
}
