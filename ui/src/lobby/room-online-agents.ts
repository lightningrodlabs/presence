import { LitElement, PropertyValues, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { AgentPubKey, AppClient, RoleName } from '@holochain/client';
import { consume } from '@lit/context';
import { localized, msg } from '@lit/localize';

import { clientContext } from '../contexts';
import { RoomClient } from '../room/room-client';
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
  _participants: { pubkey: AgentPubKey; lastSeen: number }[] = [];

  private _unsubscribe: (() => void) | undefined;

  private _gcInterval: number | undefined;

  updated(changed: PropertyValues<this>) {
    if (changed.has('roleName') || changed.has('client')) {
      this._subscribe();
    }
  }

  private _subscribe() {
    this._teardown();
    if (!this.roleName || !this.client) return;
    this._participants = [];
    const roomClient = new RoomClient(this.client, this.roleName);
    // Expire agents that haven't pinged in the last 10 seconds.
    this._gcInterval = window.setInterval(() => {
      const now = Date.now();
      this._participants = this._participants.filter(
        info => now - info.lastSeen < 10000
      );
    }, 10000);
    this._unsubscribe = roomClient.onSignal(signal => {
      if (signal.type === 'Message' && signal.msg_type === 'PingUi') {
        const next = this._participants.filter(
          info => info.pubkey.toString() !== signal.from_agent.toString()
        );
        next.push({ pubkey: signal.from_agent, lastSeen: Date.now() });
        this._participants = next;
      }
      if (signal.type === 'Message' && signal.msg_type === 'LeaveUi') {
        this._participants = this._participants.filter(
          info => info.pubkey.toString() !== signal.from_agent.toString()
        );
      }
    });
  }

  private _teardown() {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = undefined;
    }
    if (this._gcInterval) {
      window.clearInterval(this._gcInterval);
      this._gcInterval = undefined;
    }
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
