/**
 * Holochain host — voice + filmstrip over remote signals.
 *
 * The full shape: a call-membership set that IS the target set, a ping/pong
 * loop that measures the channel and feeds `decideSignalsMediaCadence`, a
 * `media-hello` capability handshake behind `batchEligible()`, a per-peer
 * carrier switch, refcounted devices, and a `FilmstripPlayback` per peer.
 *
 * The zome half is `holochain-zome.rs` beside this file: `send_message`
 * relays an opaque `{ msg_type, payload }` to a list of agents, and
 * `recv_remote_signal` re-emits it to the receiving agent's UI. Nothing in
 * the backend knows what any of these messages mean.
 *
 * Three lines to change first: `ROLE_NAME`/`ZOME_NAME` (yours), `joinCall` /
 * `leaveCall`'s callers (your roster), and `MEDIA_*` below if your app
 * already has a message vocabulary.
 */

import {
  AppWebsocket,
  SignalType,
  encodeHashToBase64,
  decodeHashFromBase64,
  type AgentPubKey,
} from '@holochain/client';
import {
  FilmstripCarrier,
  FilmstripPlayback,
  VoiceCarrier,
  decideSignalsMediaCadence,
  webCodecsOpus,
  type FilmstripHost,
  type MediaKind,
  type OpusCodec,
  type PeerId,
  type SignalsMediaCadence,
  type TrackHandle,
  type VoiceHost,
} from '@lightningrodlabs/signals-media';

// ---------------------------------------------------------------------------
// This app's wire vocabulary.
//
// The library owns exactly two message types — `MediaKind`, i.e. 'voice' and
// 'filmstrip' — and the payload strings under them. EVERYTHING below is this
// application's own vocabulary: the library never sends, parses or reasons
// about a hello, a ping, a pong or a capability string. Rename them freely;
// just keep both ends agreeing.
// ---------------------------------------------------------------------------

const MEDIA_HELLO = 'media-hello';
const MEDIA_PING = 'media-ping';
const MEDIA_PONG = 'media-pong';

/** Advertised in `media-hello` when this build can parse `{ v: 2, frames }`. */
const CAP_VOICE_BATCH = 'voice-batch-v1';

const ROLE_NAME = 'presence';
const ZOME_NAME = 'room';

const PING_INTERVAL_MS = 3000;
/** No pong from anyone for this many intervals = the channel is down. */
const CARRIER_DOWN_INTERVALS = 3;
const RTT_EWMA_ALPHA = 0.2;

interface HelloPayload {
  caps: string[];
}
interface PingPayload {
  nonce: string;
}
interface PongPayload {
  nonce: string;
}

// ---------------------------------------------------------------------------
// State.
// ---------------------------------------------------------------------------

let client: AppWebsocket | null = null;

/**
 * Who we are in a call with. This set IS `host.targets()` — the library reads
 * it at every encode, so adding or removing a peer takes effect on the next
 * frame with no library call (README, "Carrier switching").
 */
const callMembers = new Set<PeerId>();

/** What each peer advertised in its `media-hello`. */
const peerCaps = new Map<PeerId, Set<string>>();

/** Per-peer round-trip EWMA over pong echoes, ms. */
const rttEwmaMs = new Map<PeerId, number>();

/** Outstanding pings: nonce -> send time (wall clock). */
const pingsInFlight = new Map<string, number>();

/** Wall-clock ms of the last pong from anyone — the carrier-down input. */
let lastPongAtMs = 0;

let cadenceMode: SignalsMediaCadence['mode'] = 'full';
let pingTimer: number | null = null;
let audioCtx: AudioContext | null = null;
let codec: OpusCodec | null = null;

// ---------------------------------------------------------------------------
// Sending: one zome call per message, to a list of agents.
// ---------------------------------------------------------------------------

async function sendTo(peers: Iterable<PeerId>, msgType: string, payload: string): Promise<void> {
  const toAgents: AgentPubKey[] = [...peers].map(p => decodeHashFromBase64(p));
  if (toAgents.length === 0 || !client) return;
  await client.callZome({
    role_name: ROLE_NAME,
    zome_name: ZOME_NAME,
    fn_name: 'send_message',
    payload: { to_agents: toAgents, msg_type: msgType, payload },
  });
}

// ---------------------------------------------------------------------------
// Devices, refcounted.
//
// A real app shares the mic with whatever else wants it — a WebRTC carrier,
// a level meter, a recorder. `TrackHandle.release()` is a lease return, so
// the carrier calling it must not stop a track another consumer still holds.
// ---------------------------------------------------------------------------

interface SharedDevice {
  track: MediaStreamTrack;
  refs: number;
}
const devices = new Map<string, SharedDevice>();

async function acquireShared(
  key: string,
  constraints: MediaStreamConstraints
): Promise<TrackHandle | null> {
  const existing = devices.get(key);
  if (existing) {
    existing.refs += 1;
    return { track: existing.track, release: () => releaseShared(key) };
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    const track = stream.getTracks()[0];
    devices.set(key, { track, refs: 1 });
    return { track, release: () => releaseShared(key) };
  } catch (e) {
    // Resolving null (or rejecting — the carrier contains both) makes
    // startCapture() resolve false rather than throw.
    console.error(`${key}: getUserMedia failed`, e);
    return null;
  }
}

