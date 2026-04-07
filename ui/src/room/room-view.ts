/* eslint-disable no-console */
import { LitElement, css, html } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import {
  encodeHashToBase64,
  AgentPubKeyB64,
  decodeHashFromBase64,
  EntryHash,
} from '@holochain/client';

import { AsyncStatus, StoreSubscriber } from '@holochain-open-dev/stores';
import {
  mdiAccount,
  mdiAccountOff,
  mdiChartLine,
  mdiChevronUp,
  mdiClose,
  mdiFullscreen,
  mdiFullscreenExit,
  mdiLock,
  mdiMicrophone,
  mdiMicrophoneOff,
  mdiMinus,
  mdiMonitorScreenshot,
  mdiNoteEditOutline,
  mdiCubeOutline,
  mdiPaperclip,
  mdiPencilCircleOutline,
  mdiPhoneRefresh,
  mdiHub,
  mdiDownload,
  mdiCloudDownloadOutline,
  mdiVideo,
  mdiVideoOff,
} from '@mdi/js';
import { wrapPathInSvg } from '@holochain-open-dev/elements';
import { localized, msg } from '@lit/localize';
import { consume } from '@lit/context';
import { repeat } from 'lit/directives/repeat.js';

import '@shoelace-style/shoelace/dist/components/icon/icon.js';
import '@shoelace-style/shoelace/dist/components/icon-button/icon-button.js';
import '@shoelace-style/shoelace/dist/components/tooltip/tooltip.js';
import '@shoelace-style/shoelace/dist/components/dropdown/dropdown.js';
import '@shoelace-style/shoelace/dist/components/menu/menu.js';
import '@shoelace-style/shoelace/dist/components/menu-item/menu-item.js';
import { AssetStoreContent, WAL, weaveUrlFromWal, WeaveClient } from '@theweave/api';
import './elements/shared-wal-embed';

import { roomStoreContext, streamsStoreContext } from '../contexts';
import { sharedStyles } from '../sharedStyles';
import './elements/avatar-with-nickname';
import { RoomInfo, SharedWalPayload, StreamAndTrackInfo, weaveClientContext } from '../types';
import { RoomStore } from './room-store';
import './elements/attachment-element';
import './elements/agent-connection-status';
import './elements/agent-connection-status-icon';
import './elements/toggle-switch';
import './logs-graph';
import { downloadJson, formattedDate, sortConnectionStatuses } from '../utils';
import { PING_INTERVAL, StreamsStore } from '../streams-store';
import { AgentInfo, ConnectionStatuses, ModuleStateEnvelope } from '../types';
import { exportLogs } from '../logging';
import { getAllModules, getModule } from './modules/registry';
import type { ModuleIconDefinition, ModuleRenderContext } from './modules/types';
import './modules'; // side-effect: registers all modules

declare const __APP_VERSION__: string;

@localized()
@customElement('room-view')
export class RoomView extends LitElement {
  @consume({ context: roomStoreContext, subscribe: true })
  @state()
  roomStore!: RoomStore;

  @consume({ context: streamsStoreContext, subscribe: true })
  @state()
  streamsStore!: StreamsStore;

  @consume({ context: weaveClientContext })
  @state()
  _weaveClient!: WeaveClient;

  @property()
  wal!: WAL;

  @property({ type: Boolean })
  private = false;

  @query('#custom-log-textarea')
  _customLogTextarea!: HTMLInputElement;

  @query('#log-timestamp-checkbox')
  _logTimestampCheckbox!: HTMLInputElement;

  @state()
  pingInterval: number | undefined;

  @state()
  assetStoreContent: AsyncStatus<AssetStoreContent> | undefined;

  _customLogTimestamp: number | undefined;

  _allAgentsFromAnchor = new StoreSubscriber(
    this,
    () => this.roomStore.allAgents,
    () => [this.roomStore]
  );

  @state()
  _roomInfo: RoomInfo | undefined;

  _knownAgents = new StoreSubscriber(
    this,
    () => this.streamsStore._knownAgents,
    () => [this.streamsStore]
  );

  _connectionStatuses = new StoreSubscriber(
    this,
    () => this.streamsStore._connectionStatuses,
    () => [this.streamsStore]
  );

  _screenShareConnectionStatuses = new StoreSubscriber(
    this,
    () => this.streamsStore._screenShareConnectionStatuses,
    () => [this.streamsStore]
  );

  _othersConnectionStatuses = new StoreSubscriber(
    this,
    () => this.streamsStore._othersConnectionStatuses,
    () => [this.streamsStore]
  );

  _openConnections = new StoreSubscriber(
    this,
    () => this.streamsStore._openConnections,
    () => [this.streamsStore]
  );

  _receivedDiagnosticLogs = new StoreSubscriber(
    this,
    () => this.streamsStore._receivedDiagnosticLogs,
    () => [this.streamsStore]
  );

  _screenShareConnectionsOutgoing = new StoreSubscriber(
    this,
    () => this.streamsStore._screenShareConnectionsOutgoing,
    () => [this.streamsStore]
  );

  _screenShareConnectionsIncoming = new StoreSubscriber(
    this,
    () => this.streamsStore._screenShareConnectionsIncoming,
    () => [this.streamsStore]
  );

  _mySharedWal = new StoreSubscriber(
    this,
    () => this.streamsStore._mySharedWal,
    () => [this.streamsStore]
  );

  _peerSharedWals = new StoreSubscriber(
    this,
    () => this.streamsStore._peerSharedWals,
    () => [this.streamsStore]
  );

  _myModuleStates = new StoreSubscriber(
    this,
    () => this.streamsStore._myModuleStates,
    () => [this.streamsStore]
  );

  _peerModuleStates = new StoreSubscriber(
    this,
    () => this.streamsStore._peerModuleStates,
    () => [this.streamsStore]
  );

  _receiverModuleOverrides = new StoreSubscriber(
    this,
    () => this.streamsStore._receiverModuleOverrides,
    () => [this.streamsStore]
  );

  _audioInputDevices = new StoreSubscriber(
    this,
    () => this.streamsStore.audioInputDevices(),
    () => [this.streamsStore]
  );

  _videoInputDevices = new StoreSubscriber(
    this,
    () => this.streamsStore.videoInputDevices(),
    () => [this.streamsStore]
  );

  _audioOutputDevices = new StoreSubscriber(
    this,
    () => this.streamsStore.audioOutputDevices(),
    () => [this.streamsStore]
  );

  _audioInputId = new StoreSubscriber(
    this,
    () => this.streamsStore.audioInputId(),
    () => [this.streamsStore]
  );

  _audioOutputId = new StoreSubscriber(
    this,
    () => this.streamsStore.audioOutputId(),
    () => [this.streamsStore]
  );

  _videoInputId = new StoreSubscriber(
    this,
    () => this.streamsStore.videoInputId(),
    () => [this.streamsStore]
  );

  @state()
  _microphone = false;

  @state()
  _camera = false;

  @state()
  _selfViewHidden = false;

  @state()
  _maximizedVideo: string | undefined; // id of the maximized video if any

  @state()
  _displayError: string | undefined;

  @state()
  _joinAudio = new Audio('doorbell.mp3');

  @state()
  _leaveAudio = new Audio('percussive-drum-hit.mp3');

  @state()
  _reconnectAudio = new Audio('old-phone-ring-connect.mp3#t=0,3.5');

  @state()
  _showAttachmentsPanel = false;

  @state()
  _showAudioSources = false;

  @state()
  _showVideoSources = false;

  @state()
  _showViewShapeOptions = false;

  @state()
  _circleView = true;

  @state()
  _panelMode: 'assets' | 'people' = 'assets';

  @state()
  _showConnectionDetails = false;

  @state()
  _splitRatio = 70;

  @state()
  _isResizing = false;

  @state()
  _logsGraphEnabled = true;

  @state()
  _logsGraphMinimized = false;

  @state()
  _logsGraphAgent: AgentPubKeyB64 | undefined;

  @state()
  _showCustomLogDialog = false;

  @state()
  _unsubscribe: (() => void) | undefined;

  // Module timer management for produceState intervals
  private _moduleTimers: Map<string, number> = new Map();

  private _startModuleTimer(moduleId: string) {
    const mod = getModule(moduleId);
    if (mod?.produceState && mod.stateInterval) {
      // Clear any existing timer first
      this._stopModuleTimer(moduleId);
      const timer = window.setInterval(() => {
        const payload = mod.produceState!();
        if (payload) {
          this.streamsStore.updateModuleState(moduleId, payload);
        }
      }, mod.stateInterval);
      this._moduleTimers.set(moduleId, timer);
    }
  }

  private _stopModuleTimer(moduleId: string) {
    const timer = this._moduleTimers.get(moduleId);
    if (timer !== undefined) {
      clearInterval(timer);
      this._moduleTimers.delete(moduleId);
    }
  }

  private _stopAllModuleTimers() {
    for (const [moduleId] of this._moduleTimers) {
      this._stopModuleTimer(moduleId);
    }
  }

  closeClosables = () => {
    if (this._showAttachmentsPanel) {
      this._showAttachmentsPanel = false;
    }
    if (this._showAudioSources) {
      this._showAudioSources = false;
    }
    if (this._showVideoSources) {
      this._showVideoSources = false;
    }
    if (this._showViewShapeOptions) {
      this._showViewShapeOptions = false;
    }
    if (this._showCustomLogDialog) {
      this.closeCustomLogDialog();
    }
  };

  closeCustomLogDialog() {
    this._showCustomLogDialog = false;
    this._customLogTimestamp = undefined;
    this._customLogTextarea.value = '';
    this._logTimestampCheckbox.checked = false;
  }

  sideClickListener = (e: MouseEvent) => {
    this.closeClosables();
  };

