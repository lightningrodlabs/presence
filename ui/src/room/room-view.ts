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
  mdiChartLine,
  mdiChevronUp,
  mdiClose,
  mdiCog,
  mdiFullscreen,
  mdiFullscreenExit,
  mdiLock,
  mdiMicrophone,
  mdiMicrophoneOff,
  mdiMinus,
  mdiNoteEditOutline,
  mdiCubeOutline,
  mdiPaperclip,
  mdiPhoneHangup,
  mdiPencilCircleOutline,
  mdiHub,
  mdiCloudDownloadOutline,
  mdiVideo,
  mdiVideoOff,
  mdiSwapHorizontal,
} from '@mdi/js';
import { wrapPathInSvg } from '@holochain-open-dev/elements';
import { localized, msg } from '@lit/localize';
import { consume } from '@lit/context';
import { repeat } from 'lit/directives/repeat.js';
import { html as staticHtml, unsafeStatic } from 'lit/static-html.js';

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
import './elements/audio-level-meter';
import './elements/peer-stats-panel';
import './elements/peer-filmstrip';
import './elements/toggle-switch';
import {
  filmstripController,
  FILMSTRIP_FPS_OPTIONS,
  FILMSTRIP_CAPTURE_SIZES,
  FilmstripFps,
  FilmstripCaptureSize,
} from './modules/video-filmstrip';
import './logs-graph';
import { downloadJson, formattedDate, sortConnectionStatuses } from '../utils';
import { PING_INTERVAL, StreamsStore } from '../streams-store';
import { AgentInfo, ConnectionStatuses, ModuleStateEnvelope, OpenConnectionInfo } from '../types';
import { getAllModules, getModule, getShareModules } from './modules/registry';
import type { ModuleIconDefinition, ModuleRenderContext } from './modules/types';
import { MY_OWN_SCREEN_VIDEO_ID, peerScreenVideoId } from './modules/screen-share';
import './modules'; // side-effect: registers all modules
import {
  bestColumns,
  GRID_MIN_TILE_WIDTH,
  GRID_TOOLBAR_RESERVE,
} from './layout';

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

  _activeAgents = new StoreSubscriber(
    this,
    () => this.streamsStore._activeAgents,
    () => [this.streamsStore]
  );

  _receivedDiagnosticLogs = new StoreSubscriber(
    this,
    () => this.streamsStore._receivedDiagnosticLogs,
    () => [this.streamsStore]
  );

  _pendingDiagnosticRequests = new StoreSubscriber(
    this,
    () => this.streamsStore._pendingDiagnosticRequests,
    () => [this.streamsStore]
  );

  _failedDiagnosticRequests = new StoreSubscriber(
    this,
    () => this.streamsStore._failedDiagnosticRequests,
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

  /**
   * Set of peers currently displaying a filmstrip clip. Updated by
   * peer-filmstrip's onActiveChange callback. Used to hide the avatar
   * behind the filmstrip while video is flowing — without this, any
   * transparent moment in the bg-image swap lets the avatar flash
   * through, especially noticeable cross-machine.
   */
  @state()
  _filmstripActivePeers: Set<string> = new Set();

  private _onFilmstripActive(peerB64: string, active: boolean): void {
    const next = new Set(this._filmstripActivePeers);
    if (active) next.add(peerB64);
    else next.delete(peerB64);
    if (next.size !== this._filmstripActivePeers.size) {
      this._filmstripActivePeers = next;
    }
  }

  @state()
  _displayError: string | undefined;

  @state()
  _joinAudio = new Audio('doorbell.mp3');

  @state()
  _leaveAudio = new Audio('percussive-drum-hit.mp3');

  @state()
  _reconnectAudio = new Audio('old-phone-ring-connect.mp3#t=0,3.5');

  /** Tracks the previous set of active agent pubkeys for diffing.
   * Used to detect signal-level presence changes (agent appear/disappear)
   * and play join/leave sounds, independent of WebRTC state. */
  private _prevActiveAgentKeys = new Set<string>();
  private _activeAgentsUnsubscribe: (() => void) | null = null;

  @state()
  _showAttachmentsPanel = false;

  @state()
  _showAudioSources = false;

  @state()
  _showVideoSources = false;

  @state()
  _showViewSettings = false;

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

  // Area-maximizing grid shape for the simple people grid. JS only picks the
  // column/row count (which depends on the container's aspect ratio, robust to
  // absolute-measurement error inside the nested iframe). Actual tile sizing is
  // done in CSS with container-query units so tiles can never overflow their
  // box. 0 columns = inactive (split / maximized / single-tile mode).
  @state()
  _gridCols = 0;

  @state()
  _gridRows = 0;

  private _onWindowResize = () => this._updateGrid();

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
    if (this._showViewSettings) {
      this._showViewSettings = false;
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
    this.streamsStore.disconnect();
    this.streamsStore.logger.endSession();
    this.dispatchEvent(
      new CustomEvent('quit-room', { bubbles: true, composed: true })
    );
  }

  async firstUpdated() {
    this.addEventListener('click', this.sideClickListener);
    document.addEventListener('keydown', this.keyDownListener);
    window.addEventListener('resize', this._onWindowResize);
    this._updateGrid();
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
            MY_OWN_SCREEN_VIDEO_ID
          ) as HTMLVideoElement;
          if (myScreenVideo) {
            myScreenVideo.autoplay = true;
            myScreenVideo.srcObject = this.streamsStore.screenShareStream!;
          }
          break;
        }
        case 'my-screen-share-off': {
          if (this._maximizedVideo === MY_OWN_SCREEN_VIDEO_ID) {
            this._maximizedVideo = undefined;
          }
          break;
        }
        case 'peer-connected': {
          // Join sound now plays on signal-level presence (agent appears
          // in _activeAgents), not on WebRTC connection establishment.
          break;
        }
        case 'peer-disconnected': {
          // WebRTC disconnect only — pane persists via _activeAgents.
          // No audio or maximize clear needed.
          break;
        }
        case 'peer-leave': {
          // Agent left the room — clear maximize if they were maximized.
          // Leave sound now plays on signal-level presence (agent
          // disappears from _activeAgents), not here.
          if (this._maximizedVideo === event.pubKeyB64) {
            this._maximizedVideo = undefined;
          }
          break;
        }
        case 'peer-stream': {
          // We want to make sure that the video element is actually in the DOM
          // so we add a timeout here.
          setTimeout(() => {
            const videoEl = this.shadowRoot?.getElementById(
              `video-${event.pubKeyB64}`
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
              peerScreenVideoId(event.pubKeyB64)
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
          // Maximize is now keyed by share-${moduleId}-${pubkey}, not connectionId.
          // Clear maximize if this peer's screen share was maximized.
          if (this._maximizedVideo === `share-screen-share-${event.pubKeyB64}`) {
            this._maximizedVideo = undefined;
          }
          break;
        }
        default:
          break;
      }
    });
    this._leaveAudio.volume = 0.05;
    this._joinAudio.volume = 0.07;
    this._reconnectAudio.volume = 0.1;

    // Subscribe to signal-level presence changes. Play join/leave sounds
    // when agents appear/disappear in _activeAgents (driven by ping/pong),
    // independent of WebRTC connection state. This means the user hears
    // someone arrive the moment their pong lands, not when (or if) WebRTC
    // establishes.
    this._activeAgentsUnsubscribe = this.streamsStore._activeAgents.subscribe(
      agents => {
        const currentKeys = new Set(Object.keys(agents));
        for (const key of currentKeys) {
          if (!this._prevActiveAgentKeys.has(key)) {
            this._joinAudio.play().catch(() => {});
          }
        }
        for (const key of this._prevActiveAgentKeys) {
          if (!currentKeys.has(key)) {
            this._leaveAudio.play().catch(() => {});
          }
        }
        this._prevActiveAgentKeys = currentKeys;
      }
    );

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

    // Auto-activate modules that should be on by default.
    // The conversation module is always active — it owns mic/video state
    // and carrier routing. The global WebRTC kill switch is a separate
    // flag (webrtcGloballyDisabled) that suppresses WebRTC initiation
    // without deactivating the module.
    this.streamsStore.activateModule('conversation');
    this.streamsStore.activateModule('reactions');
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
    await this.streamsStore.activateModule('wal', JSON.stringify(payload));
  }

  async stopShareWal() {
    await this.streamsStore.deactivateModule('wal');
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
    // Re-apply video srcObjects after maximize/minimize, which destroys video
    // rendering context via the display:contents transition.
    if (changedProperties.has('_maximizedVideo')) {
      setTimeout(() => this._reapplyVideoStreams(), 50);
    }
    this._updateGrid();
  }

  /**
   * Recompute the area-maximizing grid shape (columns/rows) for the simple
   * people grid. Split mode (screen share) and maximized mode keep their own
   * layouts. Setting state only when it changes avoids re-render loops.
   */
  private _updateGrid() {
    if (this._maximizedVideo || this._getActiveShares().length > 0) {
      this._setGrid(0, 0);
      return;
    }
    const container = this.shadowRoot?.querySelector(
      '.videos-container'
    ) as HTMLElement | null;
    if (!container) return;
    // Measure only to derive the container's aspect ratio (W/H), which is all
    // the column choice needs. We do NOT use these as pixel sizes — inside the
    // nested iframe the absolute values don't reliably match the visible pane,
    // so CSS sizes the tiles in container-query units against the real box.
    const doc = document.documentElement;
    const W = doc.clientWidth;
    const headerHeight = Math.max(
      0,
      container.getBoundingClientRect().top + window.scrollY
    );
    const H = Math.max(0, doc.clientHeight - headerHeight - GRID_TOOLBAR_RESERVE);

    // Count tiles actually laid out: peers + phantoms + own (unless hidden,
    // in which case it is display:none and takes no grid slot).
    const phantomCount = this.streamsStore.phantomAgents().length;
    let n = Object.keys(this._activeAgents.value).length + phantomCount;
    if (!this._selfViewHidden) n += 1;

    // A lone tile keeps the existing fill-the-viewport behavior (.single),
    // which sets an explicit height; pinning width too would break it.
    if (n <= 1) {
      this._setGrid(0, 0);
      return;
    }

    // Circle tiles are 1:1, rectangle tiles are 16:9 — this changes which
    // column count maximizes area, so it must feed the computation.
    const aspect = this._circleView ? 1 : 16 / 9;
    const cols = bestColumns(W, H, n, aspect);
    this._setGrid(cols, Math.ceil(n / cols));
  }

  // Update grid shape state, only writing when changed to avoid re-render loops.
  private _setGrid(cols: number, rows: number) {
    if (cols !== this._gridCols) this._gridCols = cols;
    if (rows !== this._gridRows) this._gridRows = rows;
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
      this.shadowRoot?.getElementById(MY_OWN_SCREEN_VIDEO_ID) as HTMLVideoElement | null,
      this.streamsStore.screenShareStream,
    );

    // Own camera
    restoreVideo(
      this.shadowRoot?.getElementById('my-own-stream') as HTMLVideoElement | null,
      this.streamsStore.mainStream,
    );

    // Peer screen shares
    for (const [pubkeyB64] of Object.entries(this._screenShareConnectionsIncoming.value)) {
      restoreVideo(
        this.shadowRoot?.getElementById(peerScreenVideoId(pubkeyB64)) as HTMLVideoElement | null,
        this.streamsStore._screenShareStreams[pubkeyB64],
      );
    }

    // Peer video streams
    for (const [pubkeyB64] of Object.entries(this._openConnections.value)) {
      restoreVideo(
        this.shadowRoot?.getElementById(`video-${pubkeyB64}`) as HTMLVideoElement | null,
        this.streamsStore._videoStreams[pubkeyB64],
      );
    }
  }

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
    window.removeEventListener('resize', this._onWindowResize);
    if (this._unsubscribe) this._unsubscribe();
    if (this._activeAgentsUnsubscribe) this._activeAgentsUnsubscribe();
    this.removeEventListener('click', this.sideClickListener);
    this.streamsStore.disconnect();
  }

  idToLayout(id: string, isShared: boolean = false) {
    if (id === this._maximizedVideo) return 'maximized';
    if (this._maximizedVideo) return 'hidden';
    const activeShareCount = this._getActiveShares().length;
    const hasShared = activeShareCount > 0;

    // Phantom tiles (reported-by-others but not connected to us) render
    // alongside active tiles in the same grid and must be counted toward
    // layout sizing. Without this the layout class is computed for fewer
    // tiles than actually render, and every tile is oversized.
    const phantomCount = this.streamsStore.phantomAgents().length;
    const videoOnlyCount =
      Object.keys(this._activeAgents.value).length + 1 + phantomCount;
    const totalCount = videoOnlyCount + activeShareCount;

    // In split mode, size items based on their panel's count
    const num = isShared
      ? activeShareCount
      : hasShared
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
      <div class="row toggle-switch-container" style="align-items: center; gap: 16px;">
        <div class="row" style="align-items: center;">
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
        ${this._showConnectionDetails
          ? this._renderCarrierSelector()
          : html``}
      </div>
    `;
  }

  /**
   * 3-way carrier selector. Collapses the previous "Disable all WebRTC" +
   * "Use FSM transport" toggles into a single control. Symmetric union
   * still applies on the wire — picking 'fsm' here makes any peer with us
   * also use FSM.
   */
  private _renderCarrierSelector() {
    const mode = this.streamsStore.carrierMode();
    const options: Array<{
      value: 'simplepeer' | 'fsm' | 'signals';
      label: string;
      color: string;
      title: string;
    }> = [
      {
        value: 'simplepeer',
        label: 'WebRTC (SP)',
        color: '#7adc7a',
        title: 'WebRTC via simple-peer (default)',
      },
      {
        value: 'fsm',
        label: 'WebRTC (FSM)',
        color: '#7adc7a',
        title: 'WebRTC via perfect-negotiation FSM',
      },
      {
        value: 'signals',
        label: 'Signals',
        color: '#e7a008',
        title: 'No WebRTC — audio (Opus) and low-bandwidth video (JPEG filmstrip) flow via Holochain remote signals',
      },
    ];
    const currentFps = filmstripController.getFps();
    const currentSize = filmstripController.getCaptureSide();
    return html`
      <div class="row" style="align-items: center; gap: 8px; flex-wrap: wrap;">
        <span class="secondary-font" style="opacity: 0.7;">Carrier:</span>
        ${options.map(opt => {
          const active = mode === opt.value;
          return html`
            <button
              class="secondary-font"
              title=${opt.title}
              style="
                cursor: pointer;
                padding: 3px 10px;
                border-radius: 4px;
                border: 1px solid ${active ? opt.color : 'rgba(255,255,255,0.15)'};
                background: ${active ? `${opt.color}22` : 'transparent'};
                color: ${active ? opt.color : '#c3c9eb'};
                opacity: ${active ? 1 : 0.7};
                font-weight: ${active ? 600 : 400};
              "
              @click=${async (e: Event) => {
                e.stopPropagation();
                if (active) return;
                await this.streamsStore.setCarrierMode(opt.value);
                this.requestUpdate();
              }}
            >${opt.label}</button>
          `;
        })}
        <span
          class="secondary-font"
          style="opacity: 0.7; margin-left: 8px;"
          title="Filmstrip frame rate when video flows over signals"
        >fps:</span>
        <select
          class="secondary-font"
          title="Filmstrip frame rate (sender). Higher fps = more bandwidth."
          style="
            cursor: pointer;
            padding: 3px 6px;
            border-radius: 4px;
            border: 1px solid rgba(255,255,255,0.15);
            background: transparent;
            color: #c3c9eb;
            font-family: inherit;
          "
          .value=${String(currentFps)}
          @change=${(e: Event) => {
            const fps = Number((e.target as HTMLSelectElement).value) as FilmstripFps;
            filmstripController.setFps(fps);
            this.requestUpdate();
          }}
        >
          ${FILMSTRIP_FPS_OPTIONS.map(
            v => html`<option value=${v} ?selected=${v === currentFps}>${v}</option>`
          )}
        </select>
        <span
          class="secondary-font"
          style="opacity: 0.7; margin-left: 8px;"
          title="Filmstrip capture resolution (px square). Higher = crisper, more bandwidth."
        >px:</span>
        <select
          class="secondary-font"
          title="Filmstrip capture resolution. Higher = crisper picture, more bytes/sec."
          style="
            cursor: pointer;
            padding: 3px 6px;
            border-radius: 4px;
            border: 1px solid rgba(255,255,255,0.15);
            background: transparent;
            color: #c3c9eb;
            font-family: inherit;
          "
          .value=${String(currentSize)}
          @change=${(e: Event) => {
            const size = Number((e.target as HTMLSelectElement).value) as FilmstripCaptureSize;
            filmstripController.setCaptureSide(size);
            this.requestUpdate();
          }}
        >
          ${FILMSTRIP_CAPTURE_SIZES.map(
            v => html`<option value=${v} ?selected=${v === currentSize}>${v}</option>`
          )}
        </select>
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
        const pending = this._pendingDiagnosticRequests?.value?.[pubkeyB64];
        const failed = !!this._failedDiagnosticRequests?.value?.[pubkeyB64];
        const color = hasReceivedLogs
          ? '#09b500'
          : pending
            ? '#e7a008'
            : failed
              ? '#d23030'
              : '#c3c9eb';
        const tooltip = hasReceivedLogs
          ? 'Download merged diagnostic logs'
          : pending
            ? `Requesting logs... (attempt ${pending.attempts})`
            : failed
              ? 'No response after 3 attempts — click to retry'
              : 'Request peer diagnostic logs';
        return html`
          <sl-tooltip
            hoist
            class="tooltip-filled"
            placement="top"
            content="${tooltip}"
          >
            <sl-icon
              style="font-size: 18px; color: ${color}; cursor: pointer; margin-top: 2px;"
              .src=${wrapPathInSvg(mdiCloudDownloadOutline)}
              @click=${() => {
                if (hasReceivedLogs) {
                  downloadJson(
                    `Presence_diagnostic_${pubkeyB64.slice(0, 8)}_${formattedDate()}.json`,
                    JSON.stringify(this.streamsStore.exportMergedLogs(pubkeyB64), undefined, 2)
                  );
                  // Results consumed — reset the button to requestable.
                  this.streamsStore.clearReceivedDiagnostics(pubkeyB64);
                } else if (!pending) {
                  this.streamsStore.requestDiagnosticLogs(pubkeyB64);
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
    // Toolbar buttons are explicitly listed (and explicitly ordered) instead
    // of being collected from getAllModules().filter(m => m.renderToolbarButton).
    // Reasons: (1) the embedded webview blocks window.prompt() in some module
    // toolbars (e.g. timer, wal), so each one needs bespoke activation glue
    // here; (2) we care about left-to-right ordering of mic / video / hand /
    // wal / screen / timer / hide-self / leave for muscle memory. Adding a
    // new module's toolbar button means adding one line below, not nothing.
    return html`
      <div class="toggles-panel">
        ${this._showConnectionDetails
          ? (() => {
              const received = this._receivedDiagnosticLogs?.value ?? {};
              const pending = this._pendingDiagnosticRequests?.value ?? {};
              const failed = this._failedDiagnosticRequests?.value ?? {};
              const receivedCount = Object.keys(received).length;
              const pendingCount = Object.keys(pending).length;
              const failedCount = Object.keys(failed).length;
              const isPending = pendingCount > 0;
              const hasAnyReceived = receivedCount > 0;
              const failedSuffix = failedCount > 0
                ? ` — ${failedCount} peer${failedCount === 1 ? '' : 's'} failed: ${Object.keys(failed).map(k => k.slice(0, 8)).join(', ')}`
                : '';
              const tooltip = isPending
                ? `Requesting logs from ${pendingCount} peer${pendingCount === 1 ? '' : 's'}...${failedSuffix}`
                : hasAnyReceived
                  ? `Download merged logs from ${receivedCount} peer${receivedCount === 1 ? '' : 's'} + local${failedSuffix}`
                  : failedCount > 0
                    ? `No peers responded after 3 attempts${failedSuffix} — click to retry`
                    : 'Request diagnostic logs from all peers on call';
              const color = isPending
                ? '#e7a008'
                : hasAnyReceived
                  ? '#09b500'
                  : failedCount > 0
                    ? '#d23030'
                    : '';
              return html`
              <sl-tooltip content="${tooltip}" hoist>
                <div
                  class="toggle-btn"
                  style="position: absolute; left: -130px;"
                  tabindex="0"
                  @click=${(e: any) => {
                    e.stopPropagation();
                    if (isPending) return;
                    if (hasAnyReceived) {
                      downloadJson(
                        `Presence_merged_${__APP_VERSION__}_${formattedDate()}.json`,
                        JSON.stringify(this.streamsStore.exportMergedLogsAll(), undefined, 2)
                      );
                      // Results consumed — reset the button to requestable.
                      this.streamsStore.clearReceivedDiagnostics();
                    } else {
                      this.streamsStore.requestDiagnosticLogs();
                    }
                  }}
                  @keypress=${() => undefined}
                >
                  <sl-icon
                    class="toggle-btn-icon"
                    style="color: ${color};"
                    .src=${wrapPathInSvg(mdiCloudDownloadOutline)}
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
            `;
            })()
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

        <!-- raise-hand toolbar button (between video and wal) -->
        ${this._renderModuleToolbarButton('raise-hand')}

        <!-- WAL bypasses _renderModuleToolbarButton because activation
             routes through the WeaveClient asset picker, which lives on
             room-view (not the module). -->
        ${(() => {
          const walActive = !!(this._myModuleStates.value || {})['wal'];
          return html`
        <sl-tooltip
          content="${walActive
            ? msg('Stop Sharing Asset')
            : msg('Share Asset')}"
          hoist
        >
          <div
            class="toggle-btn ${walActive ? '' : 'btn-off'}"
            tabindex="0"
            @click=${async () => {
              if (walActive) {
                await this.stopShareWal();
              } else {
                await this.startShareWal();
              }
            }}
            @keypress=${async (e: KeyboardEvent) => {
              if (e.key === 'Enter') {
                if (walActive) {
                  await this.stopShareWal();
                } else {
                  await this.startShareWal();
                }
              }
            }}
          >
            <sl-icon
              class="toggle-btn-icon ${walActive ? '' : 'btn-icon-off'}"
              .src=${wrapPathInSvg(mdiCubeOutline)}
            ></sl-icon>
          </div>
        </sl-tooltip>
        `;})()}

        <!-- screen-share, timer -->
        ${this._renderModuleToolbarButton('screen-share')}
        ${this._renderModuleToolbarButton('timer')}

        <sl-tooltip content="${msg('View Settings')}" hoist>
          <div
            class="toggle-btn"
            tabindex="0"
            @click=${(e: any) => {
              e.stopPropagation();
              this._showViewSettings = !this._showViewSettings;
            }}
            @keypress=${(e: KeyboardEvent) => {
              if (e.key === 'Enter') {
                e.stopPropagation();
                this._showViewSettings = !this._showViewSettings;
              }
            }}
          >
            <sl-icon
              class="toggle-btn-icon"
              .src=${wrapPathInSvg(mdiCog)}
            ></sl-icon>

            <!-- View settings menu -->
            ${this._showViewSettings
              ? html`
                  <div
                    class="column audio-input-sources view-settings-menu secondary-font"
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
                    <div class="input-source-title">${msg('Self View')}</div>
                    <div
                      class="audio-source column"
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
                      <div class="row">
                        <div style="${this._selfViewHidden ? 'color: transparent' : ''}">
                          &#10003;&nbsp;
                        </div>
                        <div>${msg('Show self')}</div>
                      </div>
                    </div>

                    <div class="input-source-title" style="margin-top: 6px;">
                      ${msg('Tile Shape')}
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
            <sl-icon
              class="hangup-icon"
              .src=${wrapPathInSvg(mdiPhoneHangup)}
            ></sl-icon>
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
  renderModuleSwitcher(pubkeyB64: AgentPubKeyB64, isMe = false) {
    const peerModules = isMe
      ? (this._myModuleStates.value || {})
      : (this._peerModuleStates.value?.[pubkeyB64] || {});
    const currentOverride = this._receiverModuleOverrides.value?.[pubkeyB64];

    // Find modules with renderReplace that the receiver can switch to:
    // - receiver-activated modules (always switchable when active)
    // - sender-activated modules that also have an overlay (replace is an optional deeper view)
    const hasReplace = (mod: NonNullable<ReturnType<typeof getModule>>) => !!mod.renderReplace || !!mod.replaceElement;
    const hasOverlay = (mod: NonNullable<ReturnType<typeof getModule>>) => !!mod.renderOverlay || !!mod.overlayElement;
    const switchableModules = Object.entries(peerModules)
      .map(([moduleId, _envelope]) => getModule(moduleId))
      .filter((mod): mod is NonNullable<typeof mod> =>
        !!mod && hasReplace(mod) && (
          mod.activationControl === 'receiver' ||
          (mod.activationControl === 'sender' && hasOverlay(mod))
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
            @click=${() => {
              this.streamsStore.setReceiverOverride(pubkeyB64, null);
              // Switching back to video creates a new <video> element — reapply srcObject
              setTimeout(() => this._reapplyVideoStreams(), 100);
            }}
          >
            <sl-icon slot="prefix" .src=${wrapPathInSvg(mdiVideo)} style="font-size: 16px;"></sl-icon>
            Video/Audio${!currentOverride ? ' ✓' : ''}
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
   *
   * If the module defines replaceElement, the returned html uses that custom element
   * with data passed as properties (independent re-render boundary).
   * Otherwise falls back to calling renderReplace() directly.
   */
  _getActiveReplaceModule(
    pubkeyB64: AgentPubKeyB64,
    context: ModuleRenderContext,
  ): { moduleId: string; html: unknown } | null {
    const modules = context.isMe
      ? (this._myModuleStates.value || {})
      : (this._peerModuleStates.value?.[pubkeyB64] || {});

    const renderForModule = (mod: ReturnType<typeof getModule>, moduleState: ModuleStateEnvelope | null) => {
      if (mod!.replaceElement) {
        const tag = unsafeStatic(mod!.replaceElement);
        return staticHtml`<${tag}
          .agentPubKeyB64=${pubkeyB64}
          .moduleState=${moduleState}
          .context=${context}
        ></${tag}>`;
      }
      return mod!.renderReplace!(pubkeyB64, moduleState, context);
    };

    // Check receiver override first (works for both receiver- and sender-activated modules)
    const override = this._receiverModuleOverrides.value?.[pubkeyB64];
    if (override) {
      const mod = getModule(override);
      if (mod?.renderReplace || mod?.replaceElement) {
        const state = (modules as Record<string, ModuleStateEnvelope>)[override] || null;
        return { moduleId: override, html: renderForModule(mod, state) };
      }
    }

    // Check sender-activated replace-only modules (no overlay = forces replace)
    for (const [moduleId, envelope] of Object.entries(modules)) {
      const mod = getModule(moduleId);
      if ((mod?.renderReplace || mod?.replaceElement) && !mod?.renderOverlay && !mod?.overlayElement && mod?.activationControl === 'sender' && envelope.active) {
        return { moduleId, html: renderForModule(mod, envelope) };
      }
    }

    return null;
  }

  /**
   * Renders the standardized icon strip for all active modules on an agent's pane.
   * Collects icons from all active modules, filters hidden ones, renders in a row.
   */
  private _renderModuleIcon(icon: ModuleIconDefinition) {
    const stateInfo = icon.states[icon.currentState!];
    if (icon.menuItems && icon.menuItems.length > 0) {
      return html`
        <sl-dropdown placement="top" distance="4" hoist>
          <sl-icon
            slot="trigger"
            style="color: ${stateInfo.color || 'white'}; height: 30px; width: 30px; cursor: pointer;"
            title="${stateInfo.tooltip || ''}"
            .src=${wrapPathInSvg(stateInfo.icon)}
          ></sl-icon>
          <sl-menu class="reconnect-menu secondary-font">
            ${icon.menuItems.map(item => html`
              <sl-menu-item
                class="reconnect-menu-item"
                @click=${() => item.action()}
              >${item.label}</sl-menu-item>
            `)}
          </sl-menu>
        </sl-dropdown>
      `;
    }
    const clickable = !!icon.onSelect;
    return html`
      <sl-icon
        style="color: ${stateInfo.color || 'white'}; height: 30px; width: 30px;${clickable ? ' cursor: pointer;' : ''}"
        title="${stateInfo.tooltip || ''}"
        .src=${wrapPathInSvg(stateInfo.icon)}
        @click=${clickable ? () => icon.onSelect!(icon.currentState!) : undefined}
      ></sl-icon>
    `;
  }

  _renderModuleToolbarButton(moduleId: string) {
    const mod = getModule(moduleId);
    if (!mod?.renderToolbarButton) return html``;
    const myState = this._myModuleStates.value?.[moduleId] || null;
    const toggle = async () => {
      if (myState) {
        await this.streamsStore.deactivateModule(moduleId);
      } else {
        await this.streamsStore.activateModule(moduleId);
      }
    };
    return mod.renderToolbarButton(myState, toggle, this.streamsStore);
  }

  renderModuleIconStrip(pubkeyB64: AgentPubKeyB64, context: ModuleRenderContext) {
    const modules = context.isMe
      ? (this._myModuleStates.value || {})
      : (this._peerModuleStates.value?.[pubkeyB64] || {});
    const allIcons: ModuleIconDefinition[] = [];

    for (const [moduleId, envelope] of Object.entries(modules)) {
      // Peer-facing acquiring envelopes are filtered at the dispatch surface:
      // a self-view of a loading module can show a local "acquiring" badge,
      // but peers should not yet believe the module is live.
      if (!context.isMe && envelope.phase === 'acquiring') continue;
      const mod = getModule(moduleId);
      if (mod?.getStateIcons) {
        allIcons.push(...mod.getStateIcons(pubkeyB64, envelope, context));
      }
    }

    const visibleIcons = allIcons.filter(icon => icon.currentState !== undefined);
    if (visibleIcons.length === 0) return html``;

    return html`
      ${visibleIcons.map(icon => this._renderModuleIcon(icon))}
    `;
  }

  /**
   * Renders all active overlay modules for an agent's pane.
   */
  private _renderOverlayForModule(
    mod: ReturnType<typeof getModule>,
    pubkeyB64: string,
    envelope: ModuleStateEnvelope,
    context: ModuleRenderContext,
  ): unknown {
    if (mod!.overlayElement) {
      const tag = unsafeStatic(mod!.overlayElement);
      return staticHtml`<${tag}
        .agentPubKeyB64=${pubkeyB64}
        .moduleState=${envelope}
        .context=${context}
      ></${tag}>`;
    }
    return mod!.renderOverlay!(pubkeyB64, envelope, context);
  }

  renderModuleOverlays(pubkeyB64: AgentPubKeyB64, context: ModuleRenderContext) {
    const modules = context.isMe
      ? (this._myModuleStates.value || {})
      : (this._peerModuleStates.value?.[pubkeyB64] || {});
    const overlays: unknown[] = [];

    for (const [moduleId, envelope] of Object.entries(modules)) {
      // Peer-facing acquiring envelopes are filtered here; self views still
      // get to render a loading overlay if the module wants one.
      if (!context.isMe && envelope.phase === 'acquiring') continue;
      const mod = getModule(moduleId);
      if (mod?.renderOverlay || mod?.overlayElement) {
        overlays.push(this._renderOverlayForModule(mod, pubkeyB64, envelope, context));
      }
    }

    return overlays;
  }

  /**
   * Enumerate all active share-type module instances across self and peers.
   * Returns one entry per (active share-module, agent) pair.
   */
  _getActiveShares(): Array<{
    moduleId: string;
    agentPubKeyB64: AgentPubKeyB64;
    state: ModuleStateEnvelope;
    isMe: boolean;
  }> {
    const myPubKeyB64 = encodeHashToBase64(this.roomStore.client.client.myPubKey);
    const shareModuleIds = new Set(getShareModules().map(m => m.id));
    const result: Array<{
      moduleId: string;
      agentPubKeyB64: AgentPubKeyB64;
      state: ModuleStateEnvelope;
      isMe: boolean;
    }> = [];

    // Self shares. Acquiring envelopes are included so the initiator's
    // <video>/DOM hooks mount before the stream bytes arrive.
    const myStates = this._myModuleStates.value || {};
    for (const [moduleId, envelope] of Object.entries(myStates)) {
      if (shareModuleIds.has(moduleId) && envelope.active) {
        result.push({ moduleId, agentPubKeyB64: myPubKeyB64, state: envelope, isMe: true });
      }
    }

    // Peer shares. Acquiring envelopes are skipped — peers should not see
    // an "establishing connection…" tile for the initiator's picker gap.
    const peerStates = this._peerModuleStates.value || {};
    for (const [pubkeyB64, modules] of Object.entries(peerStates)) {
      for (const [moduleId, envelope] of Object.entries(modules)) {
        if (
          shareModuleIds.has(moduleId) &&
          envelope.active &&
          envelope.phase !== 'acquiring'
        ) {
          result.push({ moduleId, agentPubKeyB64: pubkeyB64, state: envelope, isMe: false });
        }
      }
    }

    return result;
  }

  /**
   * Render a single share tile via the module's renderShare or shareElement.
   */
  private _renderShareForModule(
    mod: NonNullable<ReturnType<typeof getModule>>,
    pubkeyB64: string,
    envelope: ModuleStateEnvelope,
    context: ModuleRenderContext,
  ): unknown {
    if (mod.shareElement) {
      const tag = unsafeStatic(mod.shareElement);
      return staticHtml`<${tag}
        .agentPubKeyB64=${pubkeyB64}
        .moduleState=${envelope}
        .context=${context}
      ></${tag}>`;
    }
    if (mod.renderShare) {
      return mod.renderShare(pubkeyB64, envelope, context);
    }
    return null;
  }

  /**
   * Render the shared panel from active share-type modules. Each share tile
   * is wrapped in shared-panel-frame and supports maximize via the
   * `share-${moduleId}-${pubkey}` keying scheme.
   */
  renderSharedPanel() {
    const myPubKeyB64 = encodeHashToBase64(this.roomStore.client.client.myPubKey);
    const shares = this._getActiveShares();
    if (shares.length === 0) return html``;

    // Use repeat() with a stable key per share so Lit moves existing DOM
    // nodes instead of recreating them when the share list reorders.
    // Without this, locally adding a share (which inserts at the front)
    // tears down peer screen-share <video> elements and loses srcObject.
    return html`${repeat(
      shares,
      ({ moduleId, agentPubKeyB64 }) => `share-${moduleId}-${agentPubKeyB64}`,
      ({ moduleId, agentPubKeyB64, state, isMe }) => {
        const mod = getModule(moduleId);
        if (!mod) return html``;
        const shareKey = `share-${moduleId}-${agentPubKeyB64}`;
        const layout = this.idToLayout(shareKey, true);
        const wrapperClass = mod.shareWrapperClass ?? 'video-container screen-share';
        const context: ModuleRenderContext = {
          isMe,
          connected: true,
          circleView: false,
          streamsStore: this.streamsStore,
          myPubKeyB64,
        };
        const content = this._renderShareForModule(mod, agentPubKeyB64, state, context);
        // Screen-share diagnostic overlay: legacy behavior gated by
        // _showConnectionDetails. Kept as an inline special-case rather than
        // a ModuleRenderContext extension because only screen-share needs
        // per-tile connection statuses today.
        const diagnosticsOverlay =
          moduleId === 'screen-share' && this._showConnectionDetails
            ? html`<div
                style="display: flex; flex-direction: row; align-items: center; position: absolute; top: 10px; left: 10px; background: none;"
              >
                ${this.renderAgentConnectionStatuses(
                  isMe ? 'my-screen-share' : 'their-screen-share',
                  isMe ? undefined : agentPubKeyB64,
                )}
              </div>`
            : html``;
        return html`
          <div
            class="${wrapperClass} shared-panel-frame ${layout}"
            @dblclick=${() => this.toggleMaximized(shareKey)}
          >
            ${content}
            ${diagnosticsOverlay}
            <sl-icon
              title="${this._maximizedVideo === shareKey ? 'minimize' : 'maximize'}"
              .src=${this._maximizedVideo === shareKey
                ? wrapPathInSvg(mdiFullscreenExit)
                : wrapPathInSvg(mdiFullscreen)}
              tabindex="0"
              class="maximize-icon"
              @click=${() => this.toggleMaximized(shareKey)}
              @keypress=${(e: KeyboardEvent) => {
                if (e.key === 'Enter') this.toggleMaximized(shareKey);
              }}
            ></sl-icon>
          </div>
        `;
      },
    )}`;
  }

  /**
   * Renders connection statuses of agents with icons in a row.
   *
   * @param type
   * @param pubkeyb64
   * @returns
   */
  /**
   * Render a small volume bar for signals-carrier audio from a peer.
   * Only shown when connection details are visible AND the peer has no
   * WebRTC connection (audio is flowing via signals). Reads from the
   * plain Map on voiceController — no reactive subscription, just
   * piggybacks on the existing render cycle.
   */
  private _renderAudioLevelMeter(pubkeyB64: AgentPubKeyB64) {
    // Hide when peer's mic is muted — no audio to show levels for
    const peerConv = this._peerModuleStates.value?.[pubkeyB64]?.['conversation'];
    if (peerConv) {
      try {
        const p = JSON.parse(peerConv.payload);
        if (p.micMuted || p.muted) return html``;
      } catch {}
    }
    return html`
      <audio-level-meter style="margin-left:3px"
        .streamsStore=${this.streamsStore}
        .agentPubKeyB64=${pubkeyB64}
      ></audio-level-meter>
    `;
  }

  /**
   * Render a per-peer carrier selector. Only shown when connection
   * details are visible. Lets the user pin this link to a specific
   * carrier (WebRTC simple-peer / WebRTC FSM / signals) or leave it on
   * 'inherit' to follow the global carrier and the auto-flip policy.
   *
   * When the peer has disabled WebRTC from their side, the link is
   * forced to signals regardless of our choice — we show a static
   * indicator instead of the dropdown.
   */
  private _renderCarrierToggle(pubkeyB64: AgentPubKeyB64) {
    // Did the peer force signals from their side (globally, or for us
    // specifically via their disableWebrtcWith list)?
    let disabledByPeer = false;
    const peerConv = this._peerModuleStates.value?.[pubkeyB64]?.['conversation'];
    if (peerConv) {
      try {
        const p = JSON.parse(peerConv.payload);
        if (p.webrtcDisabled) disabledByPeer = true;
        if (Array.isArray(p.disableWebrtcWith) &&
            p.disableWebrtcWith.includes(this.streamsStore.myPubKeyB64)) {
          disabledByPeer = true;
        }
      } catch {}
    }

    if (disabledByPeer) {
      return html`
        <sl-tooltip
          hoist
          class="tooltip-filled"
          placement="top"
          content="Carrier forced to signals by agent"
        >
          <sl-icon
            style="color: #e7a008; height: 24px; width: 24px; opacity: 0.6;"
            .src=${wrapPathInSvg(mdiSwapHorizontal)}
          ></sl-icon>
        </sl-tooltip>
      `;
    }

    const selected = this.streamsStore.myPeerCarrier(pubkeyB64);
    const options: Array<{
      value: 'inherit' | 'simplepeer' | 'fsm' | 'signals';
      label: string;
    }> = [
      { value: 'inherit', label: 'Inherit global' },
      { value: 'simplepeer', label: 'WebRTC (SP)' },
      { value: 'fsm', label: 'WebRTC (FSM)' },
      { value: 'signals', label: 'Signals' },
    ];
    // Icon colour: amber when pinned to signals, neutral when inheriting
    // the global carrier, green when pinned to a WebRTC impl.
    const color =
      selected === 'signals' ? '#e7a008'
        : selected === 'inherit' ? '#c3c9eb'
          : '#7adc7a';
    const opacity = selected === 'inherit' ? '0.6' : '1';

    return html`
      <sl-dropdown placement="top" distance="4" hoist>
        <sl-icon
          slot="trigger"
          title="Select carrier for this peer"
          style="color: ${color}; height: 24px; width: 24px; cursor: pointer; opacity: ${opacity};"
          .src=${wrapPathInSvg(mdiSwapHorizontal)}
        ></sl-icon>
        <sl-menu class="reconnect-menu secondary-font">
          ${options.map(opt => html`
            <sl-menu-item
              class="reconnect-menu-item"
              @click=${() => {
                this.streamsStore.setPeerCarrier(pubkeyB64, opt.value);
              }}
            >
              ${opt.label}${selected === opt.value ? ' ✓' : ''}
            </sl-menu-item>
          `)}
        </sl-menu>
      </sl-dropdown>
    `;
  }

  /**
   * Render a placeholder tile per agent in `phantomAgents()` — agents
   * other peers report as in-room with a working audio link, but who we
   * cannot see directly. Suppresses the normal tile chrome (no video
   * element, no module overlays, no audio meter, no per-tile connection
   * details) since none of that data exists for an unconnected peer.
   * Lists the observers who DO see them so the user can tell whether
   * the issue is the peer or our own connectivity.
   */
  private _renderPhantomTiles() {
    const phantoms = this.streamsStore.phantomAgents();
    if (phantoms.length === 0) return html``;
    return html`${repeat(
      phantoms,
      pk => pk,
      pk => {
        const seeing = this.streamsStore.observersSeeing(pk);
        const connected = this.streamsStore.observersConnectedTo(pk);
        // Prefer the "connected via" framing when any observer has a
        // working link; fall back to "last seen by" when presence is
        // only ping-level (impolite close in progress, link broken
        // everywhere).
        const label = connected.length > 0 ? 'connected via' : 'last seen by';
        const observers = seeing;
        return html`
          <div
            class="video-container ${this.idToLayout(pk)}${this._circleView ? '' : ' square-view'}"
            style="opacity: 0.7;"
            title="Reported in room by ${observers.length} peer${observers.length === 1 ? '' : 's'} — not connected to you"
          >
            <avatar-with-nickname
              .hideNickname=${true}
              .agentPubKey=${decodeHashFromBase64(pk)}
              style="width: 35%;"
            ></avatar-with-nickname>
            <div
              class="secondary-font"
              style="position: absolute; top: 10px; left: 50%; transform: translateX(-50%); color: #ffd900; font-size: 14px; text-align: center; max-width: 80%;"
            >
              reported in room — not connected to you
            </div>
            ${observers.length > 0
              ? html`<div
                  style="position: absolute; bottom: 10px; left: 50%; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: 4px;"
                >
                  <span
                    class="secondary-font"
                    style="color: #c3c9eb; font-size: 18px; opacity: 0.85;"
                    >${label}</span
                  >
                  <div style="display: flex; flex-direction: row; gap: 4px;">
                    ${repeat(
                      observers,
                      obs => obs,
                      obs => html`<div
                        style="width: 24px; height: 24px; display: inline-block;"
                      >
                        <avatar-with-nickname
                          .hideNickname=${true}
                          .agentPubKey=${decodeHashFromBase64(obs)}
                        ></avatar-with-nickname>
                      </div>`,
                    )}
                  </div>
                </div>`
              : html``}
          </div>
        `;
      },
    )}`;
  }

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

    // Observer's broadcast per-peer link snapshots (or undefined for
    // my-video / my-screen-share where the observer is us).
    const observerLinks: Record<AgentPubKeyB64, import('../types').PeerLinkSnapshot> | undefined =
      type === 'my-video' || type === 'my-screen-share'
        ? undefined
        : this._othersConnectionStatuses.value[pubkeyb64!]?.peerLinks;

    // Count peers this observer can actually hear — AudioLink ∈
    // {webrtc, signals}. Replaces the old WebRTC-Connected count, which
    // undercounted signals-only peers and overcounted connected-but-silent
    // links.
    const audibleCount = (() => {
      if (type === 'my-video') {
        return Object.keys(connectionStatuses).filter(pk => {
          const s = this.streamsStore.audioLinkFor(pk);
          return s === 'webrtc' || s === 'signals';
        }).length;
      }
      if (observerLinks) {
        return Object.values(observerLinks).filter(
          l => l.audioLink === 'webrtc' || l.audioLink === 'signals',
        ).length;
      }
      return Object.values(connectionStatuses).filter(
        s => s.type === 'Connected',
      ).length;
    })();

    // Iteration set is the global presence union, with the observer
    // themselves removed — an icon strip is "this observer's view of
    // OTHERS", so the observer's own pubkey would render as e.g.
    // "Gaston (Disconnected from Gaston)", which is meaningless.
    const observerPubKey: AgentPubKeyB64 | undefined =
      type === 'my-video' || type === 'my-screen-share'
        ? myPubKeyB64
        : pubkeyb64;
    const presenceSet = this.streamsStore.globalPresenceSet();
    const sortedStatuses = Array.from(presenceSet)
      .filter(pk => pk !== observerPubKey)
      .map(pk => [
        pk,
        connectionStatuses[pk] ?? { type: 'Disconnected' },
      ] as [AgentPubKeyB64, import('../types').ConnectionStatus])
      .sort(sortConnectionStatuses);
    return html`
      <div class="row" style="align-items: center; flex-wrap: wrap; line-height: 1;">
        ${repeat(
          sortedStatuses,
          ([pubkeyb64, _status]) => pubkeyb64,
          ([innerPubkey, status]) => {
            // Check whether the agent for which the statuses are rendered has only been told by others that
            // the rendered agent exists. `type === 'told'` alone is insufficient:
            // per types.ts AgentInfo, 'told' also covers "received a Pong from
            // that agent themselves" — so it stays 'told' forever once we've
            // had direct contact. Gate on `lastSeen === undefined` so the
            // indicator clears as soon as a direct pong arrives (pong handler
            // in streams-store stamps `lastSeen = Date.now()`; agents learned
            // only via another peer's knownAgents metadata are written with
            // `lastSeen: undefined`).
            const onlyToldAbout = !!(
              knownAgents &&
              knownAgents[innerPubkey] &&
              knownAgents[innerPubkey].type === 'told' &&
              knownAgents[innerPubkey].lastSeen === undefined
            );

            const lastSeen = knownAgents
              ? knownAgents[innerPubkey]?.lastSeen
              : undefined;

            // Pair-wise (observer, observed) link. For my-video the
            // observer is us — derive locally. For peer tiles, read the
            // observer's broadcast peerLinks. Falls back to the
            // perceivedStreamInfo-based derivation only when the observer
            // is on older code and never broadcasts peerLinks.
            let audioStatus:
              | 'live'
              | 'stale'
              | 'muted'
              | 'off'
              | undefined;
            let videoStatus: 'live' | 'muted' | 'off' | undefined;
            let audioCarrier:
              | 'webrtc'
              | 'signals'
              | 'none'
              | undefined;
            let audioLink: import('../types').AudioLinkState | undefined;
            let lastSeenBucket:
              | import('../types').LastSeenBucket
              | undefined;

            if (type === 'my-video') {
              const snap = this.streamsStore.peerLinkFor(innerPubkey);
              audioStatus = snap.audio;
              videoStatus = snap.video;
              audioCarrier = snap.carrier;
              audioLink = snap.audioLink;
              lastSeenBucket = this.streamsStore.lastSeenBucket(innerPubkey);
            } else if (type === 'video') {
              const snap = observerLinks?.[innerPubkey];
              if (snap) {
                audioStatus = snap.audio;
                videoStatus = snap.video;
                audioCarrier = snap.carrier;
                audioLink = snap.audioLink;
                lastSeenBucket = snap.lastSeen;
              } else if (innerPubkey === myPubKeyB64) {
                // Legacy fallback for peers on older code that don't
                // broadcast peerLinks but do broadcast perceivedStreamInfo.
                const legacyAudio = streamInfoToTrackStatus(
                  perceivedStreamInfo,
                  'audio',
                );
                const legacyVideo = streamInfoToTrackStatus(
                  perceivedStreamInfo,
                  'video',
                );
                audioStatus =
                  legacyAudio === 'on'
                    ? 'live'
                    : legacyAudio === 'muted'
                      ? 'muted'
                      : legacyAudio === 'off'
                        ? 'off'
                        : undefined;
                videoStatus =
                  legacyVideo === 'on'
                    ? 'live'
                    : legacyVideo === 'muted'
                      ? 'muted'
                      : legacyVideo === 'off'
                        ? 'off'
                        : undefined;
              }
            }

            return html`<agent-connection-status-icon
              style="margin-right: 2px; margin-bottom: 2px; ${staleInfo
                ? 'opacity: 0.5;'
                : ''}"
              .agentPubKey=${decodeHashFromBase64(innerPubkey)}
              .connectionStatus=${status}
              .audioLink=${audioLink}
              .onlyToldAbout=${onlyToldAbout}
              .lastSeen=${lastSeen}
              .lastSeenBucket=${lastSeenBucket}
              .audioStatus=${audioStatus}
              .videoStatus=${videoStatus}
              .audioCarrier=${audioCarrier}
            ></agent-connection-status-icon>`;
          }
        )}
        <span
          class="tertiary-font"
          style="color: #c3c9eb; font-size: 18px; margin-left: 5px; line-height: 1;"
          title="peers I can hear (webrtc + signals)"
          >(${audibleCount})</span
        >
      </div>
    `;
  }

  render() {
    const activeShares = this._getActiveShares();
    const hasShared = activeShares.length > 0;
    const splitMode = hasShared && !this._maximizedVideo;
    // Simple people grid (no screen share, not maximized): JS picks the grid
    // shape (--cols/--rows) and CSS sizes tiles in cqw/cqh to maximize area.
    const autoGrid = !splitMode && !this._maximizedVideo;
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
      <div
        class="videos-container${splitMode ? ' split-mode' : ''}${autoGrid
          ? ' auto-grid'
          : ''}"
        style="${autoGrid && this._gridCols > 0
          ? (() => {
              // n must match _updateGrid's count: peers + phantoms + self (unless hidden).
              const n =
                Object.keys(this._activeAgents.value).length +
                this.streamsStore.phantomAgents().length +
                (this._selfViewHidden ? 0 : 1);
              const lastK = ((n - 1) % this._gridCols) + 1;
              // When the last row has a single item (the common odd-n / cols=2
              // case), let it span the row so justify-items:center centers it
              // across the columns above. Otherwise normal one-cell placement.
              const lastSpans = lastK === 1 && this._gridCols > 1 ? this._gridCols : 1;
              return `--cols: ${this._gridCols}; --rows: ${this._gridRows}; --tile-aspect: ${
                this._circleView ? '1' : '1.7778'
              }; --tile-min: ${GRID_MIN_TILE_WIDTH}px; --last-spans: ${lastSpans};`;
            })()
          : ''}"
      >
        ${this._isResizing ? html`<div class="resize-overlay"></div>` : html``}
        ${hasShared ? html`
        <div class="screen-share-panel" style="${splitMode ? `flex-basis: ${this._splitRatio}%` : ''}">
        <!-- All shares: screen-share, WAL, timer, etc. -->
        ${this.renderSharedPanel()}

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
          const myActiveReplace = this._getActiveReplaceModule(myPubKeyB64, myModuleContext);
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
          ${this.renderModuleOverlays(myPubKeyB64, myModuleContext)}

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
                    ${this.renderModuleIconStrip(myPubKeyB64, myModuleContext)}
                  </div>
                  <div class="row" style="align-items: center;">
                    <avatar-with-nickname
                      .size=${36}
                      .hideAvatar=${!this._camera}
                      .agentPubKey=${this.roomStore.client.client.myPubKey}
                      style="height: 36px;"
                    ></avatar-with-nickname>
                    ${this.renderModuleSwitcher(myPubKeyB64, true)}
                  </div>
                </div>
              `
            : html`
                <div
                  class="tile-meta"
                  style="display: flex; flex-direction: row; align-items: center; position: absolute; bottom: 10px; right: 10px; background: none;"
                >
                  ${this.renderModuleIconStrip(myPubKeyB64, myModuleContext)}
                  <avatar-with-nickname
                    .size=${36}
                    .agentPubKey=${this.roomStore.client.client.myPubKey}
                    style="height: 36px;"
                  ></avatar-with-nickname>
                  ${this.renderModuleSwitcher(myPubKeyB64, true)}
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

        <!-- Panes for present agents (driven by holochain presence, not WebRTC) -->
        ${repeat(
          Object.entries(this._activeAgents.value),
          ([pubkeyB64]) => pubkeyB64,
          ([pubkeyB64]) => {
            const conn = this._openConnections.value[pubkeyB64] as OpenConnectionInfo | undefined;
            const moduleContext: ModuleRenderContext = {
              isMe: false,
              connected: true,
              circleView: this._circleView,
              streamsStore: this.streamsStore,
              myPubKeyB64: encodeHashToBase64(this.roomStore.client.client.myPubKey),
              extra: { conn },
            };
            // Determine active replace module for this peer's pane
            const activeReplaceModule = this._getActiveReplaceModule(pubkeyB64, moduleContext);
            const videoElId = `video-${pubkeyB64}`;

            // Avatar visibility:
            //   - conn undefined (signals mode, no WebRTC peer):       show
            //   - conn defined && !conn.connected (still establishing): hide
            //                                                          (status text below shows instead)
            //   - conn defined && conn.connected && !conn.video:       show
            //   - conn defined && conn.connected && conn.video:        hide (WebRTC video covers it)
            // Hide the avatar when WebRTC video is live OR when the
            // filmstrip is currently displaying a clip from this peer.
            // Hiding while filmstrip is active prevents the avatar
            // from flashing through any transparent moment in the
            // bg-image swap.
            const filmstripActive = this._filmstripActivePeers.has(pubkeyB64);
            const avatarHidden = filmstripActive
              ? true
              : conn
                ? !conn.connected || !!conn.video
                : false;
            return html`
            <div
              class="video-container ${this.idToLayout(pubkeyB64)}${this._circleView ? '' : ' square-view'}"
              @dblclick=${() => this.toggleMaximized(pubkeyB64)}
            >
              <!--
                Avatar and peer-filmstrip are rendered at FIXED positions in
                this template (not inside the conditional branches below) so
                Lit preserves them across renders. When conn flickers between
                defined and undefined during WebRTC reconnect attempts, the
                conditional sections rebuild, but these two elements stay
                mounted — no unmount/remount window during which the avatar
                or container background would flash through.
              -->
              <avatar-with-nickname
                .hideNickname=${true}
                .agentPubKey=${decodeHashFromBase64(pubkeyB64)}
                style="width: 35%;${avatarHidden ? ' display: none;' : ''}"
              ></avatar-with-nickname>
              <peer-filmstrip
                .agentPubKeyB64=${pubkeyB64}
                .onActiveChange=${(active: boolean) => this._onFilmstripActive(pubkeyB64, active)}
              ></peer-filmstrip>

              <!--
                Conditional content is layered on top of the always-mounted
                avatar+filmstrip in DOM order. WebRTC video (when active)
                covers the filmstrip; replace-module covers everything via
                .module-replace-content's z-index.
              -->
              ${activeReplaceModule
                ? html`<div class="module-replace-content">${activeReplaceModule.html}</div>`
                : html``}
              ${conn
                ? html`
                    <video
                      style="${conn.video ? '' : 'display: none;'}"
                      id="${videoElId}"
                      class="video-el"
                    ></video>
                    <div
                      style="color: #b9a884; font-size: 0.8em; ${conn.connected ? 'display: none' : ''}"
                    >
                      establishing video carrier...
                    </div>
                    <div
                      style="color: #b9a884; font-size: 0.8em; ${conn.connected && !conn.video && conn.videoMuted ? '' : 'display: none'}"
                    >
                      connecting media...
                    </div>
                  `
                : html``}

              <!-- Connection detail statuses (debug) -->
              ${this._showConnectionDetails
                ? html`<div
                    style="display: flex; flex-direction: column; align-items: flex-start; gap: 2px; position: absolute; top: 10px; left: 10px; background: none;"
                  >
                    <div style="display: flex; flex-direction: row; align-items: center; gap: 6px;">
                      ${this.renderAgentConnectionStatuses('video', pubkeyB64)}
                      ${this._renderCarrierToggle(pubkeyB64)}
                    </div>
                    <peer-stats-panel
                      .streamsStore=${this.streamsStore}
                      .agentPubKeyB64=${pubkeyB64}
                    ></peer-stats-panel>
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
                          title="${this._maximizedVideo === pubkeyB64
                            ? 'minimize'
                            : 'maximize'}"
                          .src=${this._maximizedVideo === pubkeyB64
                            ? wrapPathInSvg(mdiFullscreenExit)
                            : wrapPathInSvg(mdiFullscreen)}
                          tabindex="0"
                          style="color: #ffe100; height: 30px; width: 30px; cursor: pointer;"
                          @click=${() => {
                            this.toggleMaximized(pubkeyB64);
                          }}
                          @keypress=${(e: KeyboardEvent) => {
                            if (e.key === 'Enter') {
                              this.toggleMaximized(pubkeyB64);
                            }
                          }}
                        ></sl-icon>
                        ${this.renderModuleIconStrip(pubkeyB64, moduleContext)}
                      </div>
                      <div class="row" style="align-items: center;">
                        <avatar-with-nickname
                          .size=${36}
                          .hideAvatar=${!conn?.video}
                          .agentPubKey=${decodeHashFromBase64(pubkeyB64)}
                          style="height: 36px;"
                        ></avatar-with-nickname>
                        ${this.renderModuleSwitcher(pubkeyB64)}
                        ${this._renderAudioLevelMeter(pubkeyB64)}
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
                                      videoElId
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
                        title="${this._maximizedVideo === pubkeyB64
                          ? 'minimize'
                          : 'maximize'}"
                        .src=${this._maximizedVideo === pubkeyB64
                          ? wrapPathInSvg(mdiFullscreenExit)
                          : wrapPathInSvg(mdiFullscreen)}
                        tabindex="0"
                        style="color: #ffe100; height: 24px; width: 24px; cursor: pointer; margin-left: 4px;"
                        @click=${() => {
                          this.toggleMaximized(pubkeyB64);
                        }}
                        @keypress=${(e: KeyboardEvent) => {
                          if (e.key === 'Enter') {
                            this.toggleMaximized(pubkeyB64);
                          }
                        }}
                      ></sl-icon>
                      ${this._renderAudioLevelMeter(pubkeyB64)}
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
                                    videoElId
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
        ${this._renderPhantomTiles()}
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
        @click=${async () => this.streamsStore.stopScreenShare()}
        @keypress=${async (e: KeyboardEvent) => {
          if (e.key === 'Enter') {
            await this.streamsStore.stopScreenShare();
          }
        }}
      >
        ${msg('Stop Screen Share')}
      </div>
      ${(() => {
        const walState = (this._myModuleStates.value || {})['wal'];
        let walPayload: SharedWalPayload | null = null;
        if (walState?.payload) {
          try { walPayload = JSON.parse(walState.payload) as SharedWalPayload; } catch { /* empty */ }
        }
        return html`
      <div
        class="stop-share"
        tabindex="0"
        style="${walPayload ? '' : 'display: none'}"
        @click=${async () => this.stopShareWal()}
        @keypress=${async (e: KeyboardEvent) => {
          if (e.key === 'Enter') {
            await this.stopShareWal();
          }
        }}
      >
        ${msg('Stop Sharing Asset')}${walPayload?.assetName ? ` — ${walPayload.assetName}` : ''}
      </div>`;
      })()}
    `;
  }

  static styles = [
    sharedStyles,
    css`
      /* Fill .room-container (a flex row) and lay our own children out in a
         column. The only in-flow child is .videos-container (the room-name and
         toolbar are absolutely/fixed positioned), so it gets all the height via
         flex:1 — no viewport units needed, which avoids the 100vw/100vh
         scrollbar deadlock. */
      :host {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-width: 0;
        min-height: 0;
      }

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
        /* Fill the host (width:100% of the now-stretched chain, height via
           flex:1) instead of 100vw/100vh, which included the scrollbar gutter
           and forced both scrollbars. */
        width: 100%;
        min-width: 0;
        min-height: 0;
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
        z-index: 5;
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
        height: 100%;
        width: 100%;
        margin: 0;
      }

      .video-container.screen-share.maximized {
        width: 100%;
        min-width: 0;
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
          height: 100%;
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

      /* The people grid now fills a real, flex-sized box (no viewport units),
         so make it a size query container: tiles below can size themselves in
         cqw/cqh against this box, which tracks the visible pane and resizing.
         padding-bottom reserves the fixed toolbar's strip so the bottom tile
         clears it (and the cq basis excludes it). safe-center keeps centring
         while tiles fit, falling back to scrollable top-alignment when they
         don't. */
      .videos-container.auto-grid {
        /* Real CSS grid: exactly --cols per row, rows created as needed. Unlike
           flex-wrap this can never bump a tile to an extra row when the usable
           width drops (e.g. a classic scrollbar stealing ~14px) -- columns just
           narrow, the tile re-sizes in cqw, and no scrollbar feedback loop can
           form. scrollbar-gutter:stable keeps the width constant either way. */
        display: grid;
        grid-template-columns: repeat(var(--cols, 1), 1fr);
        /* Rows hug their tile (max-content) so short tiles (e.g. 16:9 in a
           tall window) don't sit alone in a 1fr row with huge gaps above and
           below. The grid block as a whole is then centered vertically by
           align-content. The min-tile floor is enforced by the tile's own
           width-formula max(--tile-min, ...). */
        grid-auto-rows: max-content;
        justify-items: center;
        align-items: center;
        justify-content: center;
        align-content: safe center;
        container-type: size;
        box-sizing: border-box;
        padding-bottom: 90px;
        overflow-y: auto;
        overflow-x: hidden;
        scrollbar-gutter: stable;
      }

      /* Area-maximizing tile size. JS picks --cols/--rows (from the container
         aspect ratio) and --tile-aspect; CSS makes each tile the largest that
         fits both a 1/cols-wide and a 1/rows-tall slice of the container, in
         cqw/cqh so it can never overflow it and shrinks with the pane down to
         --tile-min (60px), below which the grid scrolls. 14px = per-tile
         margin+border. Higher specificity than the per-count classes. */
      .videos-container.auto-grid
        .video-container:not(.maximized):not(.screen-share) {
        /* Largest aspect-correct tile that fits its grid cell, sized in
           cqw/cqh so it tracks the real pane; centered in the cell by the
           grid's justify/align-items. 14px = per-tile margin+border. */
        width: max(
          var(--tile-min, 60px),
          min(
            calc(100cqw / var(--cols, 1) - 14px),
            calc((100cqh / var(--rows, 1) - 14px) * var(--tile-aspect, 1))
          )
        );
        min-width: 0;
        max-width: 100cqw;
      }

      /* When the last row has a single item (JS sets --last-spans=cols), have
         it span the full row so justify-items:center centers it between the
         columns above instead of leaving it left-anchored in column 1.
         Descendant combinator (not >) because the tiles live inside a
         display:contents wrapper (.layout-transparent), so they aren't direct
         children of .videos-container in the DOM. :last-child still matches
         the last .video-container in its DOM parent (the wrapper). */
      .videos-container.auto-grid
        .video-container:last-child:not(.maximized):not(.screen-share) {
        grid-column: span var(--last-spans, 1);
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
      /* Panel is column-stacked (flex-direction: column, nowrap); width is
         supplied by the .screen-share-panel > * rule above. Per-count rules
         only need to cap height. */
      .screen-share-panel .triplett {
        min-width: 0;
        max-height: 32cqh;
      }
      .screen-share-panel .quartett {
        min-width: 0;
        max-height: 24cqh;
      }
      .screen-share-panel .sextett {
        min-width: 0;
        max-height: 16cqh;
      }
      .screen-share-panel .octett {
        min-width: 0;
        max-height: 12cqh;
      }
      .screen-share-panel .unlimited {
        min-width: 0;
        max-height: 9cqh;
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

      .hangup-icon {
        height: 28px;
        width: 28px;
        color: #facece;
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
        /* Menu opens upward from the bottom toolbar; cap height to the
           viewport so it scrolls instead of clipping off the top of the
           window in short/embedded panes. */
        max-height: calc(100vh - 90px);
        overflow-y: auto;
      }

      /* The gear sits at the far-right of the toolbar, so open its menu
         leftward (anchored to the button's right edge) and lift it up a bit
         to keep it clear of the window edge. */
      .view-settings-menu {
        left: auto;
        right: 8px;
        bottom: 34px;
        width: 130px;
      }

      /* Title flush left; items flush left but indented under it. */
      .view-settings-menu .input-source-title {
        text-align: left;
      }

      .view-settings-menu .audio-source {
        box-sizing: border-box;
        padding-left: 14px;
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

      /*
       * Narrow contexts (asset panes, room-in-room embeds, screen-share with a
       * slim people column): shrink the toolbar buttons progressively so the
       * row stays on a single line as long as possible. The panel keeps its
       * bottom-right anchor, so wrapping to a second row grows it upward and
       * covers the agent-name overlays at the bottom of the tiles — we avoid
       * that by making the buttons smaller rather than letting them wrap.
       *
       * .btn-stop (leave call) must shrink in lock-step with .toggle-btn (it was
       * previously left out, so it stayed full-size while the others shrank),
       * and the icons must scale with the buttons or they overflow.
       */
      @media (max-width: 600px) {
        .toggles-panel {
          height: auto;
          padding: 4px 8px;
          border-radius: 28px;
          flex-wrap: wrap;
          max-width: calc(100vw - 20px);
          row-gap: 4px;
        }
        .toggle-btn,
        .btn-stop {
          height: 44px;
          width: 44px;
          margin: 0 2px;
        }
        .toggle-btn-icon {
          height: 30px;
          width: 30px;
        }
        .hangup-icon {
          height: 22px;
          width: 22px;
        }
        .toggle-sub-btn {
          width: 14px;
          height: 14px;
          border-width: 2px;
        }
      }

      @media (max-width: 460px) {
        .toggles-panel {
          padding: 3px 6px;
        }
        .toggle-btn,
        .btn-stop {
          height: 36px;
          width: 36px;
          margin: 0 1px;
        }
        .toggle-btn-icon {
          height: 24px;
          width: 24px;
        }
        .hangup-icon {
          height: 18px;
          width: 18px;
        }
      }

      @media (max-width: 380px) {
        .toggles-panel {
          padding: 2px 5px;
        }
        .toggle-btn,
        .btn-stop {
          height: 30px;
          width: 30px;
          margin: 0 1px;
        }
        .toggle-btn-icon {
          height: 20px;
          width: 20px;
        }
        .hangup-icon {
          height: 15px;
          width: 15px;
        }
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
        text-align: left;
      }

      .reconnect-menu-item::part(prefix) {
        margin-inline-end: 8px;
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