function releaseShared(key: string): void {
  const d = devices.get(key);
  if (!d) return;
  d.refs -= 1;
  if (d.refs > 0) return;
  d.track.stop();
  devices.delete(key);
}

// ---------------------------------------------------------------------------
// The host record.
// ---------------------------------------------------------------------------

const host: VoiceHost & FilmstripHost = {
  targets: () => callMembers,
  cadence: () => cadenceMode,

  /**
   * True only when EVERY current target advertised the capability: one
   * payload goes to all of them, so a single peer that cannot parse a batch
   * would lose all audio (README, "Batching and the capability gate"). A peer
   * whose hello has not arrived yet counts as not capable.
   */
  batchEligible: () =>
    callMembers.size > 0 &&
    [...callMembers].every(p => peerCaps.get(p)?.has(CAP_VOICE_BATCH) === true),

  async send(kind: MediaKind, payload: string, targets: ReadonlySet<PeerId>) {
    // `kind` is 'voice' | 'filmstrip'; it travels as the zome's msg_type and
    // is handed back to the matching carrier on the far side.
    await sendTo(targets, kind, payload);
  },

  clock: { now: () => Date.now() },
  log: line => console.log('[signals-media]', line),

  audioContext: () => audioCtx,
  codec: () => {
    // Resolved once in connect(), before bind(). A codec() that throws is
    // contained by the carrier and reads as "no codec" — startCapture()
    // returns false and received frames are dropped, one log per peer.
    if (!codec) throw new Error('opus codec not resolved yet');
    return codec;
  },
  acquireMic: () => acquireShared('mic', { audio: true }),
  acquireCamera: () => acquireShared('camera', { video: { width: 320, height: 240 } }),
};

const voice = new VoiceCarrier();
const filmstrip = new FilmstripCarrier();

// ---------------------------------------------------------------------------
// Receiving.
// ---------------------------------------------------------------------------

/** The zome's `SignalPayload::Message` variant, as it arrives on the client. */
interface ZomeMessageSignal {
  type: string;
  from_agent: Uint8Array;
  msg_type: string;
  payload: string;
}

/**
 * The app's own payloads are remote input too. The library contains its own
 * parse failures; this is the same drop-one-signal guard for ours, so a
 * malformed hello or pong cannot throw out of the signal callback.
 */
function parseJson<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function handleSignal(raw: unknown): void {
  const msg = raw as ZomeMessageSignal;
  if (msg?.type !== 'Message') return; // Ping/Pong variants are the zome's own
  const peer = encodeHashToBase64(msg.from_agent);

  switch (msg.msg_type) {
    case 'voice':
      voice.receiveFrame(peer, msg.payload);
      return;
    case 'filmstrip':
      filmstrip.receiveFrame(peer, msg.payload);
      return;
    case MEDIA_HELLO: {
      const hello = parseJson<HelloPayload>(msg.payload);
      if (hello) peerCaps.set(peer, new Set(hello.caps));
      return;
    }
    case MEDIA_PING: {
      const ping = parseJson<PingPayload>(msg.payload);
      if (ping) void sendTo([peer], MEDIA_PONG, JSON.stringify({ nonce: ping.nonce } satisfies PongPayload));
      return;
    }
    case MEDIA_PONG: {
      const pong = parseJson<PongPayload>(msg.payload);
      // One nonce goes to every target, so the entry is NOT deleted here —
      // every peer echoes the same one, and deleting on the first pong would
      // leave every slower peer without an RTT sample. The sweep in
      // `pingTick` expires it instead.
      const sentAt = pong && pingsInFlight.get(pong.nonce);
      if (!sentAt) return; // unknown or already-expired nonce
      const rtt = Date.now() - sentAt;
      lastPongAtMs = Date.now();
      const prev = rttEwmaMs.get(peer);
      rttEwmaMs.set(peer, prev === undefined ? rtt : RTT_EWMA_ALPHA * rtt + (1 - RTT_EWMA_ALPHA) * prev);
      return;
    }
    default:
      return; // another module's traffic on the same channel
  }
}

// ---------------------------------------------------------------------------
// The ping loop and the cadence verdict.
// ---------------------------------------------------------------------------

