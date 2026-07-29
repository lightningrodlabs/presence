import { describe, expect, it } from 'vitest';
import { encodeHashToBase64 } from '@holochain/client';
import { StreamsStore } from '../streams-store';
import { ManualClock } from '../clock.testing';
import type { RoomStore } from '../room/room-store';
import type { PresenceLogger } from '../logging';

/**
 * Phase 4 item 1 — carrier selection has exactly one axis.
 *
 * `carrierMode()` is a named two-value view over `webrtcGloballyDisabled`;
 * Phase 3 deleted the third mode (SimplePeer) and the impl-preference
 * machinery. This pins the mapping so a third mode reappearing — or the
 * getter drifting from the flag — is a failing test, not a rediscovery.
 * The persisted key (`disableAllWebrtc`) is read with `=== 'true'`, so any
 * legacy third value from an old build parses as `false` → 'webrtc'.
 */

const myPubKey = new Uint8Array(39).fill(1);
const peerA = encodeHashToBase64(new Uint8Array(39).fill(2));

function makeUnstartedStore(): StreamsStore {
  const roomStore = {
    client: { client: { myPubKey } },
  } as unknown as RoomStore;
  return new StreamsStore(
    roomStore,
    async () => '',
    {} as PresenceLogger,
    new ManualClock()
  );
}

describe('carrierMode — the one carrier axis', () => {
  it('defaults to webrtc', () => {
    const store = makeUnstartedStore();
    expect(store.webrtcGloballyDisabled).toBe(false);
    expect(store.carrierMode()).toBe('webrtc');
  });

  it('is signals iff webrtcGloballyDisabled', () => {
    const store = makeUnstartedStore();
    store.webrtcGloballyDisabled = true;
    expect(store.carrierMode()).toBe('signals');
    store.webrtcGloballyDisabled = false;
    expect(store.carrierMode()).toBe('webrtc');
  });

  it('per-peer control defaults to inherit with no conversation payload', () => {
    const store = makeUnstartedStore();
    expect(store.myPeerCarrier(peerA)).toBe('inherit');
  });
});
