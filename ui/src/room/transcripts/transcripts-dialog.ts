import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { localized, msg, str } from '@lit/localize';
import { mdiArrowLeft, mdiDeleteOutline, mdiDownloadOutline, mdiEyeOutline } from '@mdi/js';
import { wrapPathInSvg } from '@holochain-open-dev/elements';

import type { AgentPubKeyB64 } from '@holochain/client';

import type { StoredTranscript, TranscriptStore } from './store';
import { describeDuration, selectTranscriptRows } from './dialog-policy';
import {
  formatOffset,
  renderTranscriptMarkdown,
  speakerCount,
  transcriptFileName,
  wordCount,
  type LabelFor,
} from './export';
import './transcript-view';

function countSpeakers(n: number): string {
  return n === 1 ? msg('1 speaker') : msg(str`${n} speakers`);
}

function countWords(n: number): string {
  return n === 1 ? msg('1 word') : msg(str`${n} words`);
}

/**
 * Overlay listing this room's stored transcripts with view, download and
 * delete.
 *
 * Events: `transcripts-close`.
 */
@localized()
@customElement('transcripts-dialog')
export class TranscriptsDialog extends LitElement {
  @property({ attribute: false }) store!: TranscriptStore;
  @property({ type: String }) roomKey = '';
  @property({ attribute: false }) labelFor: LabelFor = () => undefined;
  /** Looks up nicknames so that `labelFor` can answer for the given speakers. */
  @property({ attribute: false }) refreshLabels: ((pks: AgentPubKeyB64[]) => Promise<void>) | null = null;

  @state() private _entries: StoredTranscript[] = [];
  @state() private _loading = true;
  @state() private _viewing: StoredTranscript | null = null;
  @state() private _confirmDelete: string | null = null;

  connectedCallback() {
    super.connectedCallback();
    void this._reload();
  }

  private async _reload() {
    this._loading = true;
    try {
      this._entries = await this.store.listForRoom(this.roomKey);
    } catch (e) {
      console.error('transcripts: list failed', e);
      this._entries = [];
    } finally {
      this._loading = false;
    }
    await this._refreshUnlabelledSpeakers(this._entries);
  }

  /**
   * A record stores labels only for the speakers its visit could name at
   * the end; look up the rest so the list and view show nicknames.
   */
  private async _refreshUnlabelledSpeakers(entries: StoredTranscript[]) {
    const pks = new Set<AgentPubKeyB64>();
    for (const t of entries) {
      for (const f of t.frames) if (!(f.speaker in t.labels)) pks.add(f.speaker);
    }
    if (pks.size === 0 || !this.refreshLabels) return;
    try {
      await this.refreshLabels(Array.from(pks));
      this.requestUpdate();
    } catch (e) {
      console.error('transcripts: label lookup failed', e);
    }
  }

  private _rows(): StoredTranscript[] {
    return selectTranscriptRows(this._entries);
  }

  private _close() {
    this.dispatchEvent(new CustomEvent('transcripts-close', { bubbles: true, composed: true }));
  }

