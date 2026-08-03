// @vitest-environment jsdom
/**
 * Round 3 item 4a — the maximize-key bug.
 *
 * `_maximizedVideo` is a string with several key families; share tiles
 * are keyed `share-${moduleId}-${pubkey}` (now `shareMaximizeKey`), but
 * the `my-screen-share-off` arm compared against the <video> element id
 * `'my-own-screen'` — a key no tile is ever laid out by — so stopping
 * your own maximized screen share left `_maximizedVideo` on a dead key,
 * `idToLayout` answered 'hidden' for everything, and the room blanked
 * until a double-click. These pins drive the REAL `_onStoreEvent` arms
 * (extracted from the firstUpdated closure for exactly this) and were
 * red against the pre-fix comparison.
 */
import { describe, it, expect, vi } from 'vitest';

// logs-graph pulls plotly.js, which does not survive jsdom import; see
// view-teardown-symmetry.test.ts for the standing rationale.
vi.mock('../room/logs-graph', () => ({}));

import '../room/room-view';
import { encodeHashToBase64 } from '@holochain/client';
import type { AgentPubKey } from '@holochain/client';
import { shareMaximizeKey } from '../room/modules/registry';

const myPubKey = new Uint8Array(39).fill(7) as AgentPubKey;
const myB64 = encodeHashToBase64(myPubKey);
const peerB64 = encodeHashToBase64(new Uint8Array(39).fill(9) as AgentPubKey);

function makeRoomView(): any {
  const el = document.createElement('room-view') as any;
  el.streamsStore = { disconnect: vi.fn() };
  // The only roomStore member the my-screen-share-off arm reads.
  el.roomStore = { client: { client: { myPubKey } } };
  return el;
}

describe('share maximize keys clear through the real event arms', () => {
  it('stopping my own maximized share clears _maximizedVideo (the item-4a repro)', async () => {
    const el = makeRoomView();
    el._maximizedVideo = shareMaximizeKey('screen-share', myB64);
    await el._onStoreEvent({ type: 'my-screen-share-off' });
    expect(el._maximizedVideo).toBeUndefined();
  });

  it("a peer's share disconnect clears their maximized tile", async () => {
    const el = makeRoomView();
    el._maximizedVideo = shareMaximizeKey('screen-share', peerB64);
    await el._onStoreEvent({
      type: 'peer-screen-share-disconnected',
      pubKeyB64: peerB64,
      connectionId: 'c-1',
    });
    expect(el._maximizedVideo).toBeUndefined();
  });

  it('negative control: an unrelated maximized tile survives both events', async () => {
    const el = makeRoomView();
    const unrelated = shareMaximizeKey('screen-share', peerB64);
    el._maximizedVideo = unrelated;
    await el._onStoreEvent({ type: 'my-screen-share-off' });
    expect(el._maximizedVideo).toBe(unrelated);

    el._maximizedVideo = shareMaximizeKey('wal', peerB64);
    await el._onStoreEvent({
      type: 'peer-screen-share-disconnected',
      pubKeyB64: peerB64,
      connectionId: 'c-2',
    });
    expect(el._maximizedVideo).toBe(shareMaximizeKey('wal', peerB64));
  });

  it('the tile render and the event arms share ONE key constructor', () => {
    // The bug was four independent encodings of this key. The
    // constructor is the authority; this pins its shape so a drift in
    // any consumer is a visible decision against this row.
    expect(shareMaximizeKey('screen-share', 'PUBKEY')).toBe(
      'share-screen-share-PUBKEY'
    );
  });
});