function pingTick(): void {
  const nonce = crypto.randomUUID();
  pingsInFlight.set(nonce, Date.now());
  void sendTo(callMembers, MEDIA_PING, JSON.stringify({ nonce } satisfies PingPayload));

  // Re-evaluate on the same tick the pings go out.
  const samples = [...callMembers]
    .map(p => rttEwmaMs.get(p))
    .filter((ms): ms is number => ms !== undefined);
  cadenceMode = decideSignalsMediaCadence({
    // "Nothing has echoed back from anyone" is channel evidence, not peer
    // evidence — it pauses media, it does not decide that a peer is absent.
    carrierDown:
      callMembers.size > 0 &&
      lastPongAtMs !== 0 &&
      Date.now() - lastPongAtMs > CARRIER_DOWN_INTERVALS * PING_INTERVAL_MS,
    // The BEST peer: the cadence is per-channel, and one slow peer must not
    // pause everyone.
    bestRttEwmaMs: samples.length === 0 ? undefined : Math.min(...samples),
    prevMode: cadenceMode,
  }).mode;

  // Expire unanswered pings so the map cannot grow without bound.
  const cutoff = Date.now() - CARRIER_DOWN_INTERVALS * PING_INTERVAL_MS;
  for (const [n, at] of pingsInFlight) if (at < cutoff) pingsInFlight.delete(n);
}

// ---------------------------------------------------------------------------
// Membership and the carrier switch.
// ---------------------------------------------------------------------------

/**
 * Add or remove one peer from the signals carrier.
 *
 * The contract this leans on (README, "Carrier switching"): a target-set
 * change does NOT restart capture, so the receiver keeps the same
 * capture-session epoch and hears no gap; only `stopCapture()` +
 * `startCapture()` produce a new epoch, and a restart is admitted
 * immediately by the receiver. So the reconciler is: start capture when the
 * set first becomes non-empty, stop it when it empties, and do nothing at
 * all in between.
 */
export function useSignalsFor(peer: PeerId, on: boolean): void {
  const wasEmpty = callMembers.size === 0;
  if (on) callMembers.add(peer);
  else callMembers.delete(peer);

  if (on && wasEmpty) {
    void voice.startCapture();
    void filmstrip.startCapture();
  } else if (!on && callMembers.size === 0) {
    void voice.stopCapture();
    void filmstrip.stopCapture();
  }
}

export function joinCall(peer: PeerId): void {
  useSignalsFor(peer, true);
  // Announce what we can parse. The far side gates ITS batching on this.
  void sendTo([peer], MEDIA_HELLO, JSON.stringify({ caps: [CAP_VOICE_BATCH] } satisfies HelloPayload));
}

export function leaveCall(peer: PeerId): void {
  useSignalsFor(peer, false);
  peerCaps.delete(peer);
  rttEwmaMs.delete(peer);
  hidePeer(peer);
}

// ---------------------------------------------------------------------------
// Video display: one playback queue per peer.
// ---------------------------------------------------------------------------

const displays = new Map<PeerId, { playback: FilmstripPlayback; unsubscribe: () => void }>();

export function showPeer(peer: PeerId, img: HTMLImageElement): void {
  hidePeer(peer);
  const playback = new FilmstripPlayback({
    paint: frame => {
      img.src = frame.url;
      // Both timestamps are on the SENDER's clock, so the difference needs no
      // clock sync between machines.
      const audibleAt = voice.getPlayoutSenderTimeMs(peer);
      filmstrip.setAvSkew(peer, audibleAt === null ? null : audibleAt - frame.captureTimeMs);
    },
    depth: n => filmstrip.setBufferDepth(peer, n),
  });
  const unsubscribe = filmstrip.subscribe(peer, frame => {
    if (frame === null) playback.clear();
    else playback.push(frame);
  });
  displays.set(peer, { playback, unsubscribe });
}

export function hidePeer(peer: PeerId): void {
  const d = displays.get(peer);
  if (!d) return;
  d.unsubscribe();
  d.playback.clear();
  displays.delete(peer);
}

// ---------------------------------------------------------------------------
// Connect / disconnect.
// ---------------------------------------------------------------------------

async function resolveCodec(): Promise<OpusCodec> {
  const webCodecs = webCodecsOpus();
  if (webCodecs) return webCodecs;
  // Only reached on engines with no WebCodecs AUDIO (Apple WebKit before
  // Safari 26). Dynamic so `libopus-wasm` is never loaded anywhere else.
  const { wasmOpus } = await import('@lightningrodlabs/signals-media/opus-wasm');
  return wasmOpus();
}

/** Call from a click or tap: the AudioContext must be unlocked by a gesture. */
export async function connect(): Promise<void> {
  client = await AppWebsocket.connect();
  client.on('signal', signal => {
    if (signal.type !== SignalType.App) return;
    handleSignal(signal.value.payload);
  });

  audioCtx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  await audioCtx.resume();
  codec = await resolveCodec();

  // Bind before anything else: the receive side goes live here, and
  // startCapture() on an unbound carrier just returns false.
  voice.bind(host);
  filmstrip.bind(host);

  pingTimer = setInterval(pingTick, PING_INTERVAL_MS);
}

export async function disconnect(): Promise<void> {
  if (pingTimer !== null) clearInterval(pingTimer);
  pingTimer = null;
  for (const peer of [...displays.keys()]) hidePeer(peer);
  callMembers.clear();
  await Promise.all([voice.stopCapture(), filmstrip.stopCapture()]);
  voice.unbind();
  filmstrip.unbind();
  // The AudioContext is ours, not the library's — it drops its reference on
  // unbind and never closes it.
  await audioCtx?.close();
  audioCtx = null;
  client = null;
}
