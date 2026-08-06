import { consume } from '@lit/context';
import { hashProperty } from '@holochain-open-dev/elements';
import { css, html, LitElement, PropertyValueMap } from 'lit';
import { property, customElement } from 'lit/decorators.js';
import { AgentPubKey, encodeHashToBase64 } from '@holochain/client';
import { localized } from '@lit/localize';
import { StoreSubscriber } from '@holochain-open-dev/stores';

import '@holochain-open-dev/elements/dist/elements/display-error.js';
import '@shoelace-style/shoelace/dist/components/avatar/avatar.js';
import '@shoelace-style/shoelace/dist/components/icon/icon.js';
import '@shoelace-style/shoelace/dist/components/skeleton/skeleton.js';
import '@shoelace-style/shoelace/dist/components/tooltip/tooltip.js';
import { mdiMicrophone, mdiVideo } from '@mdi/js';
import { wrapPathInSvg } from '@holochain-open-dev/elements';

import {
  profilesStoreContext,
  ProfilesStore,
  Profile,
} from '@holochain-open-dev/profiles';
import { EntryRecord } from '@holochain-open-dev/utils';
import { AudioLinkState, ConnectionStatus, LastSeenBucket } from '../../types';
import {
  audioLinkToColor,
  audioLinkToText,
  connectionStatusToColor,
  lastSeenBucketToColor,
  lastSeenBucketToText,
} from '../../utils';
import { lastSeenBucket } from '../../presence-policy';
import { sharedStyles } from '../../sharedStyles';
import '../../shared/holo-identicon';

@localized()
@customElement('agent-connection-status-icon')
export class AgentConnectionStatusIcon extends LitElement {
  /** Public properties */

  /**
   * REQUIRED. The public key identifying the agent whose profile is going to be shown.
   */
  @property(hashProperty('agent-pub-key'))
  agentPubKey!: AgentPubKey;

  /**
   * Size of the avatar image in pixels.
   */
  @property({ type: Number })
  size = 30;

  @property()
  connectionStatus: ConnectionStatus | undefined;

  /**
   * AudioLink state from the observer's point of view. When provided,
   * drives the ring color instead of `connectionStatus` — so the ring
   * reflects "can this observer hear this agent" rather than pure WebRTC
   * negotiation phase.
   */
  @property()
  audioLink: AudioLinkState | undefined;

  @property()
  onlyToldAbout = false;

  /**
   * Freshness bucket of the observer's last pong from this agent. Drives
   * the corner dot color without clock-skew sensitivity (the bucket is
   * computed by the observer, not by us comparing timestamps). Falls back
   * to the legacy `lastSeen` timestamp when absent.
   */
  @property()
  lastSeenBucket: LastSeenBucket | undefined;

  @property()
  lastSeen: number | undefined;

  /**
   * Observer-computed bucket when broadcast; otherwise derived from the
   * raw `lastSeen` timestamp with the shared bucket decision in
   * presence-policy.ts — the thresholds are no longer duplicated here.
   *
   * The fallback compares against wall clock deliberately: every caller
   * that could supply a *locally*-stamped `lastSeen` now passes
   * `lastSeenBucket` instead (room-view's my-video / my-screen-share
   * paths), so the only input that reaches this line is a remote peer's
   * timestamp — a cross-peer wire comparison, which wall clock is the
   * correct timebase for. This is the file's ONE sanctioned ambient
   * wall-clock read, held to exactly one call by no-ambient-clock.test.ts
   * — a second one anywhere in this file (comments included) fails it.
   */
  private _effectiveLastSeenBucket(): LastSeenBucket {
    return this.lastSeenBucket ?? lastSeenBucket(this.lastSeen, Date.now());
  }

  @property({ type: String })
  audioStatus: 'live' | 'stale' | 'muted' | 'off' | undefined;

  @property({ type: String })
  videoStatus: 'live' | 'muted' | 'off' | undefined;

  @property({ type: String })
  audioCarrier: 'webrtc' | 'signals' | 'none' | undefined;

  /** Dependencies */

