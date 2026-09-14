import { describe, it, expect } from 'vitest';
import { encodeHashToBase64 } from '@holochain/client';
import type { AsyncReadable } from '@holochain-open-dev/stores';
import { RoomStore } from '../room/room-store';

/**
 * `RoomStore` reads the ALL_AGENTS anchor once per poll and derives two
 * views of it: `allAgents` (pubkeys, self excluded — the roster seed
 * `StreamsStore.connect` subscribes to) and `agentJoinedAt` (anchor-link
 * timestamps by pubkey — the grid-order key for `orderTiles`).
 */

const me = new Uint8Array([132, 32, 36, 1, 1, 1]);
const alice = new Uint8Array([132, 32, 36, 2, 2, 2]);
const bob = new Uint8Array([132, 32, 36, 3, 3, 3]);

function awaitComplete<T>(store: AsyncReadable<T>): Promise<T> {
  return new Promise(resolve => {
    const unsub = store.subscribe(v => {
      if (v.status === 'complete') {
        resolve(v.value);
        queueMicrotask(() => unsub());
      }
    });
  });
}

function makeStore() {
  const client = {
    client: { myPubKey: me },
    getAllAgents: async () => [
      { agent: alice, joined_at: 1_700_000_000_000_000 },
      { agent: me, joined_at: 1_700_000_001_000_000 },
      { agent: bob, joined_at: 1_700_000_002_000_000 },
    ],
  };
  return new RoomStore(client as any);
}

describe('RoomStore anchor views', () => {
  it('allAgents lists every anchor agent except self', async () => {
    const agents = await awaitComplete(makeStore().allAgents);
    expect(agents.map(a => encodeHashToBase64(a)).sort()).toEqual(
      [alice, bob].map(a => encodeHashToBase64(a)).sort()
    );
  });

  it('agentJoinedAt keys every anchor agent by base64 pubkey with its link timestamp', async () => {
    const joinedAt = await awaitComplete(makeStore().agentJoinedAt);
    expect(joinedAt).toEqual({
      [encodeHashToBase64(alice)]: 1_700_000_000_000_000,
      [encodeHashToBase64(me)]: 1_700_000_001_000_000,
      [encodeHashToBase64(bob)]: 1_700_000_002_000_000,
    });
  });
});
