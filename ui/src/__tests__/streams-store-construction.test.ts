import { describe, expect, it } from 'vitest';
import { get } from '@holochain-open-dev/stores';
import { encodeHashToBase64 } from '@holochain/client';
import { StreamsStore } from '../streams-store';
import { ManualClock } from '../clock.testing';
import { makeFakeDeps } from '../store-deps.testing';
import { MEDIA_LIVE_WINDOW_MS, PRESENT_STALENESS_MS } from '../presence-policy';
import { voiceController } from '../room/modules/voice';
import type { PresenceLogger } from '../logging';

/**
 * Phase 2 item 2: the constructor assigns fields and defines derived
 * stores, and does nothing else. Everything ambient (the deps record's
 * world — bus, storage, transports, media devices — plus the module
 * singletons) lives in start().
 *
 * These tests run in the plain node environment — no jsdom, no stubs.
 * Constructing a StreamsStore here failing would mean the constructor
 * regressed into touching the ambient world again (§3.6 / Phase 6).
 * The started store's wiring is covered by streams-store-wiring.test.ts.
 */

const myPubKey = new Uint8Array(39).fill(1);
const myPubKeyB64 = encodeHashToBase64(myPubKey);
const peerA = encodeHashToBase64(new Uint8Array(39).fill(2));
const peerB = encodeHashToBase64(new Uint8Array(39).fill(3));

function makeUnstartedStore(clock: ManualClock): StreamsStore {
  const { deps } = makeFakeDeps({ clock, myPubKey });
  return new StreamsStore(deps, async () => '', {} as PresenceLogger);
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

  it('evicts a stale agent on a presence tick with no _knownAgents write (item 4)', () => {
    const clock = new ManualClock(100_000);
    const store = makeUnstartedStore(clock);
    store._knownAgents.set({
      [peerA]: { pubkey: peerA, type: 'known', lastSeen: clock.now(), appVersion: undefined },
    });

    // Keep a live subscription so the derived store re-evaluates on
    // dependency writes rather than only on get().
    const seen: string[][] = [];
    const unsub = store._activeAgents.subscribe(v => seen.push(Object.keys(v)));
    expect(seen[seen.length - 1]).toEqual([peerA]);

    // Past the staleness window, no _knownAgents write: the tick alone
    // must evict. (start() arms this tick on the store clock every
    // PING_INTERVAL; here we fire it directly.)
    clock.advance(7000);
    store._presenceTick.update(n => n + 1);
    expect(seen[seen.length - 1]).toEqual([]);
    unsub();
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

  it('derives _presentPeers as ping-fresh plus media-connected peers (item 5)', () => {
    const clock = new ManualClock(100_000);
    const store = makeUnstartedStore(clock);
    store._knownAgents.set({
      [peerA]: { pubkey: peerA, type: 'known', lastSeen: clock.now(), appVersion: undefined },
    });
    // peerB has no fresh pong but a connected WebRTC slot — still present.
    store._openConnections.set({
      [peerB]: { connected: true } as never,
    });
    expect(get(store._presentPeers)).toEqual([peerA, peerB]);

    // Drop the connection: peerB leaves the present set.
    store._openConnections.set({});
    expect(get(store._presentPeers)).toEqual([peerA]);
  });

  it('derives _signalsTargets from the present set before start()', () => {
    const clock = new ManualClock(100_000);
    const store = makeUnstartedStore(clock);
    store._knownAgents.set({
      [peerA]: { pubkey: peerA, type: 'known', lastSeen: clock.now(), appVersion: undefined },
    });
    expect(get(store._signalsTargets)).toEqual(new Set([peerA]));
  });

  it('keeps a media-live peer with stale pongs in _signalsTargets (PR #4 F1)', () => {
    // §3.1(b): a peer whose pongs go stale while their signals voice keeps
    // arriving is present. Keying the send set on ping-freshness alone
    // meant we kept hearing them while they stopped hearing us — one-way
    // audio, and after Phase 2's tile fix, a silent one.
    const clock = new ManualClock(100_000);
    const store = makeUnstartedStore(clock);
    store._knownAgents.set({
      [peerA]: { pubkey: peerA, type: 'known', lastSeen: clock.now(), appVersion: undefined },
    });
    voiceController.peerLastRecvMs.set(peerA, clock.now());

    // Past the ping-staleness window but inside the media-live window:
    // no longer ping-fresh, still present, still a signals target.
    clock.advance(PRESENT_STALENESS_MS + 1);
    voiceController.peerLastRecvMs.set(peerA, clock.now());
    store._presenceTick.update(n => n + 1);

    expect(Object.keys(get(store._activeAgents))).toEqual([]);
    expect(get(store._presentPeers)).toEqual([peerA]);
    expect(get(store._signalsTargets)).toEqual(new Set([peerA]));

    // Let the media go stale too: now genuinely absent, and dropped.
    clock.advance(MEDIA_LIVE_WINDOW_MS + 1);
    store._presenceTick.update(n => n + 1);
    expect(get(store._presentPeers)).toEqual([]);
    expect(get(store._signalsTargets)).toEqual(new Set());
    voiceController.peerLastRecvMs.delete(peerA);
  });

  it('excludes a webrtc-connected peer from _signalsTargets (handover still stands down)', () => {
    const clock = new ManualClock(100_000);
    const store = makeUnstartedStore(clock);
    store._knownAgents.set({
      [peerA]: { pubkey: peerA, type: 'known', lastSeen: clock.now(), appVersion: undefined },
    });
    store._openConnections.set({ [peerA]: { connected: true } as never });
    expect(get(store._presentPeers)).toEqual([peerA]);
    expect(get(store._signalsTargets)).toEqual(new Set());
  });
});
