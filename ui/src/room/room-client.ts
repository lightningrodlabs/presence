import { EntryRecord, ZomeClient } from '@holochain-open-dev/utils';
import { AgentPubKey, AppClient, RoleName, Record, ActionHash } from '@holochain/client';
import {
  Attachment,
  DescendentRoom,
  RoomInfo,
  RoomSignal,
} from '../types';

export class RoomClient extends ZomeClient<RoomSignal> {
  constructor(
    public client: AppClient,
    public roleName: RoleName,
    public zomeName = 'room'
  ) {
    super(client, roleName, zomeName);
  }

  async getAllAgents(local: boolean = true): Promise<AgentPubKey[]> {
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
   * Ping all given agents for passive availability (i.e. not in the front-end), listening for their pong later
   */
  async pingBackend(agentPubKeys: AgentPubKey[]): Promise<void> {
    return this.callZome('ping', agentPubKeys);
  }

  /**
   * Send a generic message to the given agents. The msg_type and payload are
   * opaque to the backend — all semantics are defined in the frontend.
   */
  async sendMessage(toAgents: AgentPubKey[], msgType: string, payload: string = ''): Promise<void> {
    return this.callZome('send_message', {
      to_agents: toAgents,
      msg_type: msgType,
      payload,
    });
  }
}
