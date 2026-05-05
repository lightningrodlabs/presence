import { LitElement, css, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { localized, msg } from '@lit/localize';
import type { AgentPubKeyB64 } from '@holochain/client';

/**
 * Completeness status computed by the parent for each speaker whose
 * transcript we received. Drives the "Save transcript?" prompt so
 * the user knows whether to expect gaps before saving.
 *
 *   complete — peer broadcast a finalSeq and all expected frames
 *              arrived (max received seq matches finalSeq).
 *   gap      — peer broadcast a finalSeq but we're missing frames.
 *   unknown  — peer left without broadcasting a finalSeq (crash,
 *              network loss, force-quit).
 */
export interface SpeakerCompleteness {
  /** Short display name the parent has resolved for this speaker. */
  label: string;
  status: 'complete' | 'gap' | 'unknown';
  utteranceCount: number;
  detail?: string;
}

/**
 * Exit-time "Save transcript?" prompt. Parent supplies the computed
 * markdown and the per-speaker completeness map; this element just
 * shows the confirmation.
 *
 * Events:
 *   transcription-save-confirm — the user clicked Save.
 *   transcription-save-discard — the user clicked Discard.
 *
 * Either event must resume quitRoom on the parent side.
 */
@localized()
@customElement('save-transcript-dialog')
export class SaveTranscriptDialog extends LitElement {
  @property({ type: Object })
  speakerCompleteness: Map<AgentPubKeyB64, SpeakerCompleteness> = new Map();

  private _save() {
    this.dispatchEvent(
      new CustomEvent('transcription-save-confirm', {
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _discard() {
    this.dispatchEvent(
      new CustomEvent('transcription-save-discard', {
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _renderSpeakerRow(s: SpeakerCompleteness) {
    const statusIcon = s.status === 'complete' ? '✓' : s.status === 'gap' ? '⚠' : '✗';
    const statusColor =
      s.status === 'complete' ? '#4a9' : s.status === 'gap' ? '#e7a008' : '#d44';
    return html`
      <div class="speaker-row">
        <span class="status" style="color: ${statusColor}">${statusIcon}</span>
        <span class="label">${s.label}</span>
        <span class="count">${s.utteranceCount} ${msg('utterances')}</span>
        ${s.detail
          ? html`<span class="detail">${s.detail}</span>`
          : html``}
      </div>
    `;
  }

  render() {
    const speakers = Array.from(this.speakerCompleteness.entries());
    const isEmpty = speakers.length === 0;
    const hasGaps = speakers.some(
      ([, s]) => s.status === 'gap' || s.status === 'unknown',
    );
    return html`
      <div class="dialog">
        <div
          class="panel"
          @click=${(e: Event) => e.stopPropagation()}
          @keypress=${() => undefined}
        >
          <div class="column" style="gap: 14px;">
            <div class="headline">
              ${isEmpty ? msg('Transcription produced no utterances') : msg('Save transcript?')}
            </div>
            ${isEmpty
              ? html`<div class="body">
                  ${msg(
                    'Transcription was enabled but no utterances were captured. Make sure your microphone is on and unmuted, that you spoke long enough for Moss to commit a final, and that Moss has a transcription model configured under Local AI settings.',
                  )}
                </div>`
              : html``}
            ${hasGaps
              ? html`<div class="warning">
                  ${msg(
                    'Some transcripts are incomplete. Speakers who left without finalizing (✗) or whose frames did not all arrive (⚠) may be missing utterances.',
                  )}
                </div>`
              : html``}
            ${isEmpty
              ? html``
              : html`
                  <div class="speakers">
                    ${speakers.map(([, s]) => this._renderSpeakerRow(s))}
                  </div>
                `}
            <div class="row actions" style="gap: 10px; justify-content: flex-end;">
              <button class="secondary" @click=${() => this._discard()}>
                ${isEmpty ? msg('Close') : msg('Discard')}
              </button>
              ${isEmpty
                ? html``
                : html`<button class="primary" @click=${() => this._save()}>
                    ${msg('Save as Markdown')}
                  </button>`}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  static styles = css`
    :host { display: contents; }

    .dialog {
      display: flex;
      align-items: center;
      justify-content: center;
      position: fixed;
      top: 0;
      right: 0;
      bottom: 0;
      left: 0;
      z-index: 30;
      background: rgba(0, 0, 0, 0.4);
    }

    .panel {
      background: white;
      color: #222;
      padding: 26px 30px;
      border-radius: 10px;
      box-shadow: 0 0 3px 2px #1a1a1a55;
      max-width: 480px;
      min-width: 340px;
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

    .headline {
      font-size: 20px;
      font-weight: 500;
    }

    .warning {
      background: #fff3cd;
      border-left: 3px solid #e7a008;
      padding: 8px 12px;
      font-size: 13px;
      line-height: 18px;
      border-radius: 2px;
    }

    .speakers {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 14px;
    }

    .speaker-row {
      display: grid;
      grid-template-columns: 18px 1fr auto;
      gap: 8px;
      align-items: baseline;
    }

    .status {
      font-size: 16px;
      text-align: center;
    }

    .label {
      font-weight: 500;
    }

    .count {
      color: #666;
      font-size: 12px;
    }

    .detail {
      grid-column: 2 / 4;
      color: #e7a008;
      font-size: 12px;
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

    button.primary:hover { background: #3a5ae0; }

    button.secondary {
      background: #eee;
      color: #222;
    }

    button.secondary:hover { background: #ddd; }
  `;
}