  keyDownListener = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      this.closeClosables();
    }
  };

  notifyError(msg: string) {
    this._displayError = msg;
    setTimeout(() => {
      this._displayError = undefined;
    }, 4000);
  }

  quitRoom() {
    this._stopAllModuleTimers();
    this.streamsStore.disconnect();
    this.streamsStore.logger.endSession();
    this.dispatchEvent(
      new CustomEvent('quit-room', { bubbles: true, composed: true })
    );
  }

  async firstUpdated() {
    this.addEventListener('click', this.sideClickListener);
    document.addEventListener('keydown', this.keyDownListener);
    this.streamsStore.onEvent(async event => {
      switch (event.type) {
        case 'error': {
          this.notifyError(event.error);
          break;
        }
        case 'my-audio-off': {
          this._microphone = false;
          break;
        }
        case 'my-audio-on': {
          this._microphone = true;
          break;
        }
        case 'my-video-on': {
          const myVideo = this.shadowRoot?.getElementById(
            'my-own-stream'
          ) as HTMLVideoElement;
          myVideo.autoplay = true;
          myVideo.srcObject = this.streamsStore.mainStream!;
          this._camera = true;
          break;
        }
        case 'my-video-off': {
          this._camera = false;
          break;
        }
        case 'my-screen-share-on': {
          // Wait for re-render so the conditionally-rendered video element exists in DOM
          this.requestUpdate();
          await this.updateComplete;
          const myScreenVideo = this.shadowRoot?.getElementById(
            'my-own-screen'
          ) as HTMLVideoElement;
          if (myScreenVideo) {
            myScreenVideo.autoplay = true;
            myScreenVideo.srcObject = this.streamsStore.screenShareStream!;
          }
          break;
        }
        case 'my-screen-share-off': {
          if (this._maximizedVideo === 'my-own-screen') {
            this._maximizedVideo = undefined;
          }
          break;
        }
        case 'peer-connected': {
          await this._joinAudio.play();
          break;
        }
        case 'peer-disconnected': {
          if (this._maximizedVideo === event.connectionId) {
            this._maximizedVideo = undefined;
          }
          await this._leaveAudio.play();
          break;
        }
        case 'peer-stream': {
          // We want to make sure that the video element is actually in the DOM
          // so we add a timeout here.
          setTimeout(() => {
            const videoEl = this.shadowRoot?.getElementById(
              event.connectionId
            ) as HTMLVideoElement | undefined;
            if (videoEl) {
              videoEl.autoplay = true;
              videoEl.srcObject = event.stream;
              console.log('@peer-stream: Tracks: ', event.stream.getTracks());
            }
          }, 200);
          break;
        }
        case 'peer-screen-share-stream': {
          console.log('&&&& GOT SCREEN STREAM');
          // We want to make sure that the video element is actually in the DOM
          // so we add a timeout here.
          setTimeout(() => {
            const videoEl = this.shadowRoot?.getElementById(
              event.connectionId
            ) as HTMLVideoElement | undefined;
            console.log('&&&& Trying to set video element (screen share)');
            if (videoEl) {
              videoEl.autoplay = true;
              videoEl.srcObject = event.stream;
            }
          }, 200);
          break;
        }
        case 'peer-screen-share-disconnected': {
          if (this._maximizedVideo === event.connectionId) {
            this._maximizedVideo = undefined;
          }
          break;
        }
        case 'peer-share-wal':
        case 'peer-stop-share-wal': {
          this.requestUpdate();
          break;
        }
        default:
          break;
      }
    });
    this._leaveAudio.volume = 0.05;
    this._joinAudio.volume = 0.07;
    this._reconnectAudio.volume = 0.1;
    this._roomInfo = await this.roomStore.client.getRoomInfo();

    this._weaveClient.assets.assetStore(this.wal).subscribe(status => {
      console.log('Got asset store update: ', status);
      this.assetStoreContent = status;
      this.requestUpdate();
    });

    // Auto-activate receiver-controlled modules that advertise state (e.g. clock timezone)
    for (const mod of getAllModules()) {
      if (mod.activationControl === 'receiver' && mod.defaultState) {
        this.streamsStore.activateModule(mod.id);
      }
    }
  }

  async addAttachment() {
    const dstWal = await this._weaveClient.assets.userSelectAsset();
    console.log('Got WAL: ', dstWal);
    if (dstWal) {
      this._weaveClient.assets.addAssetRelation(this.wal, dstWal);
    }
  }

  async removeAttachment(relationHash: EntryHash) {
    await this._weaveClient.assets.removeAssetRelation(relationHash);
  }

  async startShareWal() {
    const selectedWal = await this._weaveClient.assets.userSelectAsset();
    if (!selectedWal) return;

    let assetName: string | undefined;
    let assetIconSrc: string | undefined;
    try {
      const info = await this._weaveClient.assets.assetInfo(selectedWal);
      if (info) {
        assetName = info.assetInfo.name;
        assetIconSrc = info.assetInfo.icon_src;
      }
    } catch (e) {
      console.warn('Could not resolve asset info for shared WAL:', e);
    }

    const payload: SharedWalPayload = {
      weaveUrl: weaveUrlFromWal(selectedWal),
      assetName,
      assetIconSrc,
    };
    await this.streamsStore.shareWal(payload);
  }

  openCustomEventLogDialog() {
    this._customLogTimestamp = Date.now();
    this._showCustomLogDialog = true;
  }

  logCustomEvent(log: string, timestamp?: number) {
    this.streamsStore.logger.logCustomMessage(log, timestamp);
  }

  toggleMaximized(id: string) {
    if (this._maximizedVideo !== id) {
      this._maximizedVideo = id;
    } else {
      this._maximizedVideo = undefined;
    }
  }

  updated(changedProperties: Map<string, unknown>) {
    // Re-apply video srcObjects after layout changes (e.g. maximize/minimize).
    // The display:contents transition can destroy video rendering context,
    // so we force re-assign srcObject after the DOM settles.
    if (changedProperties.has('_maximizedVideo')) {
      setTimeout(() => this._reapplyVideoStreams(), 50);
    }
  }

  private _reapplyVideoStreams() {
    const restoreVideo = (el: HTMLVideoElement | null, stream: MediaStream | undefined | null) => {
      if (!el || !stream) return;
      // Force re-assign to recover from display:contents transition
      el.srcObject = null;
      el.srcObject = stream;
      el.autoplay = true;
      el.play().catch(() => {});
    };

    // Own screen share
    restoreVideo(
      this.shadowRoot?.getElementById('my-own-screen') as HTMLVideoElement | null,
      this.streamsStore.screenShareStream,
    );

    // Own camera
    restoreVideo(
      this.shadowRoot?.getElementById('my-own-stream') as HTMLVideoElement | null,
      this.streamsStore.mainStream,
    );

    // Peer screen shares
    for (const [pubkeyB64, conn] of Object.entries(this._screenShareConnectionsIncoming.value)) {
      restoreVideo(
        this.shadowRoot?.getElementById(conn.connectionId) as HTMLVideoElement | null,
        this.streamsStore._screenShareStreams[pubkeyB64],
      );
    }

    // Peer video streams
    for (const [pubkeyB64, conn] of Object.entries(this._openConnections.value)) {
      restoreVideo(
        this.shadowRoot?.getElementById(conn.connectionId) as HTMLVideoElement | null,
        this.streamsStore._videoStreams[pubkeyB64],
      );
    }
  }

  _onScreenShareResize = (e: Event) => {
    const video = e.target as HTMLVideoElement;
    const container = video.closest('.video-container') as HTMLElement;
    if (container && video.videoWidth && video.videoHeight) {
      container.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
    }
  };

  _onResizeStart = (e: MouseEvent | TouchEvent) => {
    e.preventDefault();
    this._isResizing = true;

    const onMove = (e: MouseEvent | TouchEvent) => {
      if (!this._isResizing) return;
      const container = this.shadowRoot?.querySelector(
        '.videos-container'
      ) as HTMLElement;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      const isHorizontal = rect.width > rect.height;
      const clientX =
        e instanceof MouseEvent ? e.clientX : e.touches[0].clientX;
      const clientY =
        e instanceof MouseEvent ? e.clientY : e.touches[0].clientY;

      if (isHorizontal) {
        this._splitRatio = ((clientX - rect.left) / rect.width) * 100;
      } else {
        // column: screen shares on top, people on bottom
        this._splitRatio = ((clientY - rect.top) / rect.height) * 100;
      }

      this._splitRatio = Math.max(5, Math.min(95, this._splitRatio));
    };

    const onEnd = () => {
      this._isResizing = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onEnd);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onEnd);
    document.addEventListener('touchmove', onMove);
    document.addEventListener('touchend', onEnd);
  };

  disconnectedCallback(): void {
    if (this.pingInterval) window.clearInterval(this.pingInterval);
    if (this._unsubscribe) this._unsubscribe();
    this.removeEventListener('click', this.sideClickListener);
    this.streamsStore.disconnect();
  }

  idToLayout(id: string, isScreenShare: boolean = false) {
    if (id === this._maximizedVideo) return 'maximized';
    if (this._maximizedVideo) return 'hidden';
    const incomingScreenShareNum = Object.keys(
      this._screenShareConnectionsIncoming.value
    ).length;
    const ownScreenShareNum = this.streamsStore.screenShareStream ? 1 : 0;
    const totalScreenShares = incomingScreenShareNum + ownScreenShareNum;
    const hasScreenShares = totalScreenShares > 0;

    const videoOnlyCount =
      Object.keys(this._openConnections.value).length + 1;
    const totalCount = videoOnlyCount + totalScreenShares;

    // In split mode, size items based on their panel's count
    const num = isScreenShare
      ? totalScreenShares
      : hasScreenShares
        ? videoOnlyCount
        : totalCount;

    if (num === 1) {
      return 'single';
    }
    if (num <= 2) {
      return 'double';
    }
    if (num === 3) {
      return 'triplett';
    }
    if (num <= 4) {
      return 'quartett';
    }
    if (num <= 6) {
      return 'sextett';
    }
    if (num <= 8) {
      return 'octett';
    }
    return 'unlimited';
  }

  roomName() {
    if (this.roomStore.client.roleName === 'presence') return msg('Main Room');
    if (this._roomInfo) return this._roomInfo.name;
    return '[unknown]';
  }

  handleOpenChart(pubkey: AgentPubKeyB64) {
    // Unset first to remove the existing chart from the DOM
    this._logsGraphEnabled = false;
    this._logsGraphAgent = undefined;
    // Set again to add chart to DOM from scratch. Otherwise, chart may be
    // a mix between content of old agent and new agent
    setTimeout(() => {
      this._logsGraphAgent = pubkey;
      this._logsGraphEnabled = true;
    }, 200);
  }

  renderConnectionDetailsToggle() {
    return html`
      <div class="row toggle-switch-container" style="align-items: center;">
        <toggle-switch
          class="toggle-switch ${this._showConnectionDetails ? 'active' : ''}"
          .toggleState=${this._showConnectionDetails}
          @click=${(e: Event) => {
            e.stopPropagation();
          }}
          @toggle-on=${() => {
            this._showConnectionDetails = true;
          }}
          @toggle-off=${() => {
            this._showConnectionDetails = false;
          }}
        ></toggle-switch>
        <span
          class="secondary-font"
          style="cursor: default; margin-left: 7px; ${this
            ._showConnectionDetails
            ? 'opacity: 0.8;'
            : 'opacity: 0.5;'}"
          >${this._showConnectionDetails
            ? 'Hide connection details'
            : 'Show connection details'}</span
        >
      </div>
    `;
  }

  renderAttachmentButton() {
    const numAttachments =
      this.assetStoreContent && this.assetStoreContent.status === 'complete'
        ? this.assetStoreContent.value.linkedFrom.length
        : undefined;
    const numPeople = Object.values(this._connectionStatuses.value).filter(
      status => !!status && status.type !== 'Disconnected'
    ).length;
    return html`
      <div
        tabindex="0"
        class="attachments-btn row center-content"
        @click=${(e: MouseEvent) => {
          this._showAttachmentsPanel = true;
          e.stopPropagation();
        }}
        @keypress=${(e: KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            this._showAttachmentsPanel = true;
          }
        }}
      >
        <div style="margin-bottom: -2px; margin-left: 2px;">
          ${numAttachments || numAttachments === 0 ? numAttachments : ''}
        </div>
        <sl-icon
          .src=${wrapPathInSvg(mdiPaperclip)}
          style="transform: rotate(5deg); margin-left: -2px;"
        ></sl-icon>
        <div style="margin-bottom: -2px; margin-left: 2px;">${numPeople}</div>
        <sl-icon
          .src=${wrapPathInSvg(mdiAccount)}
          style="transform: rotate(3deg); margin-left: -2px;"
        ></sl-icon>
      </div>
    `;
  }

  renderAttachments() {
    if (!this.assetStoreContent) return html`loading...`;
    switch (this.assetStoreContent.status) {
      case 'pending':
        return html`loading...`;
      case 'error':
        console.error(
          'Failed to load attachments: ',
          this.assetStoreContent.error
        );
        return html`Failed to load attachments: ${this.assetStoreContent.error}`;
      case 'complete': {
        return html`
          <div class="column attachments-list">
            ${repeat(
              this.assetStoreContent.value.linkedFrom.sort(
                (walRelationAndTags_a, walRelationAndTags_b) =>
                  walRelationAndTags_a.createdAt -
                  walRelationAndTags_b.createdAt
              ),
              walRelationAndTags =>
                encodeHashToBase64(walRelationAndTags.relationHash),
              walRelationAndTags => html`
                <attachment-element
                  style="margin-bottom: 8px;"
                  .walRelationAndTags=${walRelationAndTags}
                ></attachment-element>
              `
            )}
          </div>
        `;
      }
      default:
        return html`unkown territory...`;
    }
  }

  renderConnectionStatuses() {
    const knownAgentsKeysB64 = Object.keys(this._knownAgents.value);

    const presentAgents = knownAgentsKeysB64
      .filter(pubkeyB64 => {
        const status = this._connectionStatuses.value[pubkeyB64];
        return (
          !!status &&
          status.type !== 'Disconnected' &&
          status.type !== 'Blocked'
        );
      })
      .sort((key_a, key_b) => key_a.localeCompare(key_b));
    const absentAgents = knownAgentsKeysB64
      .filter(pubkeyB64 => {
        const status = this._connectionStatuses.value[pubkeyB64];
        return (
          !status || status.type === 'Disconnected' || status.type === 'Blocked'
        );
      })
      .sort((key_a, key_b) => key_a.localeCompare(key_b));
    return html`
      <div
        class="column"
        style="padding-left: 10px; align-items: flex-start; margin-top: 10px; height: 100%;"
      >
        <div class="column" style="align-items: flex-end;">
          <div class="connectivity-title">Present</div>
          <hr class="divider" />
        </div>
        ${presentAgents.length > 0
          ? repeat(
              presentAgents,
              pubkey => pubkey,
              pubkey => html`
                <agent-connection-status
                  style="width: 100%;"
                  .agentPubKey=${decodeHashFromBase64(pubkey)}
                  .connectionStatus=${this._connectionStatuses.value[pubkey]}
                  .appVersion=${this._knownAgents.value[pubkey].appVersion}
                  @open-chart=${() => this.handleOpenChart(pubkey)}
                ></agent-connection-status>
              `
            )
          : html`<span
              style="color: #c3c9eb; font-size: 20px; font-style: italic; margin-top: 10px; opacity: 0.8;"
              >no one else present.</span
            >`}
        ${absentAgents.length > 0
          ? html`
              <div class="column" style="align-items: flex-end;">
                <div class="connectivity-title">Absent</div>
                <hr class="divider" />
              </div>
              ${repeat(
                absentAgents,
                pubkey => pubkey,
                pubkey => html`
                  <agent-connection-status
                    style="width: 100%;"
                    .agentPubKey=${decodeHashFromBase64(pubkey)}
                    .connectionStatus=${this._connectionStatuses.value[pubkey]}
                    @open-chart=${() => this.handleOpenChart(pubkey)}
                  ></agent-connection-status>
                `
              )}
            `
          : html``}
      </div>
    `;
  }

  renderTrackStatuses(pubkeyB64: AgentPubKeyB64) {
    const perceivedStreamInfo =
      this._othersConnectionStatuses.value[pubkeyB64]?.perceivedStreamInfo;
    const conn = this._openConnections.value[pubkeyB64];
    return html`
      <!-- Relay indicator (only shown when connection goes through TURN) -->
      ${conn?.relayed
        ? html`
            <sl-tooltip
              hoist
              class="tooltip-filled"
              placement="top"
              content="Relayed via TURN server"
              style="--sl-tooltip-background-color: #e7a008;"
            >
              <sl-icon
                style="font-size: 20px; color: #e7a008;"
                .src=${wrapPathInSvg(mdiHub)}
              ></sl-icon>
            </sl-tooltip>
          `
        : html``}

      <!-- Audio track icon -->
      <sl-tooltip
        hoist
        class="tooltip-filled"
        placement="top"
        content="${streamAndTrackInfoToText(perceivedStreamInfo, 'audio')}"
        style="--sl-tooltip-background-color: ${streamAndTrackInfoToColor(
          perceivedStreamInfo,
          'audio'
        )};"
      >
        <sl-icon
          style="font-size: 20px; color: ${streamAndTrackInfoToColor(
            perceivedStreamInfo,
            'audio'
          )}"
          .src=${wrapPathInSvg(mdiMicrophone)}
        ></sl-icon>
      </sl-tooltip>

      <!-- Video track icon -->
      <sl-tooltip
        hoist
        class="tooltip-filled"
        placement="top"
        content="${streamAndTrackInfoToText(perceivedStreamInfo, 'video')}"
        style="--sl-tooltip-background-color: ${streamAndTrackInfoToColor(
          perceivedStreamInfo,
          'video'
        )};"
      >
        <sl-icon
          style="font-size: 20px; color: ${streamAndTrackInfoToColor(
            perceivedStreamInfo,
            'video'
          )}"
          .src=${wrapPathInSvg(mdiVideo)}
        ></sl-icon>
      </sl-tooltip>

      <!-- Diagnostic log request button -->
      ${(() => {
        const hasReceivedLogs = !!this._receivedDiagnosticLogs?.value?.[pubkeyB64];
        const isPending = this.streamsStore._pendingDiagnosticRequests.has(pubkeyB64);
        return html`
          <sl-tooltip
            hoist
            class="tooltip-filled"
            placement="top"
            content="${hasReceivedLogs
              ? 'Download merged diagnostic logs'
              : isPending
                ? 'Requesting logs...'
                : 'Request peer diagnostic logs'}"
          >
            <sl-icon
              style="font-size: 18px; color: ${hasReceivedLogs ? '#09b500' : isPending ? '#e7a008' : '#c3c9eb'}; cursor: pointer; margin-top: 2px;"
              .src=${wrapPathInSvg(mdiCloudDownloadOutline)}
              @click=${() => {
                if (hasReceivedLogs) {
                  downloadJson(
                    `Presence_diagnostic_${pubkeyB64.slice(0, 8)}_${formattedDate()}.json`,
                    JSON.stringify(this.streamsStore.exportMergedLogs(pubkeyB64), undefined, 2)
                  );
                } else {
                  this.streamsStore.requestDiagnosticLogs(pubkeyB64);
                  this.requestUpdate();
                }
              }}
            ></sl-icon>
          </sl-tooltip>
        `;
      })()}
    `;
  }

  renderAttachmentPanel() {
    return html`
      <div
        class="column attachment-panel secondary-font"
        style="align-items: flex-start; justify-content: flex-start;"
        @click=${(e: MouseEvent) => e.stopPropagation()}
        @keypress=${() => undefined}
      >
        <div class="row close-panel">
          <div
            tabindex="0"
            class="close-btn"
            style="margin-right: 10px;"
            @click=${() => {
              this._showAttachmentsPanel = false;
            }}
            @keypress=${(e: KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ') {
                this._showAttachmentsPanel = false;
              }
            }}
          >
            ${msg('close X')}
          </div>
        </div>
        <div class="row sidepanel-tabs">
          <div
            class="sidepanel-tab ${this._panelMode === 'assets'
              ? 'tab-selected'
              : ''}"
            tabindex="0"
            @click=${() => {
              this._panelMode = 'assets';
            }}
            @keypress=${(e: KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ')
                this._panelMode = 'assets';
            }}
          >
            <div class="row center-content">
              <sl-icon
                .src=${wrapPathInSvg(mdiPaperclip)}
                style="transform: rotate(5deg); margin-right: 2px;"
              ></sl-icon>
              assets
            </div>
          </div>
          <div
            class="sidepanel-tab ${this._panelMode === 'people'
              ? 'tab-selected'
              : ''}"
            tabindex="0"
            @click=${() => {
              this._panelMode = 'people';
            }}
            @keypress=${(e: KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ')
                this._panelMode = 'people';
            }}
          >
            <div class="row center-content">
              <sl-icon
                .src=${wrapPathInSvg(mdiAccount)}
                style="transform: rotate(2deg); margin-right: 2px;"
              ></sl-icon>
              people
            </div>
          </div>
        </div>
        ${this.renderAttachmentPanelContent()}
      </div>
    `;
  }

  renderAttachmentPanelContent() {
    switch (this._panelMode) {
      case 'assets':
        return html`
          <div
            class="column"
            style="margin-top: 18px; padding: 0 20px; align-items: flex-start; position: relative; height: 100%;"
          >
            <div
              tabindex="0"
              class="add-attachment-btn"
              @click=${() => this.addAttachment()}
              @keypress=${async (e: KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  await this.addAttachment();
                }
              }}
            >
              + attach asset
            </div>
            ${this.renderAttachments()}
          </div>
        `;
      case 'people':
        return this.renderConnectionStatuses();
      default:
        return html`unknown tab`;
    }
  }

  renderToggles() {
    return html`
      <div class="toggles-panel">
        ${this._showConnectionDetails
          ? html`
              <sl-tooltip content="${msg('Export Logs')}" hoist>
                <div
                  class="toggle-btn"
                  style="position: absolute; left: -130px;"
                  tabindex="0"
                  @click=${(e: any) => {
                    downloadJson(
                      `Presence_${__APP_VERSION__}_logs_${formattedDate()}.json`,
                      JSON.stringify(exportLogs(), undefined, 2)
                    );
                    e.stopPropagation();
                  }}
                  @keypress=${() => undefined}
                >
                  <sl-icon
                    class="toggle-btn-icon"
                    .src=${wrapPathInSvg(mdiDownload)}
                  ></sl-icon>
                </div>
              </sl-tooltip>
              <sl-tooltip content="${msg('Log Custom Event')}" hoist>
                <div
                  class="toggle-btn"
                  style="position: absolute; left: -80px;"
                  tabindex="0"
                  @click=${(e: any) => {
                    this.openCustomEventLogDialog();
                    e.stopPropagation();
                  }}
                  @keypress=${(e: KeyboardEvent) => {
                    this.openCustomEventLogDialog();
                  }}
                >
                  <sl-icon
                    class="toggle-btn-icon"
                    .src=${wrapPathInSvg(mdiNoteEditOutline)}
                  ></sl-icon>
                </div>
              </sl-tooltip>
            `
          : html``}
        <sl-tooltip
          content="${this._microphone
            ? msg('Turn Audio Off')
            : msg('Turn Audio On')}"
          hoist
        >
          <div
            class="toggle-btn ${this._microphone ? '' : 'btn-off'}"
            tabindex="0"
            @click=${async () => {
              if (this._microphone) {
                await this.streamsStore.audioOff();
              } else {
                await this.streamsStore.audioOn(true);
              }
            }}
            @keypress=${async (e: KeyboardEvent) => {
              if (e.key === 'Enter') {
                if (this._microphone) {
                  await this.streamsStore.audioOff();
                } else {
                  await this.streamsStore.audioOn(true);
                }
              }
            }}
          >
            <sl-icon
              class="toggle-btn-icon ${this._microphone ? '' : 'btn-icon-off'}"
              .src=${this._microphone
                ? wrapPathInSvg(mdiMicrophone)
                : wrapPathInSvg(mdiMicrophoneOff)}
            ></sl-icon>

            <!-- Audio input toggle -->
            <div
              class="toggle-sub-btn column center-content"
              tabindex="0"
              @click=${async (e: any) => {
                e.stopPropagation();
                this._showAudioSources = !this._showAudioSources;
                await this.streamsStore.updateMediaDevices();
              }}
              @keypress=${async (e: KeyboardEvent) => {
                if (e.key === 'Enter') {
                  e.stopPropagation();
                  this._showAudioSources = !this._showAudioSources;
                  await this.streamsStore.updateMediaDevices();
                }
              }}
              @mouseover=${(e: any) => e.stopPropagation()}
              @focus=${() => {}}
            >
              <sl-icon
                class="sub-btn-icon"
                .src=${wrapPathInSvg(mdiChevronUp)}
              ></sl-icon>
            </div>

            <!-- Audio input sources -->
            ${this._showAudioSources
              ? html`
                  <div
                    class="column audio-input-sources secondary-font"
                    @click=${(e: any) => {
                      e.stopPropagation();
                    }}
                    @keypress=${(e: KeyboardEvent) => {
                      if (e.key === 'Enter') {
                        e.stopPropagation();
                      }
                    }}
                    @mouseover=${(e: any) => e.stopPropagation()}
                    @focus=${() => {}}
                  >
                    <div class="input-source-title">
                      ${msg('Audio Input Source')}
                    </div>
                    ${this._audioInputDevices.value.map(device => {
                      let isSelected = false;
                      if (
                        !this._audioInputId.value &&
                        device.deviceId === 'default'
                      ) {
                        isSelected = true;
                      }
                      if (
                        this._audioInputId.value &&
                        device.deviceId === this._audioInputId.value
                      ) {
                        isSelected = true;
                      }
                      return html`
                        <div
                          class="audio-source column"
                          tabindex="0"
                          @click=${async (e: any) => {
                            this.closeClosables();
                            await this.streamsStore.changeAudioInput(
                              device.deviceId
                            );
                          }}
                          @keypress=${async (e: KeyboardEvent) => {
                            if (e.key === 'Enter') {
                              this.closeClosables();
                              await this.streamsStore.changeAudioInput(
                                device.deviceId
                              );
                            }
                          }}
                        >
                          <div class="row">
                            <div
                              style="${isSelected ? '' : 'color: transparent'}"
                            >
                              &#10003;&nbsp;
                            </div>
                            <div>${deviceLabel(device.label)}</div>
                          </div>
                        </div>
                      `;
                    })}
                  </div>
                `
              : html``}
          </div>
        </sl-tooltip>

        <sl-tooltip
          content="${this._camera
            ? msg('Turn Camera Off')
            : msg('Turn Camera On')}"
          hoist
        >
          <div
            class="toggle-btn ${this._camera ? '' : 'btn-off'}"
            tabindex="0"
            @click=${async () => {
              if (this._camera) {
                await this.streamsStore.videoOff();
              } else {
                await this.streamsStore.videoOn();
              }
            }}
            @keypress=${async (e: KeyboardEvent) => {
              if (e.key === 'Enter') {
                if (this._camera) {
                  await this.streamsStore.videoOff();
                } else {
                  await this.streamsStore.videoOn();
                }
              }
            }}
          >
            <sl-icon
              class="toggle-btn-icon ${this._camera ? '' : 'btn-icon-off'}"
              .src=${this._camera
                ? wrapPathInSvg(mdiVideo)
                : wrapPathInSvg(mdiVideoOff)}
            ></sl-icon>

            <!-- Video input toggle -->
            <div
              class="toggle-sub-btn column center-content"
              tabindex="0"
              @click=${async (e: any) => {
                e.stopPropagation();
                this._showVideoSources = !this._showVideoSources;
                await this.streamsStore.updateMediaDevices();
              }}
              @keypress=${async (e: KeyboardEvent) => {
                if (e.key === 'Enter') {
                  e.stopPropagation();
                  this._showVideoSources = !this._showVideoSources;
                  await this.streamsStore.updateMediaDevices();
                }
              }}
              @mouseover=${(e: any) => e.stopPropagation()}
              @focus=${() => {}}
            >
              <sl-icon
                class="sub-btn-icon"
                .src=${wrapPathInSvg(mdiChevronUp)}
              ></sl-icon>
            </div>

            <!-- Video Input Sources -->
            ${this._showVideoSources
              ? html`
                  <div
                    class="column audio-input-sources secondary-font"
                    @click=${(e: any) => {
                      e.stopPropagation();
                    }}
                    @keypress=${(e: KeyboardEvent) => {
                      if (e.key === 'Enter') {
                        e.stopPropagation();
                      }
                    }}
                    @mouseover=${(e: any) => e.stopPropagation()}
                    @focus=${() => {}}
                  >
                    <div class="input-source-title">
                      ${msg('Video Input Source')}
                    </div>
                    ${this._videoInputDevices.value.map((device, idx) => {
                      let isSelected = false;
                      if (!this._videoInputId.value && idx === 0) {
                        isSelected = true;
                      }
                      if (
                        this._videoInputId.value &&
                        device.deviceId === this._videoInputId.value
                      ) {
                        isSelected = true;
                      }
                      return html`
                        <div
                          class="audio-source column"
                          tabindex="0"
                          @click=${async (e: any) => {
                            this.closeClosables();
                            await this.streamsStore.changeVideoInput(
                              device.deviceId
                            );
                          }}
                          @keypress=${async (e: KeyboardEvent) => {
                            if (e.key === 'Enter') {
                              this.closeClosables();
                              await this.streamsStore.changeVideoInput(
                                device.deviceId
                              );
                            }
                          }}
                        >
                          <div class="row">
                            <div
                              style="${isSelected ? '' : 'color: transparent'}"
                            >
                              &#10003;&nbsp;
                            </div>
                            <div>${deviceLabel(device.label)}</div>
                          </div>
                        </div>
                      `;
                    })}
                  </div>
                `
              : html``}
          </div>
        </sl-tooltip>

        <sl-tooltip
          content="${this.streamsStore.screenShareStream
            ? msg('Stop Screen Sharing')
            : msg('Share Screen')}"
          hoist
        >
          <div
            class="toggle-btn ${this.streamsStore.screenShareStream
              ? ''
              : 'btn-off'}"
            tabindex="0"
            @click=${async () => {
              if (this.streamsStore.screenShareStream) {
                await this.streamsStore.screenShareOff();
              } else {
                await this.streamsStore.screenShareOn();
              }
            }}
            @keypress=${async (e: KeyboardEvent) => {
              if (e.key === 'Enter') {
                if (this.streamsStore.screenShareStream) {
                  await this.streamsStore.screenShareOff();
                } else {
                  await this.streamsStore.screenShareOn();
                }
              }
            }}
          >
            <sl-icon
              class="toggle-btn-icon ${this.streamsStore.screenShareStream
                ? ''
                : 'btn-icon-off'}"
              .src=${wrapPathInSvg(mdiMonitorScreenshot)}
            ></sl-icon>
          </div>
        </sl-tooltip>

        <sl-tooltip
          content="${this._mySharedWal.value
            ? msg('Stop Sharing Asset')
            : msg('Share Asset')}"
          hoist
        >
          <div
            class="toggle-btn ${this._mySharedWal.value ? '' : 'btn-off'}"
            tabindex="0"
            @click=${async () => {
              if (this._mySharedWal.value) {
                await this.streamsStore.stopShareWal();
              } else {
                await this.startShareWal();
              }
            }}
            @keypress=${async (e: KeyboardEvent) => {
              if (e.key === 'Enter') {
                if (this._mySharedWal.value) {
                  await this.streamsStore.stopShareWal();
                } else {
                  await this.startShareWal();
                }
              }
            }}
          >
            <sl-icon
              class="toggle-btn-icon ${this._mySharedWal.value ? '' : 'btn-icon-off'}"
              .src=${wrapPathInSvg(mdiCubeOutline)}
            ></sl-icon>
          </div>
        </sl-tooltip>

        <sl-tooltip
          content="${this._selfViewHidden
            ? msg('Show Self View')
            : msg('Hide Self View')}"
          hoist
        >
          <div
            class="toggle-btn ${this._selfViewHidden ? 'btn-off' : ''}"
            tabindex="0"
            @click=${() => {
              this._selfViewHidden = !this._selfViewHidden;
            }}
            @keypress=${(e: KeyboardEvent) => {
              if (e.key === 'Enter') {
                this._selfViewHidden = !this._selfViewHidden;
              }
            }}
          >
            <sl-icon
              class="toggle-btn-icon ${this._selfViewHidden ? 'btn-icon-off' : ''}"
              .src=${this._selfViewHidden
                ? wrapPathInSvg(mdiAccountOff)
                : wrapPathInSvg(mdiAccount)}
            ></sl-icon>

            <!-- View shape toggle -->
            <div
              class="toggle-sub-btn column center-content"
              tabindex="0"
              @click=${(e: any) => {
                e.stopPropagation();
                this._showViewShapeOptions = !this._showViewShapeOptions;
              }}
              @keypress=${(e: KeyboardEvent) => {
                if (e.key === 'Enter') {
                  e.stopPropagation();
                  this._showViewShapeOptions = !this._showViewShapeOptions;
                }
              }}
              @mouseover=${(e: any) => e.stopPropagation()}
              @focus=${() => {}}
            >
              <sl-icon
                class="sub-btn-icon"
                .src=${wrapPathInSvg(mdiChevronUp)}
              ></sl-icon>
            </div>

            <!-- View shape options -->
            ${this._showViewShapeOptions
              ? html`
                  <div
                    class="column audio-input-sources secondary-font"
                    @click=${(e: any) => {
                      e.stopPropagation();
                    }}
                    @keypress=${(e: KeyboardEvent) => {
                      if (e.key === 'Enter') {
                        e.stopPropagation();
                      }
                    }}
                    @mouseover=${(e: any) => e.stopPropagation()}
                    @focus=${() => {}}
                  >
                    <div class="input-source-title">
                      ${msg('View Shape')}
                    </div>
                    <div
                      class="audio-source column"
                      tabindex="0"
                      @click=${() => {
                        this._circleView = true;
                        this.closeClosables();
                      }}
                      @keypress=${(e: KeyboardEvent) => {
                        if (e.key === 'Enter') {
                          this._circleView = true;
                          this.closeClosables();
                        }
                      }}
                    >
                      <div class="row">
                        <div style="${this._circleView ? '' : 'color: transparent'}">
                          &#10003;&nbsp;
                        </div>
                        <div>${msg('Circle')}</div>
                      </div>
                    </div>
                    <div
                      class="audio-source column"
                      tabindex="0"
                      @click=${() => {
                        this._circleView = false;
                        this.closeClosables();
                      }}
                      @keypress=${(e: KeyboardEvent) => {
                        if (e.key === 'Enter') {
                          this._circleView = false;
                          this.closeClosables();
                        }
                      }}
                    >
                      <div class="row">
                        <div style="${!this._circleView ? '' : 'color: transparent'}">
                          &#10003;&nbsp;
                        </div>
                        <div>${msg('Rectangle')}</div>
                      </div>
                    </div>
                  </div>
                `
              : html``}
          </div>
        </sl-tooltip>

        <!-- Module toolbar buttons -->
        ${getAllModules()
          .filter(m => m.renderToolbarButton)
          .map(mod => {
            const myState = this._myModuleStates.value?.[mod.id] || null;
            const toggle = async () => {
              if (myState) {
                await this.streamsStore.deactivateModule(mod.id);
                this._stopModuleTimer(mod.id);
              } else {
                await this.streamsStore.activateModule(mod.id);
                this._startModuleTimer(mod.id);
              }
            };
            return mod.renderToolbarButton!(myState, toggle);
          })
        }

        <sl-tooltip content="${msg('Leave Call')}" hoist>
          <div
            class="btn-stop"
            tabindex="0"
            @click=${async () => this.quitRoom()}
            @keypress=${async (e: KeyboardEvent) => {
              if (e.key === 'Enter') {
                this.quitRoom();
              }
            }}
          >
            <div class="stop-icon"></div>
          </div>
        </sl-tooltip>
      </div>
    `;
  }

  // ===========================================================================================
  // MODULE RENDERING HELPERS
  // ===========================================================================================

  /**
   * Renders a module-switcher dropdown for a peer's pane.
   * Lists available replace modules the receiver can switch to.
   * Only shown when the peer has receiver-activated modules with renderReplace.
   */
  renderModuleSwitcher(pubkeyB64: AgentPubKeyB64) {
    const peerModules = this._peerModuleStates.value?.[pubkeyB64] || {};
    const currentOverride = this._receiverModuleOverrides.value?.[pubkeyB64];

    // Find modules with renderReplace that the receiver can switch to:
    // - receiver-activated modules (always switchable when active)
    // - sender-activated modules that also have an overlay (replace is an optional deeper view)
    const switchableModules = Object.entries(peerModules)
      .map(([moduleId, _envelope]) => getModule(moduleId))
      .filter((mod): mod is NonNullable<typeof mod> =>
        !!mod && !!mod.renderReplace && (
          mod.activationControl === 'receiver' ||
          (mod.activationControl === 'sender' && !!mod.renderOverlay)
        )
      );

    if (switchableModules.length === 0) return html``;

    return html`
      <sl-dropdown placement="top" distance="4" hoist>
        <sl-icon-button
          slot="trigger"
          style="font-size: 20px; margin-left: 4px; margin-bottom: -5px;"
          src=${wrapPathInSvg(switchableModules.length > 0 && currentOverride
            ? (getModule(currentOverride)?.icon || mdiVideo)
            : mdiVideo)}
        ></sl-icon-button>
        <sl-menu class="reconnect-menu secondary-font">
          <sl-menu-item
            class="reconnect-menu-item"
            @click=${() => this.streamsStore.setReceiverOverride(pubkeyB64, null)}
          >
            <sl-icon slot="prefix" .src=${wrapPathInSvg(mdiVideo)} style="font-size: 16px;"></sl-icon>
            Video${!currentOverride ? ' ✓' : ''}
          </sl-menu-item>
          ${switchableModules.map(mod => html`
            <sl-menu-item
              class="reconnect-menu-item"
              @click=${() => this.streamsStore.setReceiverOverride(pubkeyB64, mod.id)}
            >
              <sl-icon slot="prefix" .src=${wrapPathInSvg(mod.icon)} style="font-size: 16px;"></sl-icon>
              ${mod.label}${currentOverride === mod.id ? ' ✓' : ''}
            </sl-menu-item>
          `)}
        </sl-menu>
      </sl-dropdown>
    `;
  }

  /**
   * Determines the active replace module for an agent's pane.
   * Priority: receiver override > sender-activated replace modules > null (default video).
   * Returns { moduleId, html } or null if default video should show.
   */
  _getActiveReplaceModule(
    pubkeyB64: AgentPubKeyB64,
    context: ModuleRenderContext,
    useMyStates = false,
  ): { moduleId: string; html: unknown } | null {
    const modules = useMyStates
      ? (this._myModuleStates.value || {})
      : (this._peerModuleStates.value?.[pubkeyB64] || {});

    // Check receiver override first (works for both receiver- and sender-activated modules)
    const override = this._receiverModuleOverrides.value?.[pubkeyB64];
    if (override) {
      const mod = getModule(override);
      if (mod?.renderReplace) {
        const state = (modules as Record<string, ModuleStateEnvelope>)[override] || null;
        return { moduleId: override, html: mod.renderReplace(pubkeyB64, state, context) };
      }
    }

    // Check sender-activated replace-only modules (no overlay = forces replace)
    for (const [moduleId, envelope] of Object.entries(modules)) {
      if (moduleId === 'video') continue;
      const mod = getModule(moduleId);
      if (mod?.renderReplace && !mod.renderOverlay && mod.activationControl === 'sender' && envelope.active) {
        return { moduleId, html: mod.renderReplace(pubkeyB64, envelope, context) };
      }
    }

    return null;
  }

  /**
   * Renders the standardized icon strip for all active modules on an agent's pane.
   * Collects icons from all active modules, filters hidden ones, renders in a row.
   */
  renderModuleIconStrip(pubkeyB64: AgentPubKeyB64, context: ModuleRenderContext) {
    const peerModules = this._peerModuleStates.value?.[pubkeyB64] || {};
    const allIcons: ModuleIconDefinition[] = [];

    // Always get video module icons (video is always "active" for connected peers)
    const videoMod = getModule('video');
    if (videoMod?.getStateIcons) {
      allIcons.push(...videoMod.getStateIcons(pubkeyB64, null, context));
    }

    // Get icons from other active modules
    for (const [moduleId, envelope] of Object.entries(peerModules)) {
      if (moduleId === 'video') continue;
      const mod = getModule(moduleId);
      if (mod?.getStateIcons) {
        allIcons.push(...mod.getStateIcons(pubkeyB64, envelope, context));
      }
    }

    const visibleIcons = allIcons.filter(icon => icon.currentState !== undefined);
    if (visibleIcons.length === 0) return html``;

    return html`
      ${visibleIcons.map(icon => {
        const stateInfo = icon.states[icon.currentState!];
        const clickable = !!icon.onSelect;
        return html`
          <sl-icon
            style="color: ${stateInfo.color || 'white'}; height: 30px; width: 30px;${clickable ? ' cursor: pointer;' : ''}"
            title="${stateInfo.tooltip || ''}"
            .src=${wrapPathInSvg(stateInfo.icon)}
            @click=${clickable ? () => icon.onSelect!(icon.currentState!) : undefined}
          ></sl-icon>
        `;
      })}
    `;
  }

  /**
   * Renders all active overlay modules for an agent's pane.
   */
  renderModuleOverlays(pubkeyB64: AgentPubKeyB64, context: ModuleRenderContext) {
    const peerModules = this._peerModuleStates.value?.[pubkeyB64] || {};
    const overlays: unknown[] = [];

    for (const [moduleId, envelope] of Object.entries(peerModules)) {
      const mod = getModule(moduleId);
      if (mod?.renderOverlay) {
        overlays.push(mod.renderOverlay(pubkeyB64, envelope, context));
      }
    }

    return overlays;
  }

  /**
   * Renders overlay modules for the self-pane using _myModuleStates.
   */
  renderMyModuleOverlays(myPubKeyB64: AgentPubKeyB64, context: ModuleRenderContext) {
    const myModules = this._myModuleStates.value || {};
    const overlays: unknown[] = [];

    for (const [moduleId, envelope] of Object.entries(myModules)) {
      const mod = getModule(moduleId);
      if (mod?.renderOverlay) {
        overlays.push(mod.renderOverlay(myPubKeyB64, envelope, context));
      }
    }

    return overlays;
  }

  /**
   * Renders the module icon strip for the self-pane using _myModuleStates.
   */
  renderMyModuleIconStrip(myPubKeyB64: AgentPubKeyB64, context: ModuleRenderContext) {
    const myModules = this._myModuleStates.value || {};
    const allIcons: ModuleIconDefinition[] = [];

    for (const [moduleId, envelope] of Object.entries(myModules)) {
      const mod = getModule(moduleId);
      if (mod?.getStateIcons) {
        allIcons.push(...mod.getStateIcons(myPubKeyB64, envelope, context));
      }
    }

    const visibleIcons = allIcons.filter(icon => icon.currentState !== undefined);
    if (visibleIcons.length === 0) return html``;

    return html`
      ${visibleIcons.map(icon => {
        const stateInfo = icon.states[icon.currentState!];
        const clickable = !!icon.onSelect;
        return html`
          <sl-icon
            style="color: ${stateInfo.color || 'white'}; height: 30px; width: 30px;${clickable ? ' cursor: pointer;' : ''}"
            title="${stateInfo.tooltip || ''}"
            .src=${wrapPathInSvg(stateInfo.icon)}
            @click=${clickable ? () => icon.onSelect!(icon.currentState!) : undefined}
          ></sl-icon>
        `;
      })}
    `;
  }

  /**
   * Renders connection statuses of agents with icons in a row.
   *
   * @param type
   * @param pubkeyb64
   * @returns
   */
  renderAgentConnectionStatuses(
    type: 'video' | 'my-video' | 'my-screen-share' | 'their-screen-share',
    pubkeyb64?: AgentPubKeyB64
  ) {
    let knownAgents: Record<AgentPubKeyB64, AgentInfo> | undefined;
    let staleInfo: boolean;
    let connectionStatuses: ConnectionStatuses;
    let perceivedStreamInfo: StreamAndTrackInfo | undefined;

    if (type === 'my-screen-share') {
      knownAgents = this._knownAgents.value;
      staleInfo = false;
      connectionStatuses = this._screenShareConnectionStatuses.value;
    } else if (type === 'my-video') {
      knownAgents = this._knownAgents.value;
      staleInfo = false;
      connectionStatuses = this._connectionStatuses.value;
    } else {
      if (!pubkeyb64)
        throw Error(
          "For rendering connection statuses of type 'video' or 'their-screen-share', a public key must be provided."
        );
      const statuses = this._othersConnectionStatuses.value[pubkeyb64];
      if (!statuses)
        return html`<span
          class="tertiary-font"
          style="color: #c3c9eb; font-size: 16px;"
          >Unkown connection statuses</span
        >`;

      knownAgents = statuses.knownAgents;
      perceivedStreamInfo = statuses.perceivedStreamInfo;
      const now = Date.now();
      staleInfo = now - statuses.lastUpdated > 2.8 * PING_INTERVAL;

      switch (type) {
        case 'video': {
          connectionStatuses = statuses.statuses;
          break;
        }
        case 'their-screen-share': {
          if (!statuses.screenShareStatuses)
            return html`<span
              class="tertiary-font"
              style="color: #c3c9eb; font-size: 16px;"
              >Unkown connection statuses</span
            >`;
          connectionStatuses = statuses.screenShareStatuses;
          break;
        }
        default:
          throw new Error(`Unknown connection type: ${type}`);
      }
    }

    const myPubKeyB64 = encodeHashToBase64(
      this.roomStore.client.client.myPubKey
    );

    const nConnections = Object.values(connectionStatuses).filter(
      status => status.type === 'Connected'
    ).length;

    // if the info is older than >2.8 PING_INTERVAL, show the info opaque to indicated that it's outdated
    const sortedStatuses = Object.entries(connectionStatuses).sort(
      sortConnectionStatuses
    );
    return html`
      <div class="row" style="align-items: center; flex-wrap: wrap;">
        ${repeat(
          sortedStatuses,
          ([pubkeyb64, _status]) => pubkeyb64,
          ([innerPubkey, status]) => {
            // Check whether the agent for which the statuses are rendered has only been told by others that
            // the rendered agent exists
            const onlyToldAbout = !!(
              knownAgents &&
              knownAgents[innerPubkey] &&
              knownAgents[innerPubkey].type === 'told'
            );

            const lastSeen = knownAgents
              ? knownAgents[innerPubkey]?.lastSeen
              : undefined;

            // Determine track status for this avatar
            let audioStatus: 'on' | 'muted' | 'off' | undefined;
            let videoStatus: 'on' | 'muted' | 'off' | undefined;

            if (type === 'my-video') {
              // Our tile: show what we receive from each peer
              const conn = this._openConnections.value[innerPubkey];
              if (conn?.connected) {
                audioStatus = conn.audio ? 'on' : 'off';
                videoStatus = conn.video
                  ? 'on'
                  : conn.videoMuted
                    ? 'muted'
                    : 'off';
              }
            } else if (type === 'video' && innerPubkey === myPubKeyB64) {
              // Peer's tile: show how they see OUR stream (only on our avatar)
              audioStatus = streamInfoToTrackStatus(
                perceivedStreamInfo,
                'audio'
              );
              videoStatus = streamInfoToTrackStatus(
                perceivedStreamInfo,
                'video'
              );
            }

            return html`<agent-connection-status-icon
              style="margin-right: 2px; margin-bottom: 2px; ${staleInfo
                ? 'opacity: 0.5;'
                : ''}"
              .agentPubKey=${decodeHashFromBase64(innerPubkey)}
              .connectionStatus=${status}
              .onlyToldAbout=${onlyToldAbout}
              .lastSeen=${lastSeen}
              .audioStatus=${audioStatus}
              .videoStatus=${videoStatus}
            ></agent-connection-status-icon>`;
          }
        )}
        <span
          class="tertiary-font"
          style="color: #c3c9eb; font-size: 24px; margin-left: 5px;"
          >(${nConnections})</span
        >
      </div>
    `;
  }

  render() {
    const incomingScreenShares = Object.entries(this._screenShareConnectionsIncoming.value).filter(
      ([_, conn]) => conn.direction === 'incoming'
    );
    const allSharedWals = {
      ...(this._mySharedWal.value ? { [encodeHashToBase64(this.roomStore.client.client.myPubKey)]: this._mySharedWal.value } : {}),
      ...(this._peerSharedWals.value || {}),
    };
    const sharedWalEntries = Object.entries(allSharedWals);
    const hasScreenShares =
      !!this.streamsStore.screenShareStream || incomingScreenShares.length > 0 || sharedWalEntries.length > 0;
    const splitMode = hasScreenShares && !this._maximizedVideo;
    return html`
      <div
        class="custom-log-dialog"
        style="${this._showCustomLogDialog ? '' : 'display: none;'}"
      >
        <div
          class="panel"
          @click=${(e: any) => e.stopPropagation()}
          @keypress=${() => undefined}
        >
          <div class="column secondary-font">
            <div style="font-size: 23px; margin-bottom: 10px;">
              ${msg('Log a custom event:')}
            </div>
            <textarea id="custom-log-textarea"></textarea>
            <div class="row items-center">
              <input type="checkbox" id="log-timestamp-checkbox" />
              <div
                style="margin-left: 5px; font-size: 14px; max-width: 220px; line-height: 16px; margin: 5px; text-align: left;"
              >
                ${msg(
                  'take timestamp at the time of logging (default is timestamp when dialog opened)'
                )}
              </div>
            </div>
            <button
              @click=${() => {
                const value = this._customLogTextarea.value;
                this.logCustomEvent(
                  value,
                  this._logTimestampCheckbox.checked
                    ? undefined
                    : this._customLogTimestamp
                );
                this.closeCustomLogDialog();
              }}
            >
              Log!
            </button>
          </div>
        </div>
      </div>
      ${this._logsGraphEnabled && this._logsGraphAgent
        ? html`
            <div style="position: fixed; bottom: 20px; left: 20px; z-index: 9;">
              <div style="position: relative;">
                <div
                  class="row"
                  style="position: absolute; top: -25px; right: -25px;"
                >
                  <button
                    class="close-graph-btn"
                    style="margin-right: 3px;${this._logsGraphMinimized
                      ? 'display: none;'
                      : ''}"
                    @click=${() => {
                      this._logsGraphMinimized = true;
                    }}
                  >
                    <sl-icon .src=${wrapPathInSvg(mdiMinus)}></sl-icon>
                  </button>
                  <button
                    class="close-graph-btn"
                    style="${this._logsGraphMinimized ? 'display: none;' : ''}"
                    @click=${() => {
                      this._logsGraphEnabled = false;
                      this._logsGraphMinimized = false;
                    }}
                  >
                    <sl-icon .src=${wrapPathInSvg(mdiClose)}></sl-icon>
                  </button>
                </div>
                <logs-graph
                  style="border-radius: 5px; ${this._logsGraphMinimized
                    ? 'display: none;'
                    : ''}"
                  .agent=${this._logsGraphAgent}
                ></logs-graph>
              </div>
              <button
                class="logs-graph-btn"
                @click=${() => {
                  this._logsGraphMinimized = false;
                }}
                style="${this._logsGraphMinimized ? '' : 'display: none;'}"
              >
                <div class="row items-center secondary-font">
                  <sl-icon .src=${wrapPathInSvg(mdiChartLine)}></sl-icon>
                  <span style="margin-left: 5px;"> ${msg('Logs Graph')} </span>
                  <agent-avatar
                    style="margin-bottom: -12px; margin-left: 5px;"
                    .agentPubKey=${decodeHashFromBase64(this._logsGraphAgent)}
                  ></agent-avatar>
                </div>
              </button>
            </div>
          `
        : html``}
      <div class="row center-content room-name">
        ${this.private
          ? html`<sl-icon
              .src=${wrapPathInSvg(mdiLock)}
              style="font-size: 28px; margin-right: 3px;"
            ></sl-icon>`
          : html``}
        ${this.roomName()}
      </div>
      <div class="videos-container${splitMode ? ' split-mode' : ''}">
        ${this._isResizing ? html`<div class="resize-overlay"></div>` : html``}
        ${hasScreenShares ? html`
        <div class="screen-share-panel" style="${splitMode ? `flex-basis: ${this._splitRatio}%` : ''}">
        <!-- My own screen first if screen sharing is enabled -->
        <div
          style="${this.streamsStore.screenShareStream ? '' : 'display: none;'}"
          class="video-container screen-share shared-panel-frame ${this.idToLayout(
            'my-own-screen',
            true
          )}"
          @dblclick=${() => this.toggleMaximized('my-own-screen')}
        >
          <video
            muted
            id="my-own-screen"
            class="video-el"
            @resize=${this._onScreenShareResize}
            @loadedmetadata=${this._onScreenShareResize}
          ></video>

          <!-- Connection states indicators -->
          ${this._showConnectionDetails
            ? html`<div
                style="display: flex; flex-direction: row; align-items: center; position: absolute; top: 10px; left: 10px; background: none;"
              >
                ${this.renderAgentConnectionStatuses('my-screen-share')}
              </div>`
            : html``}

          <!-- Avatar and nickname -->
          <div
            style="display: flex; flex-direction: row; align-items: center; position: absolute; bottom: 10px; right: 10px; background: none;"
          >
            <avatar-with-nickname
              .size=${36}
              .agentPubKey=${this.roomStore.client.client.myPubKey}
              style="height: 36px;"
            ></avatar-with-nickname>
          </div>
          <sl-icon
            title="${this._maximizedVideo === 'my-own-screen'
              ? 'minimize'
              : 'maximize'}"
            .src=${this._maximizedVideo === 'my-own-screen'
              ? wrapPathInSvg(mdiFullscreenExit)
              : wrapPathInSvg(mdiFullscreen)}
            tabindex="0"
            class="maximize-icon"
            @click=${() => {
              this.toggleMaximized('my-own-screen');
            }}
            @keypress=${(e: KeyboardEvent) => {
              if (e.key === 'Enter') {
                this.toggleMaximized('my-own-screen');
              }
            }}
          ></sl-icon>
        </div>
        <!--Then other agents' screens -->

        ${repeat(
          Object.entries(this._screenShareConnectionsIncoming.value).filter(
            ([_, conn]) => conn.direction === 'incoming'
          ),
          ([_pubkeyB64, conn]) => conn.connectionId,
          ([pubkeyB64, conn]) => html`
            <div
              class="video-container screen-share shared-panel-frame ${this.idToLayout(
                conn.connectionId,
                true
              )}"
              @dblclick=${() => this.toggleMaximized(conn.connectionId)}
            >
              <video
                style="${conn.connected ? '' : 'display: none;'}"
                id="${conn.connectionId}"
                class="video-el"
                @resize=${this._onScreenShareResize}
                @loadedmetadata=${this._onScreenShareResize}
              ></video>
              <div
                style="color: #b98484; ${conn.connected ? 'display: none' : ''}"
              >
                establishing connection...
              </div>

              <!-- Connection states indicators -->
              ${this._showConnectionDetails
                ? html`<div
                    style="display: flex; flex-direction: row; align-items: center; position: absolute; top: 10px; left: 10px; background: none;"
                  >
                    ${this.renderAgentConnectionStatuses(
                      'their-screen-share',
                      pubkeyB64
                    )}
                  </div>`
                : html``}

              <!-- Avatar and nickname -->
              <div
                style="display: flex; flex-direction: row; align-items: center; position: absolute; bottom: 10px; right: 10px; background: none;"
              >
                <avatar-with-nickname
                  .size=${36}
                  .agentPubKey=${decodeHashFromBase64(pubkeyB64)}
                  style="height: 36px;"
                ></avatar-with-nickname>
                <sl-tooltip content="reconnect" class="tooltip-filled">
                  <sl-icon-button
                    class="phone-refresh"
                    style="margin-left: 4px; margin-bottom: -5px;"
                    src=${wrapPathInSvg(mdiPhoneRefresh)}
                    @click=${() => {
                      this.streamsStore.disconnectFromPeerScreen(pubkeyB64);
                    }}
                  ></sl-icon-button>
                </sl-tooltip>
              </div>
              <sl-icon
                title="${this._maximizedVideo === conn.connectionId
                  ? 'minimize'
                  : 'maximize'}"
                .src=${this._maximizedVideo === conn.connectionId
                  ? wrapPathInSvg(mdiFullscreenExit)
                  : wrapPathInSvg(mdiFullscreen)}
                tabindex="0"
                class="maximize-icon"
                @click=${() => {
                  this.toggleMaximized(conn.connectionId);
                }}
                @keypress=${(e: KeyboardEvent) => {
                  if (e.key === 'Enter') {
                    this.toggleMaximized(conn.connectionId);
                  }
                }}
              ></sl-icon>
            </div>
          `
        )}

        <!-- Shared WAL embeds -->
        ${sharedWalEntries.map(([agentB64, walPayload]) => {
          const isMe = agentB64 === encodeHashToBase64(this.roomStore.client.client.myPubKey);
          const walEmbedId = `shared-wal-${agentB64.slice(0, 8)}`;
          const walLayout = this._maximizedVideo === walEmbedId ? 'maximized' : this._maximizedVideo ? 'hidden' : '';
          return html`
          <div class="shared-wal-container shared-panel-frame ${walLayout}"
            @dblclick=${() => this.toggleMaximized(walEmbedId)}
          >
            <shared-wal-embed
              .src=${walPayload.weaveUrl}
              .closable=${isMe}
              @close=${() => this.streamsStore.stopShareWal()}
              style="flex: 1;"
            ></shared-wal-embed>
            <sl-icon
              title="${this._maximizedVideo === walEmbedId ? 'minimize' : 'maximize'}"
              .src=${this._maximizedVideo === walEmbedId
                ? wrapPathInSvg(mdiFullscreenExit)
                : wrapPathInSvg(mdiFullscreen)}
              tabindex="0"
              class="maximize-icon"
              @click=${() => this.toggleMaximized(walEmbedId)}
              @keypress=${(e: KeyboardEvent) => {
                if (e.key === 'Enter') this.toggleMaximized(walEmbedId);
              }}
            ></sl-icon>
            <div class="shared-wal-footer">
              <avatar-with-nickname
                .size=${36}
                .agentPubKey=${decodeHashFromBase64(agentB64)}
                style="height: 36px;"
              ></avatar-with-nickname>
            </div>
          </div>
        `})}

        </div>
        ${splitMode ? html`<div class="resize-handle" @mousedown=${this._onResizeStart} @touchstart=${this._onResizeStart}></div>` : html``}
        ` : html``}
        <div class="${splitMode ? 'people-panel' : 'layout-transparent'}">
        <!-- My own video stream -->
        ${(() => {
          const myPubKeyB64 = encodeHashToBase64(this.roomStore.client.client.myPubKey);
          const myModuleContext: ModuleRenderContext = {
            isMe: true,
            connected: true,
            circleView: this._circleView,
            streamsStore: this.streamsStore,
            myPubKeyB64,
          };
          const myActiveReplace = this._getActiveReplaceModule(myPubKeyB64, myModuleContext, true);
          return html`
        <div
          style="${this._selfViewHidden ? 'display: none;' : ''}"
          class="video-container ${this.idToLayout('my-own-stream')}${this._circleView ? '' : ' square-view'}"
          @dblclick=${() => this.toggleMaximized('my-own-stream')}
        >
          ${myActiveReplace
            ? html`
              <div class="module-replace-content">${myActiveReplace.html}</div>
              <video
                muted
                style="display: none;"
                id="my-own-stream"
                class="video-el"
              ></video>
            `
            : html`
              <video
                muted
                style="${this._camera
                  ? ''
                  : 'display: none;'}; transform: scaleX(-1);"
                id="my-own-stream"
                class="video-el"
              ></video>
              <avatar-with-nickname
                .hideNickname=${true}
                .agentPubKey=${this.roomStore.client.client.myPubKey}
                style="width: 35%;${this._camera ? ' display: none;' : ''}"
              ></avatar-with-nickname>
            `}

          <!-- Connection states indicators -->
          ${this._showConnectionDetails
            ? html`<div
                style="display: flex; flex-direction: row; align-items: center; position: absolute; top: 10px; left: 10px; z-index: 10; background: none;"
              >
                ${this.renderAgentConnectionStatuses('my-video')}
              </div>`
            : html``}

          <!-- Module overlays (self) -->
          ${this.renderMyModuleOverlays(myPubKeyB64, myModuleContext)}

          <!-- Icons and Avatar/nickname for circle view (centered, stacked) -->
          ${this._circleView
            ? html`
                <div
                  class="tile-meta"
                  style="display: flex; flex-direction: column; align-items: center; position: absolute; bottom: 10px; left: 50%; transform: translateX(-50%); background: none; white-space: nowrap;"
                >
                  <div class="row" style="margin-bottom: 4px;">
                    <sl-icon
                      title="${this._maximizedVideo === 'my-own-stream'
                        ? 'minimize'
                        : 'maximize'}"
                      .src=${this._maximizedVideo === 'my-own-stream'
                        ? wrapPathInSvg(mdiFullscreenExit)
                        : wrapPathInSvg(mdiFullscreen)}
                      tabindex="0"
                      style="color: #ffe100; height: 30px; width: 30px; cursor: pointer;"
                      @click=${() => {
                        this.toggleMaximized('my-own-stream');
                      }}
                      @keypress=${(e: KeyboardEvent) => {
                        if (e.key === 'Enter') {
                          this.toggleMaximized('my-own-stream');
                        }
                      }}
                    ></sl-icon>
                    ${this.renderMyModuleIconStrip(myPubKeyB64, myModuleContext)}
                  </div>
                  <avatar-with-nickname
                    .size=${36}
                    .hideAvatar=${!this._camera}
                    .agentPubKey=${this.roomStore.client.client.myPubKey}
                    style="height: 36px;"
                  ></avatar-with-nickname>
                </div>
              `
            : html`
                <div
                  class="tile-meta"
                  style="display: flex; flex-direction: row; align-items: center; position: absolute; bottom: 10px; right: 10px; background: none;"
                >
                  ${this.renderMyModuleIconStrip(myPubKeyB64, myModuleContext)}
                  <avatar-with-nickname
                    .size=${36}
                    .agentPubKey=${this.roomStore.client.client.myPubKey}
                    style="height: 36px;"
                  ></avatar-with-nickname>
                  <sl-icon
                    title="${this._maximizedVideo === 'my-own-stream'
                      ? 'minimize'
                      : 'maximize'}"
                    .src=${this._maximizedVideo === 'my-own-stream'
                      ? wrapPathInSvg(mdiFullscreenExit)
                      : wrapPathInSvg(mdiFullscreen)}
                    tabindex="0"
                    style="color: #ffe100; height: 24px; width: 24px; cursor: pointer; margin-left: 4px;"
                    @click=${() => {
                      this.toggleMaximized('my-own-stream');
                    }}
                    @keypress=${(e: KeyboardEvent) => {
                      if (e.key === 'Enter') {
                        this.toggleMaximized('my-own-stream');
                      }
                    }}
                  ></sl-icon>
                </div>
              `}
        </div>
          `;
        })()}

        <!-- Video stream of others -->
        ${repeat(
          Object.entries(this._openConnections.value),
          ([_pubkeyB64, conn]) => conn.connectionId,
          ([pubkeyB64, conn]) => {
            const moduleContext: ModuleRenderContext = {
              isMe: false,
              connected: conn.connected,
              circleView: this._circleView,
              streamsStore: this.streamsStore,
              myPubKeyB64: encodeHashToBase64(this.roomStore.client.client.myPubKey),
              extra: { conn },
            };
            // Determine active replace module for this peer's pane
            const activeReplaceModule = this._getActiveReplaceModule(pubkeyB64, moduleContext);

            return html`
            <div
              class="video-container ${this.idToLayout(conn.connectionId)}${this._circleView ? '' : ' square-view'}"
              @dblclick=${() => this.toggleMaximized(conn.connectionId)}
            >
              <!-- Replace content -->
              ${activeReplaceModule
                ? html`<div class="module-replace-content">${activeReplaceModule.html}</div>`
                : html`
                  <video
                    style="${conn.video ? '' : 'display: none;'}"
                    id="${conn.connectionId}"
                    class="video-el"
                  ></video>
                  <avatar-with-nickname
                    .hideNickname=${true}
                    .agentPubKey=${decodeHashFromBase64(pubkeyB64)}
                    style="width: 35%;${!conn.connected || conn.video ? ' display: none;' : ''}"
                  ></avatar-with-nickname>
                  <div
                    style="color: #b98484; ${conn.connected ? 'display: none' : ''}"
                  >
                    establishing connection...
                  </div>
                  <div
                    style="color: #b9a884; ${conn.connected && !conn.video && conn.videoMuted ? '' : 'display: none'}"
                  >
                    connecting media...
                  </div>
                `}
              <!-- Hidden video element so srcObject assignment still works when a replace module is active -->
              ${activeReplaceModule
                ? html`<video
                    style="display: none;"
                    id="${conn.connectionId}"
                    class="video-el"
                  ></video>`
                : html``}

              <!-- Connection detail statuses (debug) -->
              ${this._showConnectionDetails
                ? html`<div
                    style="display: flex; flex-direction: row; align-items: center; position: absolute; top: 10px; left: 10px; background: none;"
                  >
                    ${this.renderAgentConnectionStatuses('video', pubkeyB64)}
                  </div>`
                : html``}

              <!-- Module overlays -->
              ${this.renderModuleOverlays(pubkeyB64, moduleContext)}

              <!-- Pane chrome: icons + avatar + maximize -->
              ${this._circleView
                ? html`
                    <div
                      class="tile-meta"
                      style="display: flex; flex-direction: column; align-items: center; position: absolute; bottom: 10px; left: 50%; transform: translateX(-50%); background: none; white-space: nowrap;"
                    >
                      <div class="row" style="margin-bottom: 4px;">
                        <sl-icon
                          title="${this._maximizedVideo === conn.connectionId
                            ? 'minimize'
                            : 'maximize'}"
                          .src=${this._maximizedVideo === conn.connectionId
                            ? wrapPathInSvg(mdiFullscreenExit)
                            : wrapPathInSvg(mdiFullscreen)}
                          tabindex="0"
                          style="color: #ffe100; height: 30px; width: 30px; cursor: pointer;"
                          @click=${() => {
                            this.toggleMaximized(conn.connectionId);
                          }}
                          @keypress=${(e: KeyboardEvent) => {
                            if (e.key === 'Enter') {
                              this.toggleMaximized(conn.connectionId);
                            }
                          }}
                        ></sl-icon>
                        ${this.renderModuleIconStrip(pubkeyB64, moduleContext)}
                      </div>
                      <div class="row" style="align-items: center;">
                        <avatar-with-nickname
                          .size=${36}
                          .hideAvatar=${!conn.video}
                          .agentPubKey=${decodeHashFromBase64(pubkeyB64)}
                          style="height: 36px;"
                        ></avatar-with-nickname>
                        ${this.renderModuleSwitcher(pubkeyB64)}
                        ${this._showConnectionDetails
                          ? html`
                              <sl-tooltip
                                content="log stream info"
                                class="tooltip-filled"
                              >
                                <sl-icon-button
                                  src=${wrapPathInSvg(mdiPencilCircleOutline)}
                                  style="margin-bottom: -5px;"
                                  @click=${() => {
                                    const videoEl = this.shadowRoot?.getElementById(
                                      conn.connectionId
                                    ) as HTMLVideoElement;
                                    if (videoEl) {
                                      const stream = videoEl.srcObject;
                                      const tracks = stream
                                        ? (stream as MediaStream).getTracks()
                                        : null;
                                      console.log(
                                        '\nSTREAMINFO:',
                                        stream,
                                        '\nTRACKS: ',
                                        tracks
                                      );
                                      const tracksInfo: any[] = [];
                                      tracks?.forEach(track => {
                                        tracksInfo.push({
                                          kind: track.kind,
                                          enabled: track.enabled,
                                          muted: track.muted,
                                          readyState: track.readyState,
                                        });
                                      });
                                      const streamInfo = stream
                                        ? {
                                            active: (stream as MediaStream).active,
                                          }
                                        : null;
                                      navigator.clipboard.writeText(
                                        JSON.stringify(
                                          { stream: streamInfo, tracks: tracksInfo },
                                          undefined,
                                          2
                                        )
                                      );
                                    }
                                  }}
                                ></sl-icon-button>
                              </sl-tooltip>
                            `
                          : html``}
                      </div>
                    </div>
                  `
                : html`
                    <div
                      class="tile-meta"
                      style="display: flex; flex-direction: row; align-items: center; position: absolute; bottom: 10px; right: 10px; background: none;"
                    >
                      ${this.renderModuleIconStrip(pubkeyB64, moduleContext)}
                      <avatar-with-nickname
                        .size=${36}
                        .agentPubKey=${decodeHashFromBase64(pubkeyB64)}
                        style="height: 36px;"
                      ></avatar-with-nickname>
                      ${this.renderModuleSwitcher(pubkeyB64)}
                      <sl-icon
                        title="${this._maximizedVideo === conn.connectionId
                          ? 'minimize'
                          : 'maximize'}"
                        .src=${this._maximizedVideo === conn.connectionId
                          ? wrapPathInSvg(mdiFullscreenExit)
                          : wrapPathInSvg(mdiFullscreen)}
                        tabindex="0"
                        style="color: #ffe100; height: 24px; width: 24px; cursor: pointer; margin-left: 4px;"
                        @click=${() => {
                          this.toggleMaximized(conn.connectionId);
                        }}
                        @keypress=${(e: KeyboardEvent) => {
                          if (e.key === 'Enter') {
                            this.toggleMaximized(conn.connectionId);
                          }
                        }}
                      ></sl-icon>
                      ${this._showConnectionDetails
                        ? html`
                            <sl-tooltip
                              content="log stream info"
                              class="tooltip-filled"
                            >
                              <sl-icon-button
                                src=${wrapPathInSvg(mdiPencilCircleOutline)}
                                style="margin-bottom: -5px;"
                                @click=${() => {
                                  const videoEl = this.shadowRoot?.getElementById(
                                    conn.connectionId
                                  ) as HTMLVideoElement;
                                  if (videoEl) {
                                    const stream = videoEl.srcObject;
                                    const tracks = stream
                                      ? (stream as MediaStream).getTracks()
                                      : null;
                                    console.log(
                                      '\nSTREAMINFO:',
                                      stream,
                                      '\nTRACKS: ',
                                      tracks
                                    );
                                    const tracksInfo: any[] = [];
                                    tracks?.forEach(track => {
                                      tracksInfo.push({
                                        kind: track.kind,
                                        enabled: track.enabled,
                                        muted: track.muted,
                                        readyState: track.readyState,
                                      });
                                    });
                                    const streamInfo = stream
                                      ? {
                                          active: (stream as MediaStream).active,
                                        }
                                      : null;
                                    navigator.clipboard.writeText(
                                      JSON.stringify(
                                        { stream: streamInfo, tracks: tracksInfo },
                                        undefined,
                                        2
                                      )
                                    );
                                  }
                                }}
                              ></sl-icon-button>
                            </sl-tooltip>
                          `
                        : html``}
                    </div>
                  `}
            </div>
          `}
        )}
        </div>
      </div>
      ${this.renderToggles()}
      ${this._showAttachmentsPanel ? this.renderAttachmentPanel() : undefined}
      ${this._showAttachmentsPanel ? undefined : this.renderAttachmentButton()}
      ${this._maximizedVideo ? html`` : this.renderConnectionDetailsToggle()}

      <div
        class="error-message secondary-font"
        style="${this._displayError ? '' : 'display: none;'}"
      >
        ${this._displayError}
      </div>
      <div
        class="stop-share"
        tabindex="0"
        style="${this.streamsStore.screenShareStream ? '' : 'display: none'}"
        @click=${async () => this.streamsStore.screenShareOff()}
        @keypress=${async (e: KeyboardEvent) => {
          if (e.key === 'Enter') {
            await this.streamsStore.screenShareOff();
          }
        }}
      >
        ${msg('Stop Screen Share')}
      </div>
      <div
        class="stop-share"
        tabindex="0"
        style="${this._mySharedWal.value ? '' : 'display: none'}"
        @click=${async () => this.streamsStore.stopShareWal()}
        @keypress=${async (e: KeyboardEvent) => {
          if (e.key === 'Enter') {
            await this.streamsStore.stopShareWal();
          }
        }}
      >
        ${msg('Stop Sharing Asset')}${this._mySharedWal.value?.assetName ? ` — ${this._mySharedWal.value.assetName}` : ''}
      </div>
    `;
  }

  static styles = [
    sharedStyles,
    css`
      main {
        flex-grow: 1;
        margin: 0;
        background: #2b304a;
      }

      .attachment-panel {
        position: absolute;
        top: 0;
        bottom: 94px;
        right: 0;
        width: 400px;
        background: linear-gradient(
          #6f7599c4,
          #6f7599c4 80%,
          #6f759979 90%,
          #6f759900
        );
        /* background: #6f7599; */
      }

      .sidepanel-tabs {
        width: 100%;
        align-items: center;
        margin-top: 10px;
        /* #ffffff80 */
      }

      .sidepanel-tab {
        width: 50%;
        height: 40px;
        /* background: #ffffff10; */
        background: linear-gradient(#6f7599c4, #6f759900);
        cursor: pointer;
        font-size: 24px;
        color: #0d1543;
        font-weight: 600;
        padding-top: 4px;
      }

      .sidepanel-tab:hover {
        /* background: #ffffff80; */
        background: linear-gradient(#c6d2ff87, #6f759900);
      }

      .tab-selected {
        /* background: #ffffff80; */
        background: linear-gradient(#c6d2ff87, #6f759900);
      }

      .attachments-list {
        justify-content: flex-start;
        align-items: flex-start;
        overflow-y: auto;
        position: absolute;
        top: 45px;
        bottom: 5px;
        width: 376px;
        padding: 2px;
      }

      .attachments-list::-webkit-scrollbar {
        display: none;
      }

      .close-panel {
        /* background: linear-gradient(-90deg, #2f3052, #6f7599c4); */
        color: #0d1543;
        font-weight: bold;
        width: 400px;
        height: 40px;
        justify-content: flex-end;
        align-items: center;
        /* font-family: 'Ubuntu', sans-serif; */
        font-size: 22px;
      }

      .close-btn {
        cursor: pointer;
      }

      .close-btn:hover {
        color: #c3c9eb;
        /* background: linear-gradient(-90deg, #a0a1cb, #6f7599c4); */
      }

      .add-attachment-btn {
        all: unset;
        text-align: center;
        color: #c3c9eb;
        /* font-family: 'Baloo 2 Variable', sans-serif; */
        /* font-family: 'Ubuntu'; */
        font-size: 22px;
        cursor: pointer;
        margin-bottom: 15px;
        font-weight: 600;
      }

      .add-attachment-btn:hover {
        color: white;
      }

      .add-attachment-btn:focus {
        color: white;
      }

      .divider {
        height: 1px;
        border: 0;
        width: 380px;
        background: #0d1543;
        margin: 0 0 5px 0;
      }

      .connectivity-title {
        font-style: italic;
        font-weight: bold;
        font-size: 16px;
        margin-bottom: -3px;
        color: #0d1543;
      }

      .room-name {
        position: absolute;
        bottom: 5px;
        left: 15px;
        color: #6f7599;
      }

      .toggle-switch-container {
        position: absolute;
        top: 10px;
        left: 10px;
        color: #c3c9eb;
        font-size: 20px;
      }

      .toggle-switch {
        opacity: 0.6;
      }

      /* .toggle-switch:hover {
        opacity: 1;
      } */

      .active {
        opacity: 1;
      }

      .attachments-btn {
        position: absolute;
        top: 10px;
        right: 10px;
        /* background: #c3c9eb; */
        background: linear-gradient(#c3c9ebd6, #a7b0dfd6);
        opacity: 0.8;
        font-weight: 500;
        border-radius: 20px;
        font-family: 'Baloo 2 Variable', sans-serif;
        font-size: 24px;
        padding: 3px 10px;
        cursor: pointer;
        box-shadow: 0px 0px 5px 2px #0b0f28;
      }

      .attachments-btn:hover {
        /* background: #dbdff9; */
        background: linear-gradient(#c3c9eb, #a7b0df);
      }

      .attachments-btn:focus {
        /* background: #dbdff9; */
        background: linear-gradient(#d4d9f3, #bac2e9);
      }

      .stop-share {
        display: flex;
        flex-direction: row;
        align-items: center;
        justify-content: center;
        padding: 6px 10px;
        position: absolute;
        top: 10px;
        left: 0;
        right: 0;
        margin-left: auto;
        margin-right: auto;
        width: 300px;
        color: white;
        background: #b60606;
        border-radius: 10px;
        font-family: sans-serif;
        font-size: 20px;
        font-weight: bold;
        box-shadow: 0 0 2px white;
        z-index: 1;
        cursor: pointer;
      }

      .stop-share:hover {
        background: #fd5959;
      }

      .stop-share:focus-visible {
        background: #fd5959;
      }

      .shared-wal-container {
        display: flex;
        flex-direction: column;
        width: 100%;
        flex: 1;
        min-height: 150px;
        position: relative;
      }

      .shared-wal-footer {
        display: flex;
        flex-direction: row;
        align-items: center;
        position: absolute;
        bottom: 10px;
        right: 10px;
        background: none;
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

      .videos-container {
        display: flex;
        flex: 1;
        flex-direction: row;
        align-items: center;
        justify-content: center;
        flex-wrap: wrap;
        width: 100vw;
        min-height: 100vh;
        margin: 0;
        align-content: center;
        position: relative;
      }

      .video-container {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        position: relative;
        aspect-ratio: 1 / 1;
        border-radius: 50%;
        border: 2px solid #7291c9;
        margin: 5px;
        overflow: hidden;
        background: black;
        user-select: none;
        -webkit-user-select: none;
        container-type: inline-size;
      }

      .video-container:not(.square-view):not(.screen-share) {
        overflow: visible;
      }

      .module-replace-content {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        border-radius: inherit;
        overflow: hidden;
        z-index: 1;
      }

      .module-icon-strip {
        display: flex;
        flex-direction: row;
        align-items: center;
        gap: 8px;
      }

      .tile-meta {
        z-index: 3;
      }

      .maximize-icon {
        z-index: 3;
      }

      /* Hide overlay icons and names when tile is small */
      @container (max-width: 200px) {
        .tile-meta {
          display: none !important;
        }
        .maximize-icon {
          display: none !important;
        }
      }

      .video-container:not(.square-view):not(.screen-share) .video-el {
        border-radius: 50%;
      }

      .video-container.square-view {
        aspect-ratio: 16 / 9;
        border-radius: 20px;
      }

      .maximized {
        height: 100vh;
        width: 100vw;
        margin: 0;
      }

      .video-container.screen-share.maximized {
        width: 100vw;
        min-width: 100vw;
      }

      .maximize-icon {
        position: absolute;
        bottom: 5px;
        left: 5px;
        /* color: #facece; */
        color: #ffe100;
        height: 40px;
        width: 40px;
        cursor: pointer;
      }

      .maximize-icon:hover {
        color: #ffe100;
        transform: scale(1.2);
      }

      .maximize-icon:focus-visible {
        color: #ffe100;
        transform: scale(1.2);
      }

      .hidden {
        display: none;
      }

      .video-container.screen-share {
        aspect-ratio: auto;
      }

      .shared-panel-frame {
        border: 4px solid #ffe100 !important;
        border-radius: 20px !important;
        overflow: hidden;
        box-sizing: border-box;
        background: black;
        margin: 0 !important;
      }

      .video-container.screen-share .video-el {
        object-fit: contain;
      }

      /* Split-mode layout for screen shares */
      .videos-container.split-mode {
        flex-wrap: nowrap;
        align-items: stretch;
        padding-top: 5px;
        padding-bottom: 5px;
        box-sizing: border-box;
      }
      @media (min-aspect-ratio: 1/1) {
        .videos-container.split-mode { flex-direction: row; }
      }
      @media (max-aspect-ratio: 1/1) {
        .videos-container.split-mode {
          flex-direction: column;
          height: 100vh;
        }
      }

      .screen-share-panel, .people-panel {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: center;
        align-content: center;
        overflow: hidden;
        container-type: size;
      }

      .screen-share-panel {
        position: static;
        min-width: 0;
        min-height: 0;
        padding-top: 50px;
        box-sizing: border-box;
        flex-direction: column;
        flex-wrap: nowrap;
        align-items: stretch;
      }

      /* When not in split mode (e.g. maximized), fill the viewport.
         Avoid display:contents which destroys video rendering context on transition. */
      .videos-container:not(.split-mode) .screen-share-panel {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        padding-top: 0;
        z-index: 2;
      }

      .people-panel {
        flex: 1;
        padding: 3px;
      }
      @media (min-aspect-ratio: 1/1) {
        .people-panel {
          min-width: 50px;
          min-height: 0;
          align-content: center;
          padding-bottom: 90px;
        }
      }
      @media (max-aspect-ratio: 1/1) {
        .people-panel {
          min-height: 100px;
          min-width: 0;
          align-content: flex-start;
        }
      }

      .people-panel .video-container {
        margin: 2px;
      }

      .layout-transparent {
        display: contents;
      }

      .resize-overlay {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        z-index: 100;
        cursor: col-resize;
      }

      .resize-handle {
        flex-shrink: 0;
        background: #4a5568;
        z-index: 10;
      }
      .resize-handle:hover {
        background: #667eea;
      }
      @media (min-aspect-ratio: 1/1) {
        .resize-handle { width: 6px; cursor: col-resize; }
      }
      @media (max-aspect-ratio: 1/1) {
        .resize-handle { height: 6px; cursor: row-resize; }
      }

      .video-el {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }

      .identicon canvas {
        width: 180px;
        height: 180px;
      }

      .single {
        height: min(98vh, 100%);
        width: min(98vw, 100%);
        max-height: 98vh;
        border: none;
      }

      .double {
        width: min(48.5%, 48.5vw);
        min-width: max(50px, 48.5vw);
      }

      .triplett {
        width: min(48.5%, 48.5vw, 84vh);
        min-width: min(84vh, max(50px, 48.5vw));
      }

      .quartett {
        width: min(48.5%, 48.5vw, 84vh);
        min-width: min(84vh, max(50px, 48.5vw));
      }

      .sextett {
        width: min(32.5%, 32.5vw);
        min-width: max(50px, 32.5vw);
      }

      .octett {
        width: min(32.5%, 32.5vw, 55vh);
        min-width: min(55vh, max(50px, 32.5vw));
      }

      .unlimited {
        width: min(24%, 24vw, 42vh);
        min-width: min(42vh, max(50px, 24vw));
      }

      /* Circle mode: 1:1 aspect ratio means height = width, so use
         tighter vh constraints to prevent vertical overflow.
         Triplett uses max(min(),min()) to auto-pick the better layout:
         wide viewport -> 3-per-row (32vw), square/tall -> 2+1 (47vh) */
      .video-container:not(.square-view):not(.screen-share).triplett {
        width: max(min(32%, 32vw, 95vh), min(48.5%, 48.5vw, 47vh));
        min-width: max(50px, min(32vw, 95vh), min(48.5vw, 47vh));
      }

      .video-container:not(.square-view):not(.screen-share).quartett {
        width: min(48.5%, 48.5vw, 47vh);
        min-width: min(47vh, max(50px, 48.5vw));
      }

      .video-container:not(.square-view):not(.screen-share).sextett {
        width: min(32.5%, 32.5vw, 47vh);
        min-width: min(47vh, max(50px, 32.5vw));
      }

      .video-container:not(.square-view):not(.screen-share).octett {
        width: min(32.5%, 32.5vw, 31vh);
        min-width: min(31vh, max(50px, 32.5vw));
      }

      .video-container:not(.square-view):not(.screen-share).unlimited {
        width: min(24%, 24vw, 23vh);
        min-width: min(23vh, max(50px, 24vw));
      }

      /* People panel: use container query units so videos size
         relative to the panel, not the full viewport.
         Tiles use reduced margins (2px) inside the panel, so
         percentage widths fit tightly with minimal gaps. */
      .people-panel .single {
        height: min(98cqh, 100%);
        width: min(98cqw, 100%);
        max-height: 98cqh;
      }
      .people-panel .double {
        width: min(98%, 98cqw);
        min-width: 0;
        max-height: 49cqh;
      }
      .people-panel .triplett {
        width: min(98%, 98cqw);
        min-width: 0;
        max-height: 32cqh;
      }
      .people-panel .quartett {
        width: min(49%, 49cqw);
        min-width: 0;
        max-height: 49cqh;
      }
      .people-panel .sextett {
        width: min(49%, 49cqw);
        min-width: 0;
        max-height: 32cqh;
      }
      .people-panel .octett {
        width: min(49%, 49cqw);
        min-width: 0;
        max-height: 24cqh;
      }
      .people-panel .unlimited {
        width: min(32%, 32cqw);
        min-width: 0;
        max-height: 24cqh;
      }

      /* Screen share panel: screen shares are 16:9, so stack vertically
         for 2 (full width, 49% height each) to maximize visible area.
         For 3+, use a grid that constrains both dimensions. */
      .screen-share-panel > * {
        flex: 1;
        min-height: 0;
        width: 100%;
      }

      .screen-share-panel .single {
        height: min(98cqh, 100%);
        //width: min(98cqw, 100%);
        max-height: 98cqh;
      }
      .screen-share-panel .double {
        width: 100%;
        min-width: 0;
        max-height: 49cqh;
      }
      .screen-share-panel .triplett,
      .screen-share-panel .quartett {
        width: min(49%, 49cqw);
        min-width: 0;
        max-height: 49cqh;
      }
      .screen-share-panel .sextett {
        width: min(32%, 32cqw);
        min-width: 0;
        max-height: 49cqh;
      }
      .screen-share-panel .octett {
        width: min(32%, 32cqw);
        min-width: 0;
        max-height: 32cqh;
      }
      .screen-share-panel .unlimited {
        width: min(24%, 24cqw);
        min-width: 0;
        max-height: 32cqh;
      }

      /* People panel circle-mode: constrain width by height so
         containers stay roughly square for circular video rendering.
         min-width: 0 is critical here — the base circle-mode styles
         (e.g. .video-container:not(.square-view):not(.screen-share).quartett)
         have specificity 0-4-0 and set min-width using viewport units.
         The .people-panel .quartett override (0-2-0) can't beat that,
         so we must reset min-width here at 0-6-0 specificity. */
      .people-panel .video-container:not(.square-view):not(.screen-share).double {
        width: min(98cqw, 47cqh);
        min-width: 0;
      }
      .people-panel .video-container:not(.square-view):not(.screen-share).triplett {
        width: min(98cqw, 31cqh);
        min-width: 0;
      }
      .people-panel .video-container:not(.square-view):not(.screen-share).quartett {
        width: min(49cqw, 47cqh);
        min-width: 0;
      }
      .people-panel .video-container:not(.square-view):not(.screen-share).sextett {
        width: min(49cqw, 31cqh);
        min-width: 0;
      }
      .people-panel .video-container:not(.square-view):not(.screen-share).octett {
        width: min(49cqw, 24cqh);
        min-width: 0;
      }
      .people-panel .video-container:not(.square-view):not(.screen-share).unlimited {
        width: min(32cqw, 24cqh);
        min-width: 0;
      }

      .btn-stop {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        background: #9c0f0f;
        margin: 0 5px;
        border-radius: 50%;
        height: 60px;
        width: 60px;
        cursor: pointer;
      }

      .btn-stop:hover {
        background: #dc4a4a;
      }

      .stop-icon {
        height: 23px;
        width: 23px;
        border-radius: 3px;
        background: #eba6a6;
      }

      .toggle-btn-icon {
        height: 40px;
        width: 40px;
        /* color: #e7d9aa; */
        color: #facece;
      }

      .btn-icon-off {
        color: #6482c9;
      }

      .toggle-btn {
        position: relative;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        background: #17529f;
        margin: 0 5px;
        border-radius: 50%;
        height: 60px;
        width: 60px;
        cursor: pointer;
      }

      .toggle-sub-btn {
        background: #22365c;
        border-radius: 50%;
        width: 16px;
        height: 16px;
        position: absolute;
        bottom: 0px;
        right: 0px;
        border: 3px solid #0e142c;
        color: #6482c9;
      }

      .toggle-sub-btn:hover {
        background: #17529f;
      }

      .btn-off {
        background: #22365c;
      }

      .audio-input-sources {
        position: absolute;
        align-items: flex-start;
        bottom: 20px;
        left: calc(100% - 20px);
        z-index: 1;
        background: #0e142c;
        border-radius: 8px;
        font-size: 15px;
        width: 170px;
        padding: 6px;
        cursor: default;
      }

      .input-source-title {
        text-align: right;
        width: 100%;
        font-size: 12px;
        color: white;
        margin-top: -3px;
        color: #a4c3ff;
      }

      .audio-source {
        width: calc(100% - 6px);
        flex: 1;
        align-items: flex-start;
        text-align: left;
        padding: 3px;
        border-radius: 5px;
        cursor: pointer;
      }

      .audio-source:hover {
        background: #263368;
      }

      /*
      .toggle-btn:hover {
        background: #17529f;
      }

      .toggle-btn:hover:not(.btn-off) {
        background: #22365c;
      }
      */

      .toggles-panel {
        display: flex;
        flex-direction: row;
        align-items: center;
        justify-content: center;
        position: fixed;
        font-size: 19px;
        bottom: 10px;
        right: 10px;
        padding: 0 12px;
        height: 74px;
        border-radius: 37px;
        background: #0e142c;
        color: #facece;
        box-shadow: 0 0 3px 2px #050b21;
        /* left: calc(50% - 150px); */
      }

      .close-graph-btn {
        all: unset;
        border-radius: 50%;
        height: 60px;
        width: 60px;
        background: #d8d7f3;
        z-index: 10;
        cursor: pointer;
      }

      .close-graph-btn:hover {
        background: #bdbbf2;
      }

      .logs-graph-btn {
        all: unset;
        padding: 5px 10px;
        background: #d8d7f3;
        cursor: pointer;
        border-radius: 8px;
      }

      .logs-graph-btn:hover {
        background: #bdbbf2;
      }

      .custom-log-dialog {
        display: flex;
        align-items: center;
        justify-content: center;
        position: fixed;
        top: 0;
        right: 0;
        bottom: 0;
        left: 0;
        z-index: 20;
      }

      .custom-log-dialog .panel {
        background: white;
        padding: 30px;
        border-radius: 10px;
        box-shadow: 0 0 2px 2px #c3c3c3;
      }

      sl-icon-button::part(base) {
        color: #24d800;
      }
      sl-icon-button::part(base):hover,
      sl-icon-button::part(base):focus {
        color: #8dff76;
      }
      sl-icon-button::part(base):active {
        color: #8dff76;
      }

      .tooltip-filled {
        --sl-tooltip-background-color: #c3c9eb;
        --sl-tooltip-arrow-size: 6px;
        --sl-tooltip-border-radius: 5px;
        --sl-tooltip-padding: 4px;
        --sl-tooltip-font-size: 14px;
        --sl-tooltip-color: #0d1543;
        --sl-tooltip-font-family: 'Ubuntu', sans-serif;
      }

      .reconnect-menu {
        background: #0e142c;
        border-radius: 8px;
        padding: 4px 0;
        font-size: 15px;
        color: #c3c9eb;
      }

      .reconnect-menu-item::part(base) {
        font-size: 14px;
        color: #c3c9eb;
        padding: 2px 10px;
      }

      .reconnect-menu-item::part(base):hover {
        background: #263368;
        color: white;
      }

      /* sl dialog styles below */
      sl-dialog::part(panel) {
        background: white;
        min-width: 600px;
      }
    `,
  ];
}

