import { LitElement, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { AgentPubKey, AppClient, CellId, ClonedCell } from '@holochain/client';
import { localized, msg } from '@lit/localize';
import { NULL_HASH, WeaveClient } from '@theweave/api';

import '@shoelace-style/shoelace/dist/components/input/input';
import '@shoelace-style/shoelace/dist/components/icon/icon';
import '../shared/wal-to-pocket-btn';

import { consume } from '@lit/context';
import { sharedStyles } from '../sharedStyles';
import { clientContext } from '../contexts';
import { RoomClient } from '../room/room-client';
import { RoomInfo, weaveClientContext } from '../types';
import { getCellTypes, groupRoomNetworkSeed } from '../utils';
import { GroupRoomInfo } from '../presence-app';

import '../room/room-container';
import './list-online-agents';
import './room-online-agents';

@localized()
@customElement('shared-room-card')
export class SharedRoomCard extends LitElement {
  @consume({ context: clientContext })
  @state()
  client!: AppClient;

  @consume({ context: weaveClientContext })
  @state()
  _weaveClient!: WeaveClient;

  @property()
  groupRoomInfo!: GroupRoomInfo;

  // Main-room mode: render the always-present default room (the provisioned
  // cell) using the same card. groupRoomInfo / clone logic are not used here.
  @property({ type: Boolean })
  isMainRoom = false;

  @property()
  mainRoomCellId: CellId | undefined;

  @property()
  mainRoomParticipants: AgentPubKey[] = [];

  @state()
  _showSecretWords = false;

  @state()
  _roomInfo: RoomInfo | undefined;

  @state()
  _myCell: ClonedCell | undefined;

  @state()
  _networkSeed: string | undefined;

  async updateRoomInfo() {
    const appInfo = await this.client.appInfo();
    if (!appInfo) throw new Error('AppInfo is null');
    const cellTypes = getCellTypes(appInfo);
    const appletNetworkSeed = cellTypes.provisioned.dna_modifiers.network_seed;

    const networkSeed = groupRoomNetworkSeed(
      appletNetworkSeed,
      this.groupRoomInfo.room.network_seed_appendix
    );

    const myCell = cellTypes.cloned.find(
      clonedCell => networkSeed === clonedCell.dna_modifiers.network_seed
    );
    this._networkSeed = networkSeed;
    if (myCell) {
      this._myCell = myCell;
      const roomClient = new RoomClient(this.client, myCell.clone_id);
      const roomInfo = await roomClient.getRoomInfo();
      if (roomInfo) {
        this._roomInfo = roomInfo;
      }
      // Presence tracking is handled by <room-online-agents> (see render).
    } else {
      this._roomInfo = {
        name: this.groupRoomInfo.room.name,
        icon_src: this.groupRoomInfo.room.icon_src,
        meta_data: this.groupRoomInfo.room.meta_data,
      };
      // TODO if cell is not installed yet, what to show in UI? Online active room participants
      // cannot be displayed in this case
    }
  }

  async firstUpdated() {
    // Main-room display is hardcoded in render(); no _roomInfo needed. Setting
    // reactive state here synchronously would schedule a redundant update
    // (Lit's change-in-update warning), so just skip the room-info lookup.
    if (this.isMainRoom) return;
    await this.updateRoomInfo();
  }

  // Not requried anymore if repeat directive is used in the parent component
  // async willUpdate(
  //   changedProperties: PropertyValueMap<any> | Map<PropertyKey, unknown>
  // ) {
  //   if (changedProperties.has('groupRoomInfo')) {
  //     await this.updateRoomInfo();
  //   }
  // }

  async handleOpenRoom() {
    if (this.isMainRoom) {
      // Parent handles opening the provisioned cell (openAsset + fallback).
      this.dispatchEvent(
        new CustomEvent('request-open-room', {
          detail: { cell_id: this.mainRoomCellId },
          composed: true,
          bubbles: true,
        })
      );
      return;
    }
    // If the cell is not installed yet, install it first
    if (!this._myCell) {
      console.log('Installing cell.');
      // network seed must be defined at this point
      if (!this._networkSeed) throw new Error('Network seed undefined.');
      this._myCell = await this._weaveClient.createCloneCell(
        {
          role_name: 'presence',
          modifiers: {
            network_seed: this._networkSeed,
          },
        },
        true // This is a public clone
      );
      // Get AppInfo to update cachedAppInfo in AppClient (this should be fixed either with
      // a workaround in Moss or in the js-client)
      await this.client.appInfo();
      const roomClient = new RoomClient(this.client, this._myCell.clone_id);
      const roomInfo = await roomClient.getRoomInfo();
      if (roomInfo) {
        this._roomInfo = roomInfo;
      }
    }

    this.dispatchEvent(
      new CustomEvent('request-open-room', {
        detail: this._myCell,
        composed: true,
        bubbles: true,
      })
    );
  }

  renderActiveParticipants() {
    if (this.isMainRoom) {
      if (this.mainRoomParticipants.length === 0) {
        return html`<span>${msg('room is empty')}</span>`;
      }
      return html`
        <list-online-agents
          .avatarSize=${34}
          .agents=${this.mainRoomParticipants}
        ></list-online-agents>
      `;
    }
    if (!this._myCell) {
      return html`<span style="font-size: 18px; opacity: 0.8;"
        >${msg(
          'Join this room at least once to be able to see participants'
        )}</span
      >`;
    }
    return html`
      <room-online-agents
        .roleName=${this._myCell.clone_id}
        .avatarSize=${34}
      ></room-online-agents>
    `;
  }

  render() {
    return html`
      <div
        class="column shared-room-card secondary-font"
        style="align-items: flex-start; flex: 1;"
      >
        <div class="row" style="align-items: flex-start; flex: 1; width: 100%;">
          <div
            style="margin-bottom: 15px; font-size: 26px; font-weight: bold;${this
              .isMainRoom || this._roomInfo?.name
              ? ''
              : 'opacity: 0.6'}"
          >
            ${this.isMainRoom
              ? msg('Main Room')
              : this._roomInfo
              ? this._roomInfo.name
              : '[unknown]'}
          </div>
          <span style="display: flex; flex: 1;"></span>
          ${this.isMainRoom && this.mainRoomCellId
            ? html`<wal-to-pocket-btn
                class="pocket-btn"
                .wal=${{ hrl: [this.mainRoomCellId[0], NULL_HASH] }}
                .weaveClient=${this._weaveClient}
              ></wal-to-pocket-btn>`
            : this._myCell
            ? html`<wal-to-pocket-btn
                class="pocket-btn"
                .wal=${{ hrl: [this._myCell.cell_id[0], NULL_HASH] }}
                .weaveClient=${this._weaveClient}
              ></wal-to-pocket-btn>`
            : ''}
          <button
            @click=${() => this.handleOpenRoom()}
            class="enter-room-btn secondary-font"
          >
            <div class="row center-content">
              <img
                src="door.png"
                alt="icon of a door"
                style="height: 25px; margin-right: 6px; transform: scaleX(-1);"
              />
              <span> Enter</span>
            </div>
          </button>
        </div>
        <div
          class="row"
          style="flex: 1; width: calc(100% - 4px); justify-content: flex-end;"
        >
          ${this.renderActiveParticipants()}
        </div>
      </div>
    `;
  }

  static styles = [
    sharedStyles,
    css`
      .shared-room-card {
        align-items: flex-start;
        width: min(600px, 100%);
        margin-left: auto;
        margin-right: auto;
        box-sizing: border-box;
        overflow-wrap: anywhere;
        /* background: #40638f; */
        /* background: #668fc2; */
        /* background: #102a4d; */
        /* background: #b2b9e0; */
        /* background: linear-gradient(#b2b9e0, #9ba3d0); */
        background: linear-gradient(#a7aed8, #8f98c9);
        /* background-image: url(); */
        /* object-fit: cover; */
        /* background-position: center center; */
        /* background: #ced5fa; */
        padding: 20px 20px;
        border-radius: 25px;
        color: #071b31;
        font-size: 20px;
        box-shadow: 1px 1px 8px 2px #020b16b8;
      }

      .pocket-btn {
        margin-right: 10px;
        --bg-color: #2a4a8f;
        --bg-color-hover: #3558a0;
        color: #fff0f0;
      }

      .enter-room-btn {
        background: linear-gradient(#2a4a8f, #1a3060);
        border-radius: 20px;
        color: #fff0f0;
        border: none;
        padding: 5px 10px;
        box-shadow: 0 0 15px 3px rgba(100, 140, 255, 0.2), 1px 1px 4px 2px #03162f;
        font-weight: 600;
        font-size: 20px;
        cursor: pointer;
      }

      .enter-room-btn:hover {
        background: linear-gradient(#3558a0, #1f3870);
        box-shadow: 0 0 20px 4px rgba(100, 140, 255, 0.3), 1px 1px 4px 2px #03162f;
      }

      .enter-room-btn:focus {
        background: linear-gradient(#3558a0, #1f3870);
        box-shadow: 0 0 20px 4px rgba(100, 140, 255, 0.3), 1px 1px 4px 2px #03162f;
      }

      .secret-words {
        color: #061426;
        font-size: 18px;
        /* background: #cde3ff; */
        font-family: sans-serif;
        background: #fff0f0;
        padding: 3px 8px;
        border-radius: 5px;
        min-width: 400px;
        text-align: center;
      }

      .eye-icon {
        cursor: pointer;
        margin: 0 5px;
      }
      .eye-icon:hover {
        color: white;
      }

      .copy-icon {
        cursor: pointer;
      }
      .copy-icon:hover {
        color: white;
      }
      .copy-icon:active {
        color: #42f03c;
      }
    `,
  ];
}
