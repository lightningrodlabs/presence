import { LitElement, PropertyValues, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { AppClient, RoleName } from '@holochain/client';
import { consume } from '@lit/context';
import { localized, msg } from '@lit/localize';

import { clientContext } from '../contexts';
import { RoomClient } from '../room/room-client';
import {
  PassiveParticipant,
  PassivePresenceTracker,
} from '../passive-presence';
import { sharedStyles } from '../sharedStyles';
import './list-online-agents';

/**
 * Shows the avatars of agents currently present in a room, tracked via the
 * room's PingUi / LeaveUi signals — without joining the call. Pings are sent to
 * all cell agents (see StreamsStore.pingAgents), so any cell member can observe
 * presence passively. Reused by the lobby room cards and the asset "enter room"
 * pane so the tracking lives in exactly one place.
 */
@localized()
@customElement('room-online-agents')
export class RoomOnlineAgents extends LitElement {
  @consume({ context: clientContext })
  @state()
  client!: AppClient;

  @property()
  roleName!: RoleName;

  @property()
  avatarSize: number | undefined;

  /** Text shown when no one is in the room. */
  @property()
  emptyText = msg('room is empty');

  /** Optional prefix shown before the avatars when the room is non-empty. */
  @property()
  label: string | undefined;

  @state()
  _participants: PassiveParticipant[] = [];

  private _unsubscribe: (() => void) | undefined;

  private _tracker = new PassivePresenceTracker(list => {
    this._participants = list;
  });

  willUpdate(changed: PropertyValues<this>) {
    // Reset the list when the watched room changes. Done in willUpdate (part of
    // the current update) and only when non-empty, so it never schedules an
    // extra update from within updated() (Lit's change-in-update warning).
    if (
      (changed.has('roleName') || changed.has('client')) &&
      this._participants.length
    ) {
      this._participants = [];
    }
  }

  updated(changed: PropertyValues<this>) {
    if (changed.has('roleName') || changed.has('client')) {
      this._subscribe();
    }
  }

  private _subscribe() {
    this._teardown();
    if (!this.roleName || !this.client) return;
    const roomClient = new RoomClient(this.client, this.roleName);
    this._tracker.start();
    this._unsubscribe = roomClient.onSignal(signal =>
      this._tracker.handleSignal(signal)
    );
  }

  private _teardown() {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = undefined;
    }
    this._tracker.stop();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this._teardown();
  }

  render() {
    if (this._participants.length === 0) {
      return html`<span>${this.emptyText}</span>`;
    }
    return html`
      <div class="row center-content" style="gap: 8px;">
        ${this.label ? html`<span>${this.label}</span>` : ''}
        <list-online-agents
          .avatarSize=${this.avatarSize}
          .agents=${this._participants.map(info => info.pubkey)}
        ></list-online-agents>
      </div>
    `;
  }

  static styles = [sharedStyles];
}