  private _download(t: StoredTranscript) {
    const blob = new Blob([renderTranscriptMarkdown(t, this.labelFor)], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = transcriptFileName(t);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  private async _delete(id: string) {
    this._confirmDelete = null;
    try {
      await this.store.delete(id);
    } catch (e) {
      console.error('transcripts: delete failed', e);
    }
    if (this._viewing?.id === id) this._viewing = null;
    await this._reload();
  }

  private _duration(t: StoredTranscript): string {
    const d = describeDuration(t);
    switch (d.kind) {
      case 'ended':
      case 'open':
        return formatOffset(d.ms);
      case 'empty':
        return '—';
    }
  }

  private _renderRow(t: StoredTranscript) {
    const confirming = this._confirmDelete === t.id;
    return html`
      <div class="row entry">
        <div class="column meta">
          <div class="when">${new Date(t.startedAt).toLocaleString()}</div>
          <div class="facts">
            ${this._duration(t)} · ${countSpeakers(speakerCount(t))} · ${countWords(wordCount(t))}
          </div>
        </div>
        <div class="row actions">
          ${confirming
            ? html`
                <span class="confirm">${msg('Delete this transcript?')}</span>
                <button class="danger" @click=${() => this._delete(t.id)}>${msg('Yes')}</button>
                <button class="secondary" @click=${() => (this._confirmDelete = null)}>${msg('No')}</button>
              `
            : html`
                <button class="icon" title=${msg('View')} @click=${() => (this._viewing = t)}>
                  <sl-icon .src=${wrapPathInSvg(mdiEyeOutline)}></sl-icon>
                </button>
                <button class="icon" title=${msg('Download')} @click=${() => this._download(t)}>
                  <sl-icon .src=${wrapPathInSvg(mdiDownloadOutline)}></sl-icon>
                </button>
                <button class="icon" title=${msg('Delete')} @click=${() => (this._confirmDelete = t.id)}>
                  <sl-icon .src=${wrapPathInSvg(mdiDeleteOutline)}></sl-icon>
                </button>
              `}
        </div>
      </div>
    `;
  }

  private _renderList() {
    const rows = this._rows();
    return html`
      <div class="headline">${msg('Transcripts')}</div>
      ${this.store.degraded
        ? html`<div class="warning">${msg('Transcripts cannot be stored in this browser; they are kept only until this page closes.')}</div>`
        : nothing}
      ${this._loading
        ? html`<div class="body">${msg('Loading…')}</div>`
        : rows.length === 0
          ? html`<div class="body">${msg('No transcripts yet. Start transcription during a call and it will appear here.')}</div>`
          : rows.map((t) => this._renderRow(t))}
      <div class="row actions end">
        <button class="secondary" @click=${() => this._close()}>${msg('Close')}</button>
      </div>
    `;
  }

  private _renderView(t: StoredTranscript) {
    return html`
      <div class="row center-content" style="gap: 8px;">
        <button class="icon" title=${msg('Back')} @click=${() => (this._viewing = null)}>
          <sl-icon .src=${wrapPathInSvg(mdiArrowLeft)}></sl-icon>
        </button>
        <div class="headline">${new Date(t.startedAt).toLocaleString()} · ${this._duration(t)}</div>
        <span style="flex: 1;"></span>
        <button class="icon" title=${msg('Download')} @click=${() => this._download(t)}>
          <sl-icon .src=${wrapPathInSvg(mdiDownloadOutline)}></sl-icon>
        </button>
      </div>
      <!-- A fresh labelFor each render, so labels looked up after opening show. -->
      <transcript-view
        class="transcript"
        .transcript=${t}
        .labelFor=${(pk: AgentPubKeyB64) => this.labelFor(pk)}
      ></transcript-view>
    `;
  }

  render() {
    return html`
      <div class="dialog" @click=${() => this._close()}>
        <div class="panel" @click=${(e: Event) => e.stopPropagation()} @keypress=${() => undefined}>
          <div class="column" style="gap: 12px;">
            ${this._viewing ? this._renderView(this._viewing) : this._renderList()}
          </div>
        </div>
      </div>
    `;
  }

  static styles = css`
    :host { display: contents; }
    .dialog {
      position: fixed; inset: 0; z-index: 25;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0, 0, 0, 0.35);
    }
    .panel {
      background: white; color: #222; border-radius: 12px;
      padding: 18px 20px; width: min(720px, 92vw); max-height: 85vh;
      overflow: auto; box-shadow: 0 8px 30px rgba(0, 0, 0, 0.35);
      font-family: 'Ubuntu', sans-serif;
    }
    .row { display: flex; flex-direction: row; align-items: center; }
    .column { display: flex; flex-direction: column; }
    .center-content { align-items: center; }
    .headline { font-size: 18px; font-weight: 600; }
    .body { font-size: 14px; color: #444; }
    .warning { font-size: 13px; color: #8a5a00; background: #fff4d6; padding: 6px 10px; border-radius: 6px; }
    .entry { justify-content: space-between; padding: 8px 4px; border-bottom: 1px solid #eee; gap: 12px; }
    .when { font-size: 14px; font-weight: 500; }
    .facts { font-size: 12px; color: #666; }
    .actions { gap: 6px; }
    .actions.end { justify-content: flex-end; margin-top: 6px; }
    .confirm { font-size: 13px; margin-right: 4px; }
    .transcript { max-height: 60vh; overflow: auto; font-size: 14px; }
    button { border: none; border-radius: 6px; padding: 6px 12px; font-size: 13px; cursor: pointer; }
    button.icon { background: transparent; padding: 4px; font-size: 18px; color: #333; }
    button.icon:hover { background: #eee; }
    button.secondary { background: #eee; }
    button.secondary:hover { background: #ddd; }
    button.danger { background: #d23030; color: white; }
    button.danger:hover { background: #b02020; }
  `;
}
