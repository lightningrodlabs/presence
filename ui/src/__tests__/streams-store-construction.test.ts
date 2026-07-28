import { describe, expect, it } from 'vitest';
import { get } from '@holochain-open-dev/stores';
import { encodeHashToBase64 } from '@holochain/client';
import { StreamsStore } from '../streams-store';
import { ManualClock } from '../clock';
import type { RoomStore } from '../room/room-store';
import type { PresenceLogger } from '../logging';

/**
 * Phase 2 item 2: the constructor assigns fields and defines derived
 * stores, and does nothing else. Everything ambient (window, navigator,
 * the signal bus, transports, module singletons) lives in start().
 *
 * These tests run in the plain node environment — no jsdom, no stubs.
 * Constructing a StreamsStore here failing would mean the constructor
 * regressed into touching the ambient world again (§3.6 / Phase 6).
 */

const myPubKey = new Uint8Array(39).fill(1);
const myPubKeyB64 = encodeHashToBase64(myPubKey);
const peerA = encodeHashToBase64(new Uint8Array(39).fill(2));
const peerB = encodeHashToBase64(new Uint8Array(39).fill(3));

function makeUnstartedStore(clock: ManualClock): StreamsStore {
  const roomStore = {
    client: { client: { myPubKey } },
  } as unknown as RoomStore;
  return new StreamsStore(
    roomStore,
    async () => '',
    {} as PresenceLogger,
    clock
  );
}

describe('StreamsStore construction/activation split', () => {
  it('runs in an environment with no window (guard for the suite itself)', () => {
    expect(typeof window).toBe('undefined');
  });

  it('constructs without start() in a node environment', () => {
    const store = makeUnstartedStore(new ManualClock());
    expect(store.myPubKeyB64).toBe(myPubKeyB64);
  });

  it('evaluates _activeAgents against the injected clock', () => {
    const clock = new ManualClock(100_000);
    const store = makeUnstartedStore(clock);

    store._knownAgents.set({
      [peerA]: { pubkey: peerA, type: 'known', lastSeen: clock.now(), appVersion: undefined },
      [peerB]: { pubkey: peerB, type: 'known', lastSeen: undefined, appVersion: undefined },
      [myPubKeyB64]: { pubkey: myPubKeyB64, type: 'known', lastSeen: clock.now(), appVersion: undefined },
    });

    // Fresh pong, not self, not lastSeen-less: only peerA is active.
    expect(Object.keys(get(store._activeAgents))).toEqual([peerA]);

    // Advance past the staleness window; a store write re-derives.
    clock.advance(7000);
    store._knownAgents.update(v => v);
    expect(Object.keys(get(store._activeAgents))).toEqual([]);
  });

  it('excludes blocked agents from _activeAgents', () => {
    const clock = new ManualClock(100_000);
    const store = makeUnstartedStore(clock);
    store._knownAgents.set({
      [peerA]: { pubkey: peerA, type: 'known', lastSeen: clock.now(), appVersion: undefined },
    });
    store.blockedAgents.set([peerA]);
    expect(Object.keys(get(store._activeAgents))).toEqual([]);
  });

  it('derives _signalsTargets from active agents before start()', () => {
    const clock = new ManualClock(100_000);
    const store = makeUnstartedStore(clock);
    store._knownAgents.set({
      [peerA]: { pubkey: peerA, type: 'known', lastSeen: clock.now(), appVersion: undefined },
    });
    expect(get(store._signalsTargets)).toEqual(new Set([peerA]));
  });
});
