import { LitElement, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { consume } from '@lit/context';
import { localized, msg } from '@lit/localize';
import {
  AppletInfo,
  AssetLocationAndInfo,
  encodeContext,
  GroupProfile,
  stringifyHrl,
  WAL,
  WeaveClient,
  weaveUrlToLocation,
} from '@theweave/api';
import { DnaHash, encodeHashToBase64 } from '@holochain/client';
import { encode } from '@msgpack/msgpack';
import { fromUint8Array } from 'js-base64';
import { wrapPathInSvg } from '@holochain-open-dev/elements';
import { mdiClose, mdiOpenInNew } from '@mdi/js';
import '@shoelace-style/shoelace/dist/components/icon/icon.js';
import '@shoelace-style/shoelace/dist/components/spinner/spinner.js';
import '@shoelace-style/shoelace/dist/components/tooltip/tooltip.js';
import { weaveClientContext } from '../../types';

type AssetStatus =
  | { type: 'loading' }
  | { type: 'invalid url' }
  | { type: 'not found' }
  | { type: 'success'; assetInfo: AssetLocationAndInfo };

@localized()
@customElement('shared-wal-embed')
export class SharedWalEmbed extends LitElement {
  @consume({ context: weaveClientContext })
  @state()
  _weaveClient!: WeaveClient;

  @property()
  src!: string;

  @property({ type: Boolean })
  closable = false;

  @state()
  assetStatus: AssetStatus = { type: 'loading' };

  @state()
  wal: WAL | undefined;

  @state()
  appletInfo: AppletInfo | undefined;

  @state()
  groupProfiles: Map<DnaHash, GroupProfile> | undefined;

  async firstUpdated() {
    let weaveLocation;
    try {
      weaveLocation = weaveUrlToLocation(this.src);
    } catch (e) {
      this.assetStatus = { type: 'invalid url' };
      return;
    }

    if (weaveLocation.type !== 'asset') {
      this.assetStatus = { type: 'invalid url' };
      return;
    }

    this.wal = weaveLocation.wal;

    try {
      const assetInfo = await this._weaveClient.assets.assetInfo(weaveLocation.wal);
      this.assetStatus = assetInfo
        ? { type: 'success', assetInfo }
        : { type: 'not found' };

      if (assetInfo) {
        try {
          const appletInfo = await (this._weaveClient as any).appletInfo(assetInfo.appletHash);
          this.appletInfo = appletInfo ?? undefined;
          if (appletInfo) {
            const profiles = new Map<DnaHash, GroupProfile>();
            for (const groupHash of appletInfo.groupsHashes) {
              const profile = await (this._weaveClient as any).groupProfile(groupHash);
              if (profile) profiles.set(groupHash, profile);
            }
            this.groupProfiles = profiles;
          }
        } catch (e) {
          console.warn('Could not resolve applet/group info for embedded WAL:', e);
        }
      }
    } catch (e) {
      console.warn('Failed to resolve asset info for embedded WAL:', e);
      this.assetStatus = { type: 'not found' };
    }
  }

  async openInSidebar() {
    if (this.wal) await this._weaveClient.openAsset(this.wal, 'side');
  }

  emitClose() {
    this.dispatchEvent(new CustomEvent('close', { detail: this.wal }));
  }

  private toLowerCaseB64(hashb64: string): string {
    return hashb64.replace(/[A-Z]/g, (match) => match.toLowerCase() + '$');
  }

  renderHeader() {
    return html`
      <div class="top-bar row" style="align-items: center;">
        ${this.assetStatus.type === 'success'
          ? html`
            <div class="row" style="align-items: center;">
              <sl-icon style="font-size: 24px;" .src=${this.assetStatus.assetInfo.assetInfo.icon_src}></sl-icon>
              <div style="font-size: 16px; margin-left: 3px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;"
                title=${this.assetStatus.assetInfo.assetInfo.name}>
                ${this.assetStatus.assetInfo.assetInfo.name}
              </div>
            </div>`
          : html``}
        <span style="flex: 1;"></span>
        ${this.appletInfo
          ? html`
            <sl-tooltip .content=${this.appletInfo.appletName}>
              <img style="height: 24px; border-radius: 3px; margin-right: 4px;" .src=${this.appletInfo.appletIcon} />
            </sl-tooltip>`
          : html``}
        <sl-tooltip .content=${msg('Open in sidebar')}>
          <div class="header-btn" tabindex="0"
            @click=${() => this.openInSidebar()}
            @keypress=${(e: KeyboardEvent) => { if (e.key === 'Enter') this.openInSidebar(); }}>
            <sl-icon .src=${wrapPathInSvg(mdiOpenInNew)} style="font-size: 22px;"></sl-icon>
          </div>
        </sl-tooltip>
        ${this.closable
          ? html`
            <sl-tooltip .content=${msg('Stop sharing')}>
              <div class="header-btn close-btn" tabindex="0"
                @click=${() => this.emitClose()}
                @keypress=${(e: KeyboardEvent) => { if (e.key === 'Enter') this.emitClose(); }}>
                <sl-icon .src=${wrapPathInSvg(mdiClose)} style="font-size: 22px;"></sl-icon>
              </div>
            </sl-tooltip>`
          : html``}
      </div>
    `;
  }

  renderContent() {
    switch (this.assetStatus.type) {
      case 'loading':
        return html`<div class="center-content" style="padding: 20px;"><sl-spinner></sl-spinner></div>`;
      case 'not found':
        return html`<div class="center-content" style="padding: 20px; color: #ffaa00;">
          ${msg('Asset not found. The required tool may not be activated.')}
        </div>`;
      case 'invalid url':
        return html`<div class="center-content" style="padding: 20px; color: #ff6666;">${msg('Invalid WAL URL.')}</div>`;
      case 'success': {
        if (!this.wal) return html``;
        const queryString = `view=applet-view&view-type=asset&hrl=${stringifyHrl(this.wal.hrl)}${
          this.wal.context ? `&context=${encodeContext(this.wal.context)}` : ''
        }`;

        if (!this.appletInfo) {
          return html`<div class="center-content" style="padding: 20px;"><sl-spinner></sl-spinner></div>`;
        }

        const groupHash = this.appletInfo.groupsHashes[0];
        const iframeKind = {
          type: 'applet',
          appletHash: this.assetStatus.assetInfo.appletHash,
          groupHash,
          subType: 'asset',
        };
        const iframeKindEncoded = fromUint8Array(encode(iframeKind));

        let iframeSrc: string;
        if (this.assetStatus.assetInfo.appletDevPort) {
          iframeSrc = `http://localhost:${this.assetStatus.assetInfo.appletDevPort}?${queryString}#${iframeKindEncoded}`;
        } else {
          const appletHashB64 = encodeHashToBase64(this.assetStatus.assetInfo.appletHash);
          iframeSrc = `applet://${this.toLowerCaseB64(appletHashB64)}?${queryString}`;
        }
        return html`<iframe
          frameborder="0"
          title="Shared WAL"
          src="${iframeSrc}"
          style="flex: 1; display: block; width: 100%; border: none;"
          allow="clipboard-write;"
        ></iframe>`;
      }
    }
  }

  render() {
    return html`
      <div class="container">
        ${this.renderHeader()}
        ${this.renderContent()}
      </div>
    `;
  }

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
    }

    .container {
      display: flex;
      flex-direction: column;
      flex: 1;
      border-radius: 4px;
      overflow: hidden;
      background: #1e2136;
    }

    .row {
      display: flex;
      flex-direction: row;
    }

    .center-content {
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .top-bar {
      height: 32px;
      background: #5a5f8a;
      padding: 0 8px;
      color: white;
      font-family: sans-serif;
    }

    .header-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 26px;
      width: 26px;
      margin-left: 4px;
      border-radius: 3px;
      background: rgba(255, 255, 255, 0.15);
      cursor: pointer;
      color: white;
    }

    .header-btn:hover {
      background: rgba(255, 255, 255, 0.3);
    }

    .close-btn {
      background: #c32424;
    }

    .close-btn:hover {
      background: #e04444;
    }

    iframe {
      min-height: 200px;
    }
  `;
}
