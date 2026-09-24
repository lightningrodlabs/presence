import { asyncDerived, lazyLoadAndPoll } from '@holochain-open-dev/stores';
import { AgentPubKeyB64, encodeHashToBase64 } from '@holochain/client';

import { RoomClient } from './room-client.js';

export class RoomStore {
  constructor(public client: RoomClient) {}

  /**
   * The ALL_AGENTS anchor, polled once; `allAgents` and `agentJoinedAt`
   * are both derived from it so the two views never poll separately.
   */
  allAgentJoins = lazyLoadAndPoll(() => this.client.getAllAgents(), 3000);

  /** Agents (self excluded) — the roster seed `StreamsStore.connect` subscribes to. */
  allAgents = asyncDerived(this.allAgentJoins, joins =>
    joins
      .map(j => j.agent)
      .filter(agent => agent.toString() !== this.client.client.myPubKey.toString())
  );

  /**
   * Anchor-link timestamp (µs) by base64 pubkey, self included — the
   * grid-order key (`orderTiles`, room/tile-order-policy.ts).
   */
  agentJoinedAt = asyncDerived(this.allAgentJoins, joins => {
    const out: Record<AgentPubKeyB64, number> = {};
    for (const j of joins) out[encodeHashToBase64(j.agent)] = j.joined_at;
    return out;
  });

  /** Attachments */
  allAttachments = lazyLoadAndPoll(async () => this.client.getAllAttachments(), 5000);

  /**
   * Connections are to be initiated with agents who's public keys are alphabetically "lower" than our own public key
   */
  agentsToInitiate = asyncDerived(this.allAgents, (allAgents) => allAgents.filter((pubkey) => encodeHashToBase64(this.client.client.myPubKey) > encodeHashToBase64(pubkey)))
}
