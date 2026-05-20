import { LitElement, css, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { WAL, WeaveClient } from '@theweave/api';
import { wrapPathInSvg } from '@holochain-open-dev/elements';
import { mdiNotePlusOutline } from '@mdi/js';
import '@shoelace-style/shoelace/dist/components/icon/icon.js';
import '@shoelace-style/shoelace/dist/components/tooltip/tooltip.js';

@customElement('wal-to-pocket-btn')
export class WalToPocketBtn extends LitElement {
  @property()
  wal!: WAL;

  @property({ attribute: false })
  weaveClient!: WeaveClient;

  @property()
  label = 'Add to pocket';

  private async addToPocket() {
    await this.weaveClient.assets.assetToPocket(this.wal);
  }

  render() {
    return html`
      <sl-tooltip content=${this.label}>
        <div
          class="btn"
          tabindex="0"
          @click=${() => this.addToPocket()}
          @keypress=${(e: KeyboardEvent) => {
            if (e.key === 'Enter') this.addToPocket();
          }}
        >
          <sl-icon .src=${wrapPathInSvg(mdiNotePlusOutline)}></sl-icon>
        </div>
      </sl-tooltip>
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
