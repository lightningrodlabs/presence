import { EntryRecord, ZomeClient, getCellIdFromRoleName } from '@holochain-open-dev/utils';
import {
  AgentPubKey,
  AppClient,
  CellId,
  RoleName,
  Record,
  ActionHash,
  SignalType,
  encodeHashToBase64,
} from '@holochain/client';
import {
  AgentJoin,
  Attachment,
  DescendentRoom,
  RoomInfo,
  RoomSignal,
} from '../types';
import type { SignalMsgType } from '../transport/wire-contract';
import { decodeDirectSignal, encodeDirectSignal } from '../direct-signal';

function sameCell(a: CellId, b: CellId): boolean {
  return (
    encodeHashToBase64(a[0]) === encodeHashToBase64(b[0]) &&
    encodeHashToBase64(a[1]) === encodeHashToBase64(b[1])
  );
}

/**
 * The room zome's client — and, since 0.17.0, the ONE place `Message`
 * traffic touches the conductor's direct-signal API. `sendMessage` is the
 * only caller of `sendDirectSignal`; `onSignal` is the only listener for
 * `SignalType.AppDirect`, re-emitting the `RoomSignal` `Message` shape the
 * store and the presence trackers already handle, so nothing above this
 * class knows the transport changed. The wire body is `direct-signal.ts`.
 */
export class RoomClient extends ZomeClient<RoomSignal> {
  /** This role's cell id (provisioned or clone), resolved on first use. A
   *  failed lookup is forgotten so the next call retries — the app info can
   *  lag a clone that was created a moment ago. */
  private _cellId?: Promise<CellId>;

  constructor(
    public client: AppClient,
    public roleName: RoleName,
    public zomeName = 'room'
  ) {
    super(client, roleName, zomeName);
  }

  private cellId(): Promise<CellId> {
    if (!this._cellId) {
      const lookup = this.client.appInfo().then(info => {
        if (!info) throw new Error(`No app info for ${this.client.installedAppId}`);
        return getCellIdFromRoleName(this.roleName, info);
      });
      lookup.catch(() => {
        if (this._cellId === lookup) this._cellId = undefined;
      });
      this._cellId = lookup;
    }
    return this._cellId;
  }

  /**
   * Subscribe to this room's signals: the zome's own app signals (Pong, the
   * post_commit entry/link signals) AND direct signals from peers, which
   * arrive here as `{ type: 'Message', from_agent, msg_type, payload }` —
   * the shape the zome's `send_message` used to emit. `from_agent` is the
   * conductor's stamp on the envelope, not a field a peer can set.
   */
  onSignal(listener: (signal: RoomSignal) => void | Promise<void>): () => void {
    const unsubscribeApp = super.onSignal(listener);
    const unsubscribeDirect = this.client.on('signal', async signal => {
      if (signal.type !== SignalType.AppDirect) return;
      const { cell_id, from_agent, signal: bytes } = signal.value;
      let mine: boolean;
      try {
        mine = sameCell(cell_id, await this.cellId());
      } catch (e) {
        console.warn(`Dropped direct signal: cannot resolve cell for role ${this.roleName}`, e);
        return;
      }
      if (!mine) return;
      const body = decodeDirectSignal(bytes);
      if (!body.ok) {
        console.warn(
          `Dropped malformed direct signal from ${encodeHashToBase64(from_agent).slice(0, 8)}: ${body.error}`
        );
        return;
      }
      await listener({
        type: 'Message',
        from_agent,
        msg_type: body.value.msg_type,
        payload: body.value.payload,
      });
    });
    return () => {
      unsubscribeApp();
      unsubscribeDirect();
    };
  }

  async getAllAgents(local: boolean = true): Promise<AgentJoin[]> {
    return this.callZome('get_all_agents', { input: null, local });
  }

  async getLatestRoomInfo(local: boolean = true): Promise<RoomInfo> {
    return this.callZome('get_latest_room_info', { input: null, local });
  }

  async getAllAttachments(local: boolean = true): Promise<Array<EntryRecord<Attachment>>> {
    const records: Array<Record> = await this.callZome('get_all_attachments', { input: null, local });
    return records.map((record) => new EntryRecord<Attachment>(record));
  }

  async createAttachment(attachment: Attachment): Promise<EntryRecord<Attachment>> {
    const record = await this.callZome('create_attachment', attachment);
    return new EntryRecord(record);
  }

  async deleteAttachment(actionHash: ActionHash, local: boolean = true): Promise<ActionHash> {
    return this.callZome('delete_attachment', {input: actionHash, local });
  }

  async getAllDescendentRooms(local: boolean = true): Promise<Array<[DescendentRoom, AgentPubKey, ActionHash]>> {
    return this.callZome('get_all_descendent_rooms', { input: null, local });
  }

  async createDescendentRoom(input: DescendentRoom): Promise<ActionHash> {
    return this.callZome('create_descendent_room', input)
  }

  async getRoomInfo(local: boolean = true): Promise<RoomInfo | undefined> {
    const maybeRoomInfoRecord: Record | undefined = await this.callZome('get_room_info', { input: null, local });
    if (maybeRoomInfoRecord) {
      const entryRecord = new EntryRecord<RoomInfo>(maybeRoomInfoRecord);
      return entryRecord.entry;
    }
    return undefined;
  }

  async setRoomInfo(roomInfo: RoomInfo): Promise<void> {
    return this.callZome('set_room_info', roomInfo);
  }

  /**
   * Ping all given agents for passive availability (i.e. not in the front-end), listening for their pong later.
   * Stays a zome call on purpose: the zome answers the ping even when no UI is open (decision D1).
   */
  async pingBackend(agentPubKeys: AgentPubKey[]): Promise<void> {
    return this.callZome('ping', agentPubKeys);
  }

  /**
   * Send a generic message to the given agents as a direct signal — no zome
   * call on either side, payload up to 1 MiB. The msg_type and payload are
   * opaque to the conductor; all semantics are defined in the frontend.
   *
   * `msgType` is typed against the declared wire surface
   * (`transport/wire-contract.ts`): putting a new type on the wire requires
   * adding it to `SIGNAL_MSG_TYPES`, which forces a `WIRE_CONTRACT` row and
   * the `fixtures/wire-contract.json` update ceremony.
   *
   * Resolves once the local conductor accepted the request; delivery is
   * best effort, as it was over remote signals.
   */
  async sendMessage(toAgents: AgentPubKey[], msgType: SignalMsgType, payload: string = ''): Promise<void> {
    if (toAgents.length === 0) return;
    const [dnaHash] = await this.cellId();
    await this.client.sendDirectSignal({
      dna_hash: dnaHash,
      agents: toAgents,
      signal: encodeDirectSignal(msgType, payload),
    });
  }
}
