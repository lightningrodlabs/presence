import { describe, expect, it } from 'vitest';
import { encodeHashToBase64 } from '@holochain/client';
import { StreamsStore } from '../streams-store';
import { makeFakeDeps } from '../store-deps.testing';
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
 *
 * `webrtcGloballyDisabled` is a getter over `localIntent.webrtc.enabled`
 * (Task 4) — there is no field left to assign directly, so the "is
 * signals iff" case drives `_localIntent` itself, the one authority.
 */

const myPubKey = new Uint8Array(39).fill(1);
const peerA = encodeHashToBase64(new Uint8Array(39).fill(2));

function makeUnstartedStore(): StreamsStore {
  const { deps } = makeFakeDeps({ myPubKey });
  return new StreamsStore(deps, async () => '', {} as PresenceLogger);
}

describe('carrierMode — the one carrier axis', () => {
  it('defaults to webrtc', () => {
    const store = makeUnstartedStore();
    expect(store.webrtcGloballyDisabled).toBe(false);
    expect(store.carrierMode()).toBe('webrtc');
  });

  it('is signals iff webrtcGloballyDisabled', () => {
    const store = makeUnstartedStore();
    store._localIntent.update(intent => ({
      ...intent,
      webrtc: { ...intent.webrtc, enabled: false },
    }));
    expect(store.webrtcGloballyDisabled).toBe(true);
    expect(store.carrierMode()).toBe('signals');
    store._localIntent.update(intent => ({
      ...intent,
      webrtc: { ...intent.webrtc, enabled: true },
    }));
    expect(store.webrtcGloballyDisabled).toBe(false);
    expect(store.carrierMode()).toBe('webrtc');
  });

  it('per-peer control defaults to inherit with no conversation payload', () => {
    const store = makeUnstartedStore();
    expect(store.myPeerCarrier(peerA)).toBe('inherit');
  });
});
