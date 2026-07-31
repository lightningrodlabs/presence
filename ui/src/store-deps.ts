/**
 * StreamsStoreDeps — the ambient world `StreamsStore` runs against, as one
 * injected record (Phase 6 item 1).
 *
 * The record changes no behavior; its entire value is that it is the
 * minimal change that makes `start()` executable under vitest in node.
 * `static connect` builds the production record from the browser globals
 * and the RoomClient; the wiring tests build it from fakes
 * (`store-deps.testing.ts`). Nothing else may construct one — a second
 * production construction site would be a second wiring authority.
 *
 * Slot semantics (pinned by the wiring tests, do not change silently):
 *  - `clock` is Phase 2's single time authority, moved into the record.
 *  - `storage` keeps LIVE-READ semantics: every getter that consulted
 *    `window.localStorage` on each access still does, through this seam,
 *    so a Settings edit takes effect on the next read without a reload.
 *    Which knobs are live reads versus construction-time snapshots is
 *    production behavior the wiring tests pin (e.g. `dtlsStallTimeoutMs`
 *    is snapshotted at transport construction; `iceServers`/`trickleICE`
 *    are live closures).
 *  - `bus` is the signal fabric: who I am, how signals arrive, how
 *    messages leave. It is the only path wire traffic takes, which is
 *    what lets a node test assert actual outgoing sends.
 *  - `transportFactory` returns `PeerTransport` — the Phase 4 annotation
 *    is what makes an impl-specific reach-in on the result a compile
 *    error. Production yields `FsmTransport`; tests yield a scriptable
 *    fake that can do the nasty things (vanish with no event, replace an
 *    FSM in place, emit duplicate `closed`).
 *  - `mediaDevices` exists so `start()` does not throw on `navigator`;
 *    near-zero assertion value. `MicSource`/`CameraSource` and the
 *    screen-capture acquisition keep their own ambient media-API reads —
 *    they need a real browser and are covered by the harness, not by
 *    node wiring tests (declared out of Phase 6's scope).
 */
import type { AgentPubKey } from '@holochain/client';
import type { Clock } from './clock';
import type { RoomSignal } from './types';
import type { SignalMsgType } from './transport/wire-contract';
import type { PeerTransport, FsmTransportOptions } from './transport';

/** The subset of the Web Storage API the store uses. */
export type KeyValueStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export type StorageDep = {
  /** `window.localStorage` in production — survives reloads; holds the
   *  Settings-panel knobs (TURN, trickle, kill switch, debug overrides). */
  local: KeyValueStore;
  /** `window.sessionStorage` in production — per-tab; holds `blockedAgents`. */
  session: KeyValueStore;
};

/**
 * The Holochain signal fabric, reduced to what the store actually uses.
 * Production adapts `RoomClient`; `myPubKey` is the one identity read
 * (the store derives `myPubKeyB64` from it once, in the constructor).
 */
export type SignalBus = {
  myPubKey: AgentPubKey;
  /** Subscribe to incoming room signals. Returns the unsubscribe. */
  onSignal(handler: (signal: RoomSignal) => void | Promise<void>): () => void;
  /** Send a message signal to the given agents (fire-and-forget wire
   *  semantics; the promise rejects on the local zome call failing, not
   *  on non-delivery). */
  sendMessage(
    toAgents: AgentPubKey[],
    msgType: SignalMsgType,
    payload?: string
  ): Promise<void>;
};

/** Which of the store's three transports is being constructed. Production
 *  ignores it (all three are FsmTransport); test fakes use it to route
 *  scripted events to the right instance. */
export type TransportPurpose = 'media' | 'screen-share-out' | 'screen-share-in';

export type TransportFactory = (
  purpose: TransportPurpose,
  options: FsmTransportOptions
) => PeerTransport;

/** `navigator.mediaDevices` in production. Only what `start()` and
 *  `static connect` touch — device-change listener and enumeration. */
export type MediaDevicesDep = Pick<
  MediaDevices,
  'enumerateDevices' | 'ondevicechange'
>;

export type StreamsStoreDeps = {
  clock: Clock;
  storage: StorageDep;
  bus: SignalBus;
  transportFactory: TransportFactory;
  mediaDevices: MediaDevicesDep;
};
