/* eslint-disable no-console */
import '@fontsource/pacifico';
import '@fontsource/gabriela';
import '@fontsource-variable/noto-sans-sc';
// Supports weights 400-800
import '@fontsource-variable/baloo-2';
import '@fontsource/ubuntu/300-italic.css';
import '@fontsource/ubuntu/400-italic.css';
import '@fontsource/ubuntu/500-italic.css';
import '@fontsource/ubuntu/700-italic.css';
import '@fontsource/ubuntu/300.css';
import '@fontsource/ubuntu/400.css';
import '@fontsource/ubuntu/500.css';
import '@fontsource/ubuntu/700.css';
import { LitElement, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import {
  AppWebsocket,
  AppClient,
  ClonedCell,
  RoleName,
  encodeHashToBase64,
  AgentPubKey,
  ProvisionedCell,
  ActionHash,
} from '@holochain/client';
import { provide } from '@lit/context';
import {
  AppletServices,
  MossAccountability,
  GroupProfile,
  NULL_HASH,
  WAL,
  WeaveClient,
  initializeHotReload,
  isWeaveContext,
} from '@theweave/api';
import { generateSillyPassword } from 'silly-password-generator';
import {
  ProfilesStore,
  profilesStoreContext,
} from '@holochain-open-dev/profiles';
import { msg } from '@lit/localize';
import { v4 as uuidv4 } from 'uuid';
import { wrapPathInSvg } from '@holochain-open-dev/elements';
import {
  mdiAccountGroup,
  mdiClose,
  mdiCog,
  mdiDoor,
  mdiLock,
  mdiLockOpenOutline,
  mdiRefresh,
} from '@mdi/js';

import '@shoelace-style/shoelace/dist/components/input/input';
import '@shoelace-style/shoelace/dist/components/icon/icon';
import './shared/wal-to-pocket-btn';

import { clientContext } from './contexts';

import './room/room-container';
import './room/elements/toggle-switch';
import './lobby/private-room-card';
import './lobby/shared-room-card';
import './lobby/list-online-agents';
import { sharedStyles } from './sharedStyles';
import { RoomClient } from './room/room-client';
import { exportLogs, clearAllLogs } from './logging';
import { downloadJson, formattedDate } from './utils';
import { DescendentRoom, weaveClientContext } from './types';
import { RoomStore } from './room/room-store';
import { CellTypes, getCellTypes, groupRoomNetworkSeed } from './utils';

declare const __APP_VERSION__: string;

enum PageView {
  Loading,
  Home,
  Room,
  // Generic "enter this room" pane. Shown as the initial state when a room is
  // opened as an embedded asset (instead of auto-entering), and after a room is
  // closed or taken over by another pane.
  EnterRoom,
}

export type GroupRoomInfo = {
  room: DescendentRoom;
  creator: AgentPubKey;
  linkActionHash: ActionHash;
};

@customElement('presence-app')
export class PresenceApp extends LitElement {
  @provide({ context: clientContext })
  @property({ type: Object })
  client!: AppClient;

  @provide({ context: weaveClientContext })
  @property({ type: Object })
  _weaveClient!: WeaveClient;

  @provide({ context: profilesStoreContext })
  @property({ type: Object })
  _profilesStore!: ProfilesStore;

  @state()
  _pageView: PageView = PageView.Loading;

  @state()
  _personalRooms: ClonedCell[] = [];

  @state()
  _groupRooms: GroupRoomInfo[] = [];

  @state()
  _selectedRoleName: RoleName | undefined;

  @state()
  _selectedWal: WAL | undefined;

  @state()
  _roomAlreadyOpen = false;

  private _roomLockRelease: (() => void) | undefined;

  private _currentRoomDnaB64: string | undefined;

  @state()
  _currentRoomName: string | undefined;

  private _roomChannel: BroadcastChannel | undefined;

  @state()
  _takingOver = false;

  @state()
  _displayError: string | undefined;

  @state()
  _groupProfile: GroupProfile | undefined;

  @state()
  _mainRoomStore: RoomStore | undefined;

  @state()
  _showGroupRooms = true;

  @state()
  _provisionedCell: ProvisionedCell | undefined;

  @state()
  _myAccountabilities: MossAccountability[] | undefined;

  @state()
  _activeMainRoomParticipants: {
    pubkey: AgentPubKey;
    lastSeen: number;
  }[] = [];

  @state()
  _clearActiveParticipantsInterval: number | undefined;

  @state()
  _refreshing = false;

  @state()
  _showSettings = false;

  @state()
  _logCleared = false;

  @state()
  _showAdvancedSettings = false;

  @state()
  _trickleICE = JSON.parse(window.localStorage.getItem('trickleICE') ?? 'true');

  @state()
  _turnUrl = window.localStorage.getItem('turnUrl') ?? '';

  @state()
  _turnUsername = window.localStorage.getItem('turnUsername') ?? '';

  @state()
  _turnCredential = window.localStorage.getItem('turnCredential') ?? '';

  @state()
  _signalDelayMs = parseInt(window.localStorage.getItem('signalDelayMs') ?? '0', 10) || 0;

  @state()
  _showCreateForm = false;

  @state()
  _creatingRoom = false;

  @state()
  externalWindow = false;

  @state()
  _unsubscribe: (() => void) | undefined;

  disconnectedCallback(): void {
    if (this._clearActiveParticipantsInterval)
      window.clearInterval(this._clearActiveParticipantsInterval);
    if (this._unsubscribe) this._unsubscribe();
  }

  async firstUpdated() {
    const start = Date.now();
    if ((import.meta as any).env.DEV) {
      try {
        await initializeHotReload();
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(
          'Could not initialize applet hot-reloading. This is only expected to work in a We context in dev mode.'
        );
      }
    }
    if (isWeaveContext()) {
      const appletServices: AppletServices = {
        creatables: {},
        blockTypes: {},
        getAssetInfo: async (appletClient, wal, _recordInfo) => {
          // eslint-disable-next-line no-debugger
          // debugger;
          const appInfo = await appletClient.appInfo();
          if (!appInfo) throw new Error('AppInfo undefined.');
          const cellTypes = getCellTypes(appInfo as any);
          const dnaHashB64 = encodeHashToBase64(wal.hrl[0]);
          // alert(dnaHashB64);
          const mainRoomCell = cellTypes.provisioned;
          if (encodeHashToBase64(mainRoomCell.cell_id[0]) === dnaHashB64) {
            return {
              name: 'Main Room',
              icon_src: wrapPathInSvg(mdiDoor),
            };
          }
          // take room info from cached value if it exists
          const maybeRoomInfo = this._groupRooms.find(
            roomInfo =>
              encodeHashToBase64(roomInfo.room.dna_hash) === dnaHashB64
          );
          if (maybeRoomInfo) {
            return {
              name: maybeRoomInfo.room.name,
              icon_src: wrapPathInSvg(mdiDoor),
            };
          }

          const maybeClonedCell = cellTypes.cloned.find(
            cell => encodeHashToBase64(cell.cell_id[0]) === dnaHashB64
          );
          if (maybeClonedCell) {
            const roomClient = new RoomClient(
              this.client,
              maybeClonedCell.clone_id
            );
            const roomInfo = await roomClient.getRoomInfo();
            if (roomInfo)
              return {
                name: roomInfo.name,
                icon_src: wrapPathInSvg(mdiDoor),
              };
          }
          return Promise.resolve(undefined);
        },
        search: () => Promise.resolve([]),
      };
      const weaveClient = await WeaveClient.connect(appletServices);
      this._weaveClient = weaveClient;
      if (
        weaveClient.renderInfo.type !== 'applet-view' ||
        !['main', 'asset'].includes(weaveClient.renderInfo.view.type)
      )
        throw new Error(
          'This Applet only implements the applet main and asset views.'
        );
      this.client = weaveClient.renderInfo.appletClient as any;
      this._profilesStore = new ProfilesStore(
        weaveClient.renderInfo.profilesClient as any
      );
    } else {
      // We pass an unused string as the url because it will dynamically be replaced in launcher environments
      this.client = await AppWebsocket.connect();
    }

    if (
      this._weaveClient.renderInfo.type === 'applet-view' &&
      this._weaveClient.renderInfo.view.type === 'asset'
    ) {
      this.externalWindow = true;
      const appInfo = await this.client.appInfo();
      if (!appInfo) throw new Error('AppInfo is null');

      const cellTypes = getCellTypes(appInfo);

      const wal = this._weaveClient.renderInfo.view.wal;
      const dnaHash = wal.hrl[0];
      const dnaHashB64 = encodeHashToBase64(dnaHash);

      this._selectedWal = wal;

      if (encodeHashToBase64(cellTypes.provisioned.cell_id[0]) === dnaHashB64) {
        this._selectedRoleName = 'presence';
      } else {
        const clonedCell = cellTypes.cloned.find(
          cellInfo => encodeHashToBase64(cellInfo.cell_id[0]) === dnaHashB64
        );
        if (!clonedCell) throw Error('No cell found for WAL');
        this._selectedRoleName = clonedCell.clone_id;
      }
      this._currentRoomDnaB64 = dnaHashB64;
      this._currentRoomName = await this._roomNameForRole(this._selectedRoleName);

      // Only auto-enter when Moss reports this asset is opened in its own
      // dedicated window. When embedded inline (e.g. a group dashboard tile),
      // shown in the side panel, or when the host is too old to report a
      // location, show the enter pane instead — otherwise we silently join the
      // room on every visit to the group home. (renderLocation is undefined on
      // Moss hosts older than @theweave/api 0.6.8.)
      const renderLocation =
        this._weaveClient.renderInfo.type === 'applet-view'
          ? this._weaveClient.renderInfo.renderLocation
          : undefined;
      if (renderLocation === 'window') {
        await this._enterRoom(dnaHashB64);
      } else {
        this._pageView = PageView.EnterRoom;
      }
      return;
    }

    this._mainRoomStore = new RoomStore(
      new RoomClient(this.client, 'presence', 'room')
    );

    const cellTypes = await this.updateRoomLists();

    this._provisionedCell = cellTypes.provisioned;

    const loadFinished = Date.now();
    const timeElapsed = loadFinished - start;
    if (timeElapsed > 3000) {
      this._pageView = PageView.Home;
    } else {
      setTimeout(() => {
        this._pageView = PageView.Home;
      }, 3000 - timeElapsed);
    }

    this._clearActiveParticipantsInterval = window.setInterval(() => {
      const now = Date.now();
      // If an agent hasn't sent a ping for more than 10 seconds, assume that they are no longer in the room
      this._activeMainRoomParticipants =
        this._activeMainRoomParticipants.filter(
          info => now - info.lastSeen < 10000
        );
    }, 10000);

    this._unsubscribe = this._mainRoomStore.client.onSignal(async signal => {
      if (signal.type === 'Message' && signal.msg_type === 'PingUi') {
        // This is the case if the other agent is in the main room
        const newOnlineAgentsList = this._activeMainRoomParticipants.filter(
          info => info.pubkey.toString() !== signal.from_agent.toString()
        );
        newOnlineAgentsList.push({
          pubkey: signal.from_agent,
          lastSeen: Date.now(),
        });
        this._activeMainRoomParticipants = newOnlineAgentsList;
      }
      if (signal.type === 'Message' && signal.msg_type === 'LeaveUi') {
        this._activeMainRoomParticipants =
          this._activeMainRoomParticipants.filter(
            info => info.pubkey.toString() !== signal.from_agent.toString()
          );
      }
    });
  }

  /**
   * Acquire an exclusive same-origin lock for a room's DNA. If another pane in
   * this Moss applet origin is already holding it, the lock request is denied
   * and `_roomAlreadyOpen` is set so the render path shows a notice instead of
   * a second room-container (which would cause duplicate signaling/streams).
   */
  /**
   * Resolve a human-readable room name from a role name. The provisioned
   * 'presence' cell is the Main Room; cloned cells carry their name in room
   * info. Falls back to a generic label if the lookup fails.
   */
  private async _roomNameForRole(
    roleName: RoleName | undefined
  ): Promise<string> {
    if (roleName === 'presence') return msg('Main Room');
    if (roleName) {
      try {
        const info = await new RoomClient(this.client, roleName).getRoomInfo();
        if (info?.name) return info.name;
      } catch (e) {
        console.warn('Failed to load room info', e);
      }
    }
    return msg('this room');
  }

  private async _enterRoom(
    dnaHashB64: string,
    opts: { waitMs?: number } = {}
  ) {
    this._currentRoomDnaB64 = dnaHashB64;
    // Resolve the room name (non-blocking) so the enter pane can show it if the
    // room is later closed or taken over.
    this._roomNameForRole(this._selectedRoleName).then(name => {
      this._currentRoomName = name;
    });
    this._roomAlreadyOpen = false;
    const locks = (navigator as any).locks;
    if (!locks) {
      this._pageView = PageView.Room;
      return;
    }
    const lockName = `presence-room:${dnaHashB64}`;
    // If waitMs is set, request the lock and wait up to that many ms for the
    // current holder to release. Otherwise fail fast via `ifAvailable: true`.
    const requestOpts: LockOptions = opts.waitMs
      ? { signal: AbortSignal.timeout(opts.waitMs) }
      : { ifAvailable: true };
    const acquired = new Promise<{ release?: () => void }>(resolveOuter => {
      locks
        .request(lockName, requestOpts, (lock: Lock | null) => {
          if (!lock) {
            resolveOuter({});
            return undefined;
          }
          return new Promise<void>(resolveInner => {
            resolveOuter({ release: resolveInner });
          });
        })
        .catch((err: any) => {
          if (err && err.name !== 'AbortError') {
            console.warn('locks.request failed', err);
          }
          resolveOuter({});
        });
    });
    const { release } = await acquired;
    if (!release) {
      this._roomAlreadyOpen = true;
    } else {
      this._roomLockRelease = release;
      // Listen for take-over requests from other panes in the same origin.
      const channel = new BroadcastChannel('presence-room');
      channel.onmessage = (e: MessageEvent) => {
        const data = e.data;
        if (!data || typeof data !== 'object') return;
        if (data.dnaHashB64 !== dnaHashB64) return;
        if (data.type === 'kick') {
          // Another pane is asking us to release this room so it can take over.
          // Send the ack BEFORE releasing — _releaseRoomLock closes this same
          // channel, after which postMessage would throw and the taker would
          // time out.
          try {
            channel.postMessage({ type: 'released', dnaHashB64 });
          } catch (err) {
            console.warn('released broadcast failed', err);
          }
          this._releaseRoomLock();
          this._pageView = PageView.EnterRoom;
        }
      };
      this._roomChannel = channel;
    }
    this._pageView = PageView.Room;
  }

  /**
   * Ask the pane currently holding the room lock to release it, then take over
   * here. Resolves true if we got the lock, false if no one acknowledged in
   * time.
   */
  private async _takeOverRoom(dnaHashB64: string): Promise<boolean> {
    const channel = new BroadcastChannel('presence-room');
    const released = new Promise<boolean>(resolve => {
      const timer = window.setTimeout(() => {
        resolve(false);
      }, 2000);
      channel.onmessage = (e: MessageEvent) => {
        const data = e.data;
        if (
          data &&
          data.type === 'released' &&
          data.dnaHashB64 === dnaHashB64
        ) {
          window.clearTimeout(timer);
          resolve(true);
        }
      };
    });
    channel.postMessage({ type: 'kick', dnaHashB64 });
    const ok = await released;
    channel.close();
    return ok;
  }

  private _releaseRoomLock() {
    if (this._roomLockRelease) {
      this._roomLockRelease();
      this._roomLockRelease = undefined;
    }
    if (this._roomChannel) {
      this._roomChannel.close();
      this._roomChannel = undefined;
    }
    this._roomAlreadyOpen = false;
  }

  notifyError(msg: string) {
    this._displayError = msg;
    setTimeout(() => {
      this._displayError = undefined;
    }, 4000);
  }

  async checkPermission(): Promise<void> {
    let accountabilities: MossAccountability[] = this._myAccountabilities || [];
    if (!this._myAccountabilities && this._weaveClient.renderInfo.type === 'applet-view') {
      const accountabilitiesPerGroup = await this._weaveClient.myAccountabilitiesPerGroup();
      if (this._weaveClient.renderInfo.groupHash) {
        const groupHash = encodeHashToBase64(this._weaveClient.renderInfo.groupHash);
        const maybeAccountabilities = accountabilitiesPerGroup.find(([hash,_])=> encodeHashToBase64(hash) ===groupHash)
        if (maybeAccountabilities) {
          accountabilities = maybeAccountabilities[1]
          this._myAccountabilities = accountabilities
        }
      }
    }
    let amIPrivieged = false
    for (const acc of accountabilities) {
      if (acc.role.name === 'Steward' || acc.role.name === 'Progenitor') {
        amIPrivieged = true;
      }
    }
    if (!amIPrivieged) {
      this.notifyError(
        'Only group Stewards are allowed to create shared rooms.'
      );
      throw new Error(
        'Only group Stewards are allowed to create shared rooms.'
      );
    }
  }

  async updateRoomLists(): Promise<CellTypes> {
    // Get all personal rooms
    const appInfo = await this.client.appInfo();
    if (!appInfo) throw new Error('AppInfo is null');

    const cellTypes = getCellTypes(appInfo);

    this._personalRooms = cellTypes.cloned.filter(cell =>
      cell.dna_modifiers.network_seed.startsWith('privateRoom#')
    );

    const allDescendentRooms =
      await this._mainRoomStore!.client.getAllDescendentRooms();
    this._groupRooms = allDescendentRooms.map(
      ([room, creator, linkActionHash]) => ({ room, creator, linkActionHash })
    );

    return cellTypes;
  }

  async createPrivateRoom() {
    if (this._pageView !== PageView.Home) return;
    this._creatingRoom = true;
    try {
      const roomNameInput = this.shadowRoot?.getElementById(
        'private-room-name-input'
      ) as HTMLInputElement | null | undefined;
      if (!roomNameInput)
        throw new Error('Room name input field not found in DOM.');
      if (roomNameInput.value === '' || !roomNameInput.value) {
        this.notifyError('Room name must not be empty.');
        return;
      }
      const randomWords = generateSillyPassword({ wordCount: 5 });
      const clonedCell = await this._weaveClient.createCloneCell(
        {
          role_name: 'presence',
          modifiers: {
            network_seed: `privateRoom#${randomWords}`,
          },
        },
        false // This is a private clone
      );
      // Get AppInfo to update cachedAppInfo in AppClient (this should be fixed either with
      // a workaround in Moss or in the js-client)
      await this.client.appInfo();
      const roomClient = new RoomClient(this.client, clonedCell.clone_id);
      await roomClient.setRoomInfo({
        name: roomNameInput.value,
        icon_src: undefined,
        meta_data: undefined,
      });
      await this.updateRoomLists();
      roomNameInput.value = '';
      this._creatingRoom = false;
    } catch (e) {
      this._creatingRoom = false;
      throw e;
    }
  }

  async createGroupRoom() {
    this._creatingRoom = true;
    try {
      await this.checkPermission();
      if (this._pageView !== PageView.Home) return;
      const roomNameInput = this.shadowRoot?.getElementById(
        'group-room-name-input'
      ) as HTMLInputElement | null | undefined;
      if (!roomNameInput)
        if (!roomNameInput)
          throw new Error('Group room name input field not found in DOM.');
      if (roomNameInput.value === '') {
        this.notifyError('Error: Room name input field must not be empty.');
        throw new Error('Room name must not be empty.');
      }

      if (!this._provisionedCell)
        throw new Error('Provisioned cell not defined.');
      if (!this._mainRoomStore)
        throw new Error('Main Room Store is not defined.');
      // network seed is composed of
      const uuid = uuidv4();
      const appletNetworkSeed =
        this._provisionedCell.dna_modifiers.network_seed;
      const networkSeed = groupRoomNetworkSeed(appletNetworkSeed, uuid);
      const clonedCell = await this._weaveClient.createCloneCell(
        {
          role_name: 'presence',
          modifiers: {
            network_seed: networkSeed,
          },
          name: roomNameInput.value,
        },
        true // This is a public clone
      );

      // Get AppInfo to update cachedAppInfo in AppClient (this should be fixed either with
      // a workaround in Moss or in the js-client)
      await this.client.appInfo();

      // register it in the main room
      const descendentRoom = {
        network_seed_appendix: uuid,
        dna_hash: clonedCell.cell_id[0],
        name: roomNameInput.value,
        icon_src: undefined,
        meta_data: undefined,
      };
      const linkActionHash =
        await this._mainRoomStore.client.createDescendentRoom(descendentRoom);

      const roomClient = new RoomClient(this.client, clonedCell.clone_id);
      await roomClient.setRoomInfo({
        name: roomNameInput.value,
        icon_src: undefined,
        meta_data: undefined,
      });

      roomNameInput.value = '';

      const groupRoomInfo: GroupRoomInfo = {
        room: descendentRoom,
        creator: clonedCell.cell_id[1],
        linkActionHash,
      };
      this._groupRooms = [...this._groupRooms, groupRoomInfo];
      this._creatingRoom = false;
    } catch (e) {
      this._creatingRoom = false;
      throw e;
    }
  }

  async joinRoom() {
    if (this._pageView !== PageView.Home) return;
    const secretWordsInput = this.shadowRoot?.getElementById(
      'secret-words-input'
    ) as HTMLInputElement | null | undefined;
    if (!secretWordsInput)
      throw new Error('Secret words input field not found in DOM.');
    if (secretWordsInput.value === '') {
      this.notifyError('Error: Secret words must not be empty.');
      throw new Error('Secret words must not be empty.');
    }
    const clonedCell = await this._weaveClient.createCloneCell(
      {
        role_name: 'presence',
        modifiers: {
          network_seed: `privateRoom#${secretWordsInput.value}`,
        },
      },
      false // This is a private clone
    );
    // Get AppInfo to update cachedAppInfo in AppClient (this should be fixed either with
    // a workaround in Moss or in the js-client)
    await this.client.appInfo();
    this._personalRooms = [clonedCell, ...this._personalRooms];
    secretWordsInput.value = '';
  }

  renderPrivateRooms() {
    return html`
      <div
        class="column"
        style="flex-wrap: wrap; justify-content: center; align-items: center; margin-top: 30px;"
      >
        ${this._showCreateForm
          ? html`<div
              class="column"
              style="margin: 0 10px; align-items: flex-start; color: #e1e5fc;"
            >
              <div class="secondary-font" style="margin-left: 5px;">
                ${msg('+ Create New Private Room')}
              </div>
              <div class="row" style="align-items: center;">
                <input
                  id="private-room-name-input"
                  class="input-field"
                  placeholder="room name"
                  type="text"
                />
                <button
                  class="btn"
                  style="margin-left: 10px;"
                  ?disabled=${this._creatingRoom}
                  @click=${async () => this.createPrivateRoom()}
                >
                  ${this._creatingRoom ? msg('...') : msg('Create')}
                </button>
              </div>
            </div>
            <div
              class="column"
              style="margin: 0 10px; align-items: flex-start; color: #e1e5fc; margin-top: 12px;"
            >
              <div class="row" style="align-items: center;">
                <sl-icon
                  .src=${wrapPathInSvg(mdiLockOpenOutline)}
                  style="margin-right: 3px; margin-bottom: 4px; margin-left: 5px;"
                ></sl-icon>
                <div class="secondary-font">${msg('Join Private Room')}</div>
              </div>
              <div class="row" style="align-items: center;">
                <input
                  id="secret-words-input"
                  class="input-field"
                  placeholder="secret words"
                  type="text"
                />
                <button
                  class="btn"
                  style="margin-left: 10px;"
                  @click=${async () => this.joinRoom()}
                >
                  ${msg('Join')}
                </button>
              </div>
            </div>`
          : html`<button
              class="create-toggle-btn"
              @click=${() => { this._showCreateForm = true; }}
            >
              ${msg('+ Create or Join Private Room')}
            </button>`}
      </div>
      <div
        class="column"
        style="margin-top: 40px; align-items: stretch; margin-bottom: 80px; width: 100%; box-sizing: border-box; padding: 0 16px;"
      >
        ${repeat(
          this._personalRooms.sort((cell_a, cell_b) =>
            encodeHashToBase64(cell_b.cell_id[0]).localeCompare(
              encodeHashToBase64(cell_a.cell_id[0])
            )
          ),
          clonedCell => clonedCell.clone_id,
          clonedCell => html`
            <private-room-card
              .clonedCell=${clonedCell}
              @request-open-room=${async (e: CustomEvent) => {
                try {
                  await (this._weaveClient as any).openAsset(
                    {
                      hrl: [clonedCell.cell_id[0], NULL_HASH],
                    },
                    'window'
                  );
                } catch (err) {
                  console.warn('Failed to open room in external window: ', err);
                  this._selectedRoleName = clonedCell.clone_id;
                  await this._enterRoom(encodeHashToBase64(clonedCell.cell_id[0]));
                }
              }}
              style="margin: 7px 0;"
            ></private-room-card>
          `
        )}
      </div>
      <span style="display: flex; flex: 1;"></span>
    `;
  }

  renderSharedRoomCards(groupRooms: GroupRoomInfo[]) {
    if (this._refreshing)
      return html`<span style="margin-top: 50px;"
        >Refreshing...<span></span
      ></span>`;
    return repeat(
      groupRooms.sort((info_a, info_b) =>
        info_a.room.name.localeCompare(info_b.room.name)
      ),
      roomInfo => encodeHashToBase64(roomInfo.linkActionHash),
      roomInfo => html`
        <shared-room-card
          .groupRoomInfo=${roomInfo}
          @request-open-room=${async (e: { detail: ClonedCell }) => {
            try {
              await (this._weaveClient as any).openAsset(
                {
                  hrl: [e.detail.cell_id[0], NULL_HASH],
                },
                'window'
              );
            } catch (err) {
              console.warn('Failed to open room in external window: ', err);
              this._selectedRoleName = e.detail.clone_id;
              await this._enterRoom(encodeHashToBase64(e.detail.cell_id[0]));
            }
          }}
          style="margin: 7px 0;"
        ></shared-room-card>
      `
    );
  }

  renderGroupRooms() {
    return html`
      <div
        class="row"
        style="flex-wrap: wrap; justify-content: center; align-items: center; margin-top: 30px;"
      >
        ${this._showCreateForm
          ? html`<div
              class="column"
              style="margin: 0 10px; align-items: flex-start; color: #e1e5fc;"
            >
              <div class="secondary-font" style="margin-left: 5px;">
                ${msg('+ Create New Shared Room')}
              </div>
              <div class="row" style="align-items: center;">
                <input
                  id="group-room-name-input"
                  class="input-field"
                  placeholder="room name"
                  type="text"
                />
                <button
                  class="btn"
                  style="margin-left: 10px;"
                  ?disabled=${this._creatingRoom}
                  @click=${async () => this.createGroupRoom()}
                >
                  ${this._creatingRoom ? msg('...') : msg('Create')}
                </button>
              </div>
            </div>`
          : html`<button
              class="create-toggle-btn"
              @click=${() => { this._showCreateForm = true; }}
            >
              ${msg('+ Create New Shared Room')}
            </button>`}
      </div>
      <div
        class="column"
        style="margin-top: 40px; align-items: stretch; margin-bottom: 80px; width: 100%; box-sizing: border-box; padding: 0 16px;"
      >
        ${this._provisionedCell
          ? html`<shared-room-card
              .isMainRoom=${true}
              .mainRoomCellId=${this._provisionedCell.cell_id}
              .mainRoomParticipants=${this._activeMainRoomParticipants.map(
                info => info.pubkey
              )}
              @request-open-room=${async () => {
                try {
                  await (this._weaveClient as any).openAsset(
                    {
                      hrl: [this._provisionedCell!.cell_id[0], NULL_HASH],
                    },
                    'window'
                  );
                } catch (err) {
                  console.warn(
                    'Failed to open main room in external window: ',
                    err
                  );
                  this._selectedRoleName = 'presence';
                  await this._enterRoom(
                    encodeHashToBase64(this._provisionedCell!.cell_id[0])
                  );
                }
              }}
              style="margin: 7px 0;"
            ></shared-room-card>`
          : ''}
        ${this.renderSharedRoomCards(this._groupRooms)}
      </div>
      <span style="display: flex; flex: 1;"></span>
    `;
  }

  renderSettingsPanel() {
    return html`
      <div class="settings-panel">
        <div class="row" style="justify-content: space-between; align-items: center; margin-bottom: 12px;">
          <span class="secondary-font" style="color: #c3c9eb; font-size: 20px;">Settings</span>
          <sl-icon
            .src=${wrapPathInSvg(mdiClose)}
            class="settings-close-btn"
            @click=${() => { this._showSettings = false; }}
          ></sl-icon>
        </div>
        <div class="row items-center">
          <toggle-switch
            class="toggle-switch ${this._trickleICE ? 'active' : ''}"
            .toggleState=${this._trickleICE}
            @toggle-on=${() => {
              this._trickleICE = true;
              window.localStorage.setItem('trickleICE', 'true');
            }}
            @toggle-off=${() => {
              this._trickleICE = false;
              window.localStorage.setItem('trickleICE', 'false');
            }}
          ></toggle-switch>
          <span
            class="secondary-font"
            style="color: #c3c9eb; margin-left: 10px; font-size: 18px;"
            >trickle ICE (ON by default)</span
          >
        </div>
        <div style="margin-top: 16px; width: 100%;">
          <span
            class="secondary-font"
            style="color: #c3c9eb; font-size: 18px;"
            >TURN Server</span
          >
          <div style="margin-top: 6px;">
            <input
              type="text"
              placeholder="turn:host:port"
              .value=${this._turnUrl}
              @input=${(e: InputEvent) => {
                const val = (e.target as HTMLInputElement).value;
                this._turnUrl = val;
                window.localStorage.setItem('turnUrl', val);
              }}
              style="width: 100%; box-sizing: border-box; padding: 6px 10px; background: #2a2f4e; color: #c3c9eb; border: 1px solid #444a6e; border-radius: 4px; font-size: 14px; margin-bottom: 6px;"
            />
            <input
              type="text"
              placeholder="Username"
              .value=${this._turnUsername}
              @input=${(e: InputEvent) => {
                const val = (e.target as HTMLInputElement).value;
                this._turnUsername = val;
                window.localStorage.setItem('turnUsername', val);
              }}
              style="width: 100%; box-sizing: border-box; padding: 6px 10px; background: #2a2f4e; color: #c3c9eb; border: 1px solid #444a6e; border-radius: 4px; font-size: 14px; margin-bottom: 6px;"
            />
            <input
              type="password"
              placeholder="Credential"
              .value=${this._turnCredential}
              @input=${(e: InputEvent) => {
                const val = (e.target as HTMLInputElement).value;
                this._turnCredential = val;
                window.localStorage.setItem('turnCredential', val);
              }}
              style="width: 100%; box-sizing: border-box; padding: 6px 10px; background: #2a2f4e; color: #c3c9eb; border: 1px solid #444a6e; border-radius: 4px; font-size: 14px;"
            />
          </div>
        </div>
        <div class="row" style="margin-top: 20px; gap: 10px;">
          <button
            class="btn"
            style="width: auto; padding: 5px 12px; font-size: 16px;"
            @click=${() => {
              downloadJson(
                `Presence_${__APP_VERSION__}_logs_${formattedDate()}.json`,
                JSON.stringify(exportLogs(), undefined, 2)
              );
            }}
          >
            Export Logs
          </button>
          <button
            class="btn btn-danger"
            style="width: auto; padding: 5px 12px; font-size: 16px;"
            @click=${() => {
              clearAllLogs();
              this._logCleared = true;
              setTimeout(() => { this._logCleared = false; }, 2000);
            }}
          >
            ${this._logCleared ? 'Cleared' : 'Clear Logs'}
          </button>
        </div>
        <div style="margin-top: 16px; border-top: 1px solid #444a6e; padding-top: 12px;">
          <button
            class="create-toggle-btn"
            style="font-size: 14px; padding: 4px 14px;"
            @click=${() => { this._showAdvancedSettings = !this._showAdvancedSettings; }}
          >
            ${this._showAdvancedSettings ? msg('Hide Advanced') : msg('Advanced Settings')}
          </button>
          ${this._showAdvancedSettings ? html`
            <div style="margin-top: 12px; width: 100%;">
              <span
                class="secondary-font"
                style="color: #c3c9eb; font-size: 18px;"
                >Signal Delay (ms)</span
              >
              <div style="margin-top: 6px;">
                <input
                  type="number"
                  min="0"
                  step="100"
                  placeholder="0"
                  .value=${String(this._signalDelayMs)}
                  @input=${(e: InputEvent) => {
                    const val = parseInt((e.target as HTMLInputElement).value, 10);
                    const ms = isNaN(val) ? 0 : Math.max(0, val);
                    this._signalDelayMs = ms;
                    window.localStorage.setItem('signalDelayMs', String(ms));
                  }}
                  style="width: 100%; box-sizing: border-box; padding: 6px 10px; background: #2a2f4e; color: #c3c9eb; border: 1px solid #444a6e; border-radius: 4px; font-size: 14px;"
                />
                <span
                  class="secondary-font"
                  style="color: #888ea8; font-size: 12px; margin-top: 4px; display: block;"
                  >Random 0-N ms delay per signal. For testing only.</span
                >
              </div>
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }

  render() {
    switch (this._pageView) {
      case PageView.Loading:
        return html`<div
          class="column center-content"
          style="color: #c8ddf9; height: 100vh;"
        >
          <img src="icon.png" alt="presence logo" class="entry-logo-img" />
          <div class="entry-logo">presence</div>
          <!-- <div>...and see the bigger picture</div> -->
          <div style="position: absolute; bottom: 20px;">loading...</div>
        </div>`;
      case PageView.Home:
        return html`
          <div
            class="error-message secondary-font"
            style="${this._displayError ? '' : 'display: none;'}"
          >
            ${this._displayError}
          </div>
          <div class="home-scroll">
          <div
            class="column home-content"
            style="align-items: center; display: flex; flex: 1; width: 100%; min-width: 240px;"
          >
            <span
              style="position: fixed; bottom: 0; left: 5px; color: #c8ddf9; font-size: 16px;"
              >${__APP_VERSION__}</span
            >
            <div class="top-bar">
              <div class="row" style="align-items: center; gap: 12px;">
                <img src="icon.png" alt="presence logo" class="header-logo" />
                <span class="header-title">presence</span>
              </div>
              <sl-icon
                .src=${wrapPathInSvg(mdiCog)}
                class="header-cog"
                @click=${() => { this._showSettings = true; }}
              ></sl-icon>
              ${this._showSettings ? this.renderSettingsPanel() : ''}
            </div>
            <div class="column bottom-panel">
              <button
                class="refresh-btn"
                @click=${async () => {
                  this._refreshing = true;
                  await this.updateRoomLists();
                  setTimeout(() => {
                    this._refreshing = false;
                  }, 200);
                }}
              >
                <div class="row center-content">
                  <sl-icon .src=${wrapPathInSvg(mdiRefresh)}></sl-icon>
                  <span style="margin-left: 2px;"> ${msg('refresh')}</span>
                </div>
              </button>
              <div
                class="row center-content"
                style="border-radius: 15px; margin-top: 48px;"
              >
                <div
                  tabindex="0"
                  class="row center-content slider-button ${this._showGroupRooms
                    ? 'btn-selected'
                    : ''}"
                  @click=${() => {
                    this._showGroupRooms = true;
                    this._showCreateForm = false;
                  }}
                  @keypress=${(e: KeyboardEvent) => {
                    if (e.key === 'Enter') {
                      this._showGroupRooms = true;
                      this._showCreateForm = false;
                    }
                  }}
                >
                  <sl-icon
                    .src=${wrapPathInSvg(mdiAccountGroup)}
                    class="slider-icon"
                  ></sl-icon>
                  <div style="margin-bottom: -6px;">${msg('Shared Rooms')}</div>
                </div>
                <div
                  tabindex="0"
                  class="row center-content slider-button ${this._showGroupRooms
                    ? ''
                    : 'btn-selected'}"
                  style="border-radius: 3px 25px 25px 3px;"
                  @click=${() => {
                    this._showGroupRooms = false;
                    this._showCreateForm = false;
                  }}
                  @keypress=${(e: KeyboardEvent) => {
                    if (e.key === 'Enter') {
                      this._showGroupRooms = false;
                      this._showCreateForm = false;
                    }
                  }}
                >
                  <sl-icon
                    .src=${wrapPathInSvg(mdiLock)}
                    class="slider-icon"
                  ></sl-icon>
                  <div style="margin-bottom: -6px;">
                    ${msg('Private Rooms')}
                  </div>
                </div>
              </div>
              ${this._showGroupRooms
                ? this.renderGroupRooms()
                : this.renderPrivateRooms()}
            </div>
          </div>
          </div>
        `;
      case PageView.Room:
        if (!this._weaveClient) return html`loading...`;
        if (this._roomAlreadyOpen) {
          return html`
            <div class="room-already-open secondary-font">
              <div class="room-already-open-card">
                <div style="font-size: 28px; margin-bottom: 16px;">
                  ${msg('This room is already open in another window.')}
                </div>
                <div style="font-size: 18px; opacity: 0.85; margin-bottom: 24px;">
                  ${msg(
                    'A presence room can only be open in one place at a time.'
                  )}
                </div>
                <div class="row" style="gap: 14px; justify-content: center; flex-wrap: wrap;">
                  <button
                    class="enter-main-room-btn"
                    ?disabled=${this._takingOver || !this._currentRoomDnaB64}
                    @click=${async () => {
                      if (!this._currentRoomDnaB64) return;
                      this._takingOver = true;
                      try {
                        const ok = await this._takeOverRoom(
                          this._currentRoomDnaB64
                        );
                        if (ok) {
                          await this._enterRoom(this._currentRoomDnaB64, {
                            waitMs: 3000,
                          });
                        } else {
                          this.notifyError(
                            msg(
                              'The other window did not respond. Close it manually and try again.'
                            )
                          );
                        }
                      } finally {
                        this._takingOver = false;
                      }
                    }}
                  >
                    ${this._takingOver
                      ? msg('Moving…')
                      : msg('Use it here instead')}
                  </button>
                  ${this.externalWindow
                    ? html`<button
                        class="enter-main-room-btn"
                        @click=${async () => {
                          this._releaseRoomLock();
                          try {
                            await this._weaveClient.requestClose();
                          } catch (e) {
                            console.warn('requestClose failed', e);
                          }
                          this._pageView = PageView.EnterRoom;
                        }}
                      >
                        ${msg('Close this window')}
                      </button>`
                    : html`<button
                        class="enter-main-room-btn"
                        @click=${() => {
                          this._releaseRoomLock();
                          this._pageView = PageView.Home;
                        }}
                      >
                        ${msg('Back')}
                      </button>`}
                </div>
              </div>
            </div>
          `;
        }
        return html`
          <room-container
            class="room-container"
            .roleName=${this._selectedRoleName}
            .wal=${this._selectedWal}
            @quit-room=${async () => {
              this._releaseRoomLock();
              if (this.externalWindow) {
                console.log('Closing window.');
                try {
                  await this._weaveClient.requestClose();
                } catch (e) {
                  console.warn('requestClose failed', e);
                }
                this._pageView = PageView.EnterRoom;
              } else {
                this._pageView = PageView.Home;
              }
            }}
          ></room-container>
        `;
      case PageView.EnterRoom:
        return html`
          <div class="room-already-open secondary-font">
            <div class="room-already-open-card">
              <div style="font-size: 28px; margin-bottom: 16px;">
                ${this._currentRoomName ?? msg('this room')}
              </div>
              <div style="font-size: 18px; opacity: 0.85; margin-bottom: 24px;">
                ${msg('Enter this room to join.')}
              </div>
              <button
                class="enter-main-room-btn"
                ?disabled=${!this._currentRoomDnaB64}
                @click=${async () => {
                  if (this._currentRoomDnaB64) {
                    await this._enterRoom(this._currentRoomDnaB64);
                  }
                }}
              >
                ${msg('Enter')}
              </button>
            </div>
          </div>
        `;
      default:
        return PageView.Home;
    }
  }

  static styles = [
    sharedStyles,
    css`
      :host {
        /* Definite height (not min-height) so .home-scroll's flex:1 is
           bounded and scrolls internally instead of growing the host and
           making the document scroll. width:100% (never 100vw) so the host
           tracks the body's content box -- 100vw would include the vertical
           scrollbar gutter and push a document-level horizontal scrollbar. */
        height: 100vh;
        width: 100%;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: flex-start;
        font-size: calc(10px + 2vmin);
        color: #102a4d;
        margin: 0;
        padding: 0;
        text-align: center;
        background: #2b304a;
        /* background: #383b4d; */
        font-family: 'Pacifico', sans-serif;
        font-size: 30px;
      }

      .error-message {
        position: fixed;
        bottom: 10px;
        right: 10px;
        padding: 5px 10px;
        border-radius: 10px;
        color: #f8c7c7;
        background: linear-gradient(#8b1616, #8b1616 30%, #6e0a0a);
        /* background: #7b0e0e; */
        box-shadow: 0 0 3px 1px #721c1c;
      }

      .entry-logo-img {
        height: 140px;
        width: 140px;
        border-radius: 50%;
        margin-bottom: 10px;
      }

      .entry-logo {
        font-size: 100px;
        font-family: 'Pacifico' sans-serif;
      }

      h2 {
        font-weight: normal;
      }

      .top-bar {
        background: linear-gradient(#a1aad9, #7780af);
        display: flex;
        align-items: center;
        justify-content: space-between;
        height: 56px;
        padding: 0 16px;
        margin: 0;
        width: 100%;
        box-sizing: border-box;
        position: relative;
        box-shadow: 0 0 30px 6px #1e2137;
      }

      .header-logo {
        height: 40px;
        width: 40px;
        border-radius: 50%;
      }

      .header-title {
        font-family: 'Pacifico', sans-serif;
        font-size: 30px;
        color: #0a1c35;
        line-height: 1;
        /* Pacifico's tall ascenders bias the glyphs above the line-box
           center; nudge down to optically center against the logo. */
        transform: translateY(-3px);
      }

      .header-cog {
        font-size: 24px;
        cursor: pointer;
        color: #0a1c35;
        opacity: 0.8;
      }

      .header-cog:hover {
        opacity: 1;
      }

      .bottom-panel {
        width: 100%;
        position: relative;
        align-items: center;
        color: #bbc4f2;
        /* Query container so the toggle scales to the available width (cqi),
           not the viewport (vw). Container units shrink when a vertical
           scrollbar appears, so the toggle never forces a horizontal one. */
        container-type: inline-size;
      }

      /* Landing page scrolls inside this container. The two axes are
         independent: a horizontal bar appears only when the pane is
         narrower than .home-content's min-width, a vertical bar only when
         the rooms are taller than the pane.

         scrollbar-gutter: stable is the key: a classic vertical scrollbar
         consumes ~15px of width when it appears, which momentarily makes
         the content "too wide" and triggers a horizontal bar -- which then
         steals height, keeping the vertical bar, locking both on. Reserving
         the gutter at all times means the content width never changes when
         the vertical bar appears, so there is nothing to trigger the
         horizontal one. min-height: 0 keeps the vertical overflow inside
         this box rather than growing the host. */
      .home-scroll {
        flex: 1;
        min-height: 0;
        width: 100%;
        overflow: auto;
        scrollbar-gutter: stable;
      }

      .enter-main-room-btn {
        background: linear-gradient(#2a4a8f, #1a3060);
        border-radius: 40px;
        color: #ffffff;
        border: none;
        padding: 10px 15px;
        padding-right: 25px;
        font-family: 'Pacifico', sans-serif;
        font-size: 35px;
        box-shadow: 0 0 25px 6px rgba(100, 140, 255, 0.3), 1px 1px 4px 2px #03162f;
        cursor: pointer;
      }

      .enter-main-room-btn:hover {
        background: linear-gradient(#3558a0, #1f3870);
        box-shadow: 0 0 30px 8px rgba(100, 140, 255, 0.4), 1px 1px 4px 2px #03162f;
      }

      .enter-main-room-btn:focus-visible {
        background: linear-gradient(#3558a0, #1f3870);
        box-shadow: 0 0 30px 8px rgba(100, 140, 255, 0.4), 1px 1px 4px 2px #03162f;
      }

      .blue-dark {
        color: #0a1c35;
      }

      .create-toggle-btn {
        background: none;
        border: 1px solid #5a6199;
        border-radius: 20px;
        color: #9da3d0;
        padding: 8px 20px;
        font-size: 17px;
        cursor: pointer;
        font-family: 'Baloo 2 Variable', sans-serif;
        font-weight: 600;
        transition: background 0.2s, color 0.2s;
      }

      .create-toggle-btn:hover {
        background: #5a619930;
        color: #c0c5ee;
      }

      .slider-button {
        align-items: center;
        /* background: #383b4d; */
        /* background: #2f3141; */
        background: linear-gradient(#1b1f35, #282b42 30%, #282b42);
        color: #e1e5fc;
        height: 54px;
        border-radius: 25px 3px 3px 25px;
        padding: 2px clamp(6px, 2cqi, 15px);
        box-shadow: 0 0 4px 2px black inset;
        cursor: pointer;
        font-family: 'Baloo 2 Variable', sans-serif;
        font-weight: 600;
        font-size: clamp(11px, 4.5cqi, 26px);
        white-space: nowrap;
      }

      .slider-icon {
        font-size: clamp(13px, 5cqi, 30px);
        margin-right: 5px;
      }

      .slider-button:hover:not(.btn-selected) {
        background: linear-gradient(#4d547a52, #7b82ad52 30%, #7981ad52);
        /* background: #8b90ae52; */
        /* color: #383b4d; */
      }

      .slider-button:focus:not(.btn-selected) {
        background: linear-gradient(#4d547a52, #7b82ad52 30%, #7981ad52);
        /* background: #8b90ae52; */
        /* color: #383b4d; */
      }

      .btn-selected {
        /* background: #b1bbee; */
        /* background: #afb6da; */
        /* background: linear-gradient(#cdd3ec, #afb6da 30%, #afb6da, #929bca); */
        background: linear-gradient(#c2cae8, #a5add8 30%, #a5add8, #8994c7);
        /* background: linear-gradient(#aeb8e5, #96a1d4 30%, #96a1d4, #7a86c3); */
        /* background: linear-gradient(#b3bce4, #9ca6d4 30%, #9ca6d4, #838ec5); */
        color: #1d1f2c;
        padding: 0 15px;
        box-shadow: 0 0 6px 2px black;
      }

      .input-field {
        height: 40px;
        border-radius: 10px;
        border: none;
        font-size: 18px;
        padding-left: 8px;
        min-width: 350px;
        box-shadow: 0 0 2px 1px #1c1e2e inset;
        background: linear-gradient(#eaecf3, #eaecf3 20%, #ffffff);
      }

      .refresh-btn {
        background: transparent;
        color: #e1e5fc;
        font-size: 1.2rem;
        position: absolute;
        top: 20px;
        right: 20px;
        border: none;
        font-weight: 600;
        font-family: 'Baloo 2 Variable', sans-serif;
        cursor: pointer;
      }

      .refresh-btn:active {
        color: #ffffff;
      }

      .btn {
        /* background: linear-gradient(#cdd3ec, #afb6da 30%, #1b1d24, #929bca); */
        background: linear-gradient(#c2cae8, #a5add8 30%, #a5add8, #8994c7);
        /* background: linear-gradient(#aeb8e5, #96a1d4 30%, #96a1d4, #7a86c3); */
        /* background: linear-gradient(#b3bce4, #9ca6d4 30%, #9ca6d4, #838ec5); */
        box-shadow: 0 0 5px 1px #1d1d1d;
        /* background: #bbc4f2; */
        border-radius: 10px;
        color: #081c36;
        border: none;
        padding: 5px 5px;
        /* font-family: 'Pacifico', sans-serif; */
        font-family: 'Baloo 2 Variable', sans-serif;
        font-weight: 600;
        font-size: 20px;
        width: 80px;
        cursor: pointer;
      }

      .btn:hover {
        background: linear-gradient(#e9ecf9, #c8cee8 30%, #c8cee8, #929bca);
      }

      .btn:focus {
        background: #ffffff;
      }

      .btn-danger {
        background: linear-gradient(#5a2a2a, #3a1a1a);
        color: #f8c7c7;
        cursor: pointer;
      }

      .btn-danger:hover {
        background: linear-gradient(#7a3a3a, #5a2a2a);
      }

      .settings-panel {
        position: absolute;
        top: 0;
        right: 0;
        z-index: 100;
        background: #1b1f35;
        border: 1px solid #444a6e;
        border-radius: 0 0 0 8px;
        padding: 16px;
        width: 320px;
        text-align: left;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
        font-family: 'Baloo 2 Variable', sans-serif;
        font-size: 16px;
      }

      .settings-close-btn {
        font-size: 22px;
        cursor: pointer;
        color: #888ea8;
        transition: color 0.15s;
      }

      .settings-close-btn:hover {
        color: #c3c9eb;
      }

      .room-already-open {
        display: flex;
        flex: 1;
        align-items: center;
        justify-content: center;
        width: 100vw;
        min-height: 100vh;
        color: #e1e5fc;
        padding: 20px;
        box-sizing: border-box;
      }

      .room-already-open-card {
        background: linear-gradient(#1a3060, #102a4d);
        border-radius: 25px;
        padding: 40px 50px;
        max-width: 560px;
        text-align: center;
        box-shadow: 1px 1px 8px 2px #020b16b8;
      }

      .room-container {
        display: flex;
        flex: 1;
        /* presence-app centres its children (align-items:center), so stretch
           this one to the full content-box width (never 100vw — that includes
           the scrollbar gutter) and let room-view fill it. */
        width: 100%;
        min-width: 0;
        margin: 0;
      }
    `,
  ];
}
