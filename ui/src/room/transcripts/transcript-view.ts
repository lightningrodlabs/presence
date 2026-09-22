import { LitElement, css, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { localized, msg } from '@lit/localize';

import type { StoredTranscript } from './store';
import { formatOffset, transcriptLines, type LabelFor } from './export';

/**
 * The body of one transcript: coalesced speaker lines with offsets from
 * the first line. The one rendering of a transcript, shared by the
 * transcripts dialog and the room's connection-details pane. Scrolling
 * belongs to the container.
 *
 * Colors follow `--transcript-text-color` and `--transcript-muted-color`.
 */
@localized()
@customElement('transcript-view')
export class TranscriptView extends LitElement {
  @property({ attribute: false }) transcript: StoredTranscript | null = null;
  /** Pass a fresh function when labels change, so the view re-renders. */
  @property({ attribute: false }) labelFor: LabelFor = () => undefined;

  render() {
    const lines = this.transcript ? transcriptLines(this.transcript, this.labelFor) : [];
    if (lines.length === 0) return html`<div class="empty">${msg('No utterances yet.')}</div>`;
    const t0 = lines[0].ts;
    return lines.map(
      (l) => html`
        <p>
          <span class="offset">[${formatOffset(l.ts - t0)}]</span>
          <b>${l.label}:</b> ${l.text}
        </p>
      `,
    );
  }

  static styles = css`
    :host {
      display: block;
      color: var(--transcript-text-color, #222);
      line-height: 1.45;
    }
    p { margin: 0 0 10px; }
    .offset {
      color: var(--transcript-muted-color, #888);
      font-family: monospace;
      font-size: 0.85em;
      margin-right: 6px;
    }
    .empty { color: var(--transcript-muted-color, #888); font-style: italic; }
  `;
}