function streamAndTrackInfoToColor(
  info: StreamAndTrackInfo | undefined,
  kind: 'audio' | 'video'
): string {
  if (!info || !info.stream) return 'gray';
  const track = info.tracks.find(track => track.kind === kind);
  if (!track) return 'gray';
  if (track && !track.muted) return '#0886e7';
  if (track && track.muted) return '#e7bb08';
  return 'white';
}

function streamAndTrackInfoToText(
  info: StreamAndTrackInfo | undefined,
  kind: 'audio' | 'video'
): string | undefined {
  if (!info || !info.stream) return `No ${kind} WebRTC track`;
  const track = info.tracks.find(track => track.kind === kind);
  if (!track) return `No ${kind} WebRTC track`;
  if (track && !track.muted) return `${kind} WebRTC track in state 1`;
  if (track && track.muted) return `${kind} WebRTC track in state 2`;
  return `Unusual ${kind} WebRTC track state: ${track}`;
}

function streamInfoToTrackStatus(
  info: StreamAndTrackInfo | undefined,
  kind: 'audio' | 'video'
): 'on' | 'muted' | 'off' {
  if (!info || !info.stream) return 'off';
  const track = info.tracks.find(t => t.kind === kind);
  if (!track) return 'off';
  return track.muted ? 'muted' : 'on';
}

function deviceLabel(label: string): string {
  if (label === 'Default') return 'System Default';
  return label;
}