  /**
   * Profiles store for this element, not required if you embed this element inside a <profiles-context>
   */
  @consume({ context: profilesStoreContext, subscribe: true })
  @property()
  store!: ProfilesStore;

  /**
   * @internal
   */
  private _agentProfile = new StoreSubscriber(
    this,
    () => this.store.profiles.get(this.agentPubKey)!,
    () => [this.agentPubKey, this.store]
  );

  async willUpdate(
    changedProperties: PropertyValueMap<any> | Map<PropertyKey, unknown>
  ) {
    if (changedProperties.has('agentPubKey')) {
      this.requestUpdate();
    }
  }

  /**
   * @internal
   */
  timeout: any;

  statusToText(status?: ConnectionStatus) {
    if (!status) return 'disconnected';
    switch (status.type) {
      case 'Connected':
        return 'connected';
      case 'Disconnected':
        return 'disconnected';
      case 'AwaitingInit':
        return 'waiting for init request...';
      case 'InitSent':
        return `waiting for init accept${
          status.attemptCount && status.attemptCount > 1
            ? `(attempt #${status.attemptCount})`
            : ''
        }...`;
      case 'AcceptSent':
        return `waiting for SDP exchange${
          status.attemptCount && status.attemptCount > 1
            ? `(attempt #${status.attemptCount})`
            : ''
        }...`;
      case 'SdpExchange':
        return 'exchanging SDP data...';
      case 'Blocked':
        return 'Blocked';
      default:
        return 'unknown status type';
    }
  }

  renderProfile(profile: EntryRecord<Profile> | undefined) {
    const ringColor = this.audioLink
      ? audioLinkToColor(this.audioLink)
      : connectionStatusToColor(this.connectionStatus);
    const dim =
      this.audioLink
        ? this.audioLink === 'absent' || this.audioLink === 'unknown'
        : !this.connectionStatus ||
          this.connectionStatus.type === 'Disconnected';
    // When the observer doesn't see this agent in the room, audio/video
    // icons would be meaningless ("not in room" already implies no flow).
    const hideTrackIcons =
      this.audioLink === 'absent' || this.audioLink === 'unknown';
    const linkText = this.audioLink
      ? audioLinkToText(this.audioLink)
      : this.statusToText(this.connectionStatus);
    return html`
      <sl-tooltip
        class="tooltip-filled"
        placement="top"
        hoist
        content=${`${
          profile ? profile.entry.nickname : 'Unknown'
        } (${linkText})${
          this.audioStatus ? ` | audio: ${this.audioStatus}` : ''
        }${this.videoStatus ? ` | video: ${this.videoStatus}` : ''}${
          this.audioCarrier && this.audioCarrier !== 'none'
            ? ` via ${this.audioCarrier}`
            : ''
        }`}
      >
        <div
          class="row"
          style="position: relative; align-items: center; margin: 0; padding: 0; ${dim
            ? 'opacity: 0.5'
            : ''}"
        >
          ${this.onlyToldAbout
            ? html`
                <sl-tooltip
                  hoist
                  class="tooltip-filled tooltip-red"
                  placement="bottom"
                  content="has only learnt through signals from others that this person is part of the room"
                >
                  <div class="only-told-indicator tertiary-font">!</div>
                </sl-tooltip>
              `
            : html`
                <sl-tooltip
                  hoist
                  class="tooltip-filled"
                  placement="bottom"
                  content="${lastSeenBucketToText(this._effectiveLastSeenBucket())}"
                  style="--sl-tooltip-background-color: ${lastSeenBucketToColor(
                    this._effectiveLastSeenBucket()
                  )};"
                >
                  <div
                    class="last-seen-indicator"
                    style="background: ${lastSeenBucketToColor(
                      this._effectiveLastSeenBucket()
                    )};"
                  ></div>
                </sl-tooltip>
              `}
          ${profile && profile.entry.fields.avatar
            ? html`
                <img
                  style="height: ${this.size}px; width: ${this
                    .size}px; border-radius: 50%; border: 3px solid ${ringColor};"
                  src=${profile.entry.fields.avatar}
                  alt="${profile.entry.nickname}'s avatar"
                />
              `
            : html`
                <holo-identicon
                  .disableCopy=${true}
                  .disableTooltip=${true}
                  .hash=${this.agentPubKey}
                  .size=${this.size}
                  title="${encodeHashToBase64(this.agentPubKey)}"
                  style="border-radius: 50%; border: 3px solid ${ringColor};"
                >
                </holo-identicon>
              `}
          ${!hideTrackIcons &&
          (this.audioStatus !== undefined || this.videoStatus !== undefined)
            ? html`
                <div class="track-indicators">
                  ${this.audioStatus !== undefined
                    ? html`<sl-tooltip
                        hoist
                        class="tooltip-filled"
                        placement="top"
                        content="audio: ${this.audioStatus}${this.audioCarrier &&
                        this.audioCarrier !== 'none'
                          ? ` (${this.audioCarrier})`
                          : ''}"
                      >
                        <sl-icon
                          class="track-icon"
                          style="color: ${audioTrackColor(
                            this.audioStatus
                          )};"
                          .src=${wrapPathInSvg(mdiMicrophone)}
                        ></sl-icon>
                      </sl-tooltip>`
                    : html``}
                  ${this.videoStatus !== undefined
                    ? html`<sl-tooltip
                        hoist
                        class="tooltip-filled"
                        placement="top"
                        content="video: ${this.videoStatus}"
                      >
                        <sl-icon
                          class="track-icon"
                          style="color: ${videoTrackColor(this.videoStatus)};"
                          .src=${wrapPathInSvg(mdiVideo)}
                        ></sl-icon>
                      </sl-tooltip>`
                    : html``}
                </div>
              `
            : html``}
        </div>
      </sl-tooltip>
    `;
  }

  render() {
    switch (this._agentProfile.value.status) {
      case 'pending':
        return html`<sl-skeleton
          effect="pulse"
          style="height: ${this.size}px; width: ${this.size}px"
        ></sl-skeleton>`;
      case 'complete':
        return this.renderProfile(this._agentProfile.value.value);
      case 'error':
        console.error(
          'Failed to get agent profile: ',
          this._agentProfile.value.status
        );
        return this.renderProfile(undefined);
      default:
        return html``;
    }
  }

  static styles = [
    sharedStyles,
    css`
      .tooltip-filled {
        --sl-tooltip-background-color: #c3c9eb;
        --sl-tooltip-arrow-size: 6px;
        --sl-tooltip-border-radius: 5px;
        --sl-tooltip-padding: 4px;
        --sl-tooltip-font-size: 14px;
        --sl-tooltip-color: #0d1543;
        --sl-tooltip-font-family: 'Ubuntu', sans-serif;
      }

      .tooltip-red {
        --sl-tooltip-background-color: #ebc3c3;
      }

      .only-told-indicator {
        position: absolute;
        bottom: -1px;
        right: -1px;
        font-weight: bold;
        color: white;
        font-size: 12px;
        background: red;
        border-radius: 50%;
        width: 14px;
        height: 14px;
      }

      .last-seen-indicator {
        position: absolute;
        bottom: -1px;
        right: -1px;
        font-weight: bold;
        border-radius: 50%;
        width: 14px;
        height: 14px;
      }

      .track-indicators {
        position: absolute;
        top: -14px;
        left: 50%;
        transform: translateX(-50%);
        display: flex;
        flex-direction: row;
        gap: 0px;
      }

      .track-icon {
        font-size: 16px;
      }
    `,
  ];
}

function audioTrackColor(
  status: 'live' | 'stale' | 'muted' | 'off',
): string {
  switch (status) {
    case 'live':
      return '#0886e7';
    case 'stale':
      return '#e7a008'; // amber — connected but not actually flowing
    case 'muted':
      return '#e7bb08';
    case 'off':
      return 'gray';
  }
}

function videoTrackColor(status: 'live' | 'muted' | 'off'): string {
  switch (status) {
    case 'live':
      return '#0886e7';
    case 'muted':
      return '#e7bb08';
    case 'off':
      return 'gray';
  }
}

