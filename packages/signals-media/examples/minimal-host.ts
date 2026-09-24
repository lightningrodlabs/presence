/**
 * Minimal host — voice + filmstrip over a transport you supply.
 *
 * The smallest thing that works: one host record serving both carriers, a
 * mic and a camera from `getUserMedia`, a shared 48 kHz `AudioContext`
 * unlocked by a click, and an `<img>` per peer painted by `FilmstripPlayback`.
 * No Holochain, no presence model, no RTT loop — `holochain-host.ts` beside
 * this file adds all three.
 *
 * The transport is the `Channel` interface below. A WebSocket broadcast relay
 * is the easiest one to write (the package's `testbed/` ships a 40-line one);
 * anything that moves a string to a named peer will do.
 */

import {
  VoiceCarrier,
  FilmstripCarrier,
  FilmstripPlayback,
  type FilmstripHost,
  type MediaKind,
  type PeerId,
  type TrackHandle,
  type VoiceHost,
} from '@lightningrodlabs/signals-media';

// ---------------------------------------------------------------------------
// The transport you supply.
// ---------------------------------------------------------------------------

/**
 * `kind` is the library's `MediaKind` and must reach the receiver intact, so
 * it can be handed back to the matching carrier. Everything else about the
 * channel — framing, auth, retries — is yours.
 */
interface Channel {
  send(peer: PeerId, kind: MediaKind, payload: string): Promise<void>;
  onMessage(handler: (peer: PeerId, kind: MediaKind, payload: string) => void): void;
}

declare const channel: Channel;

/** Everyone we are currently sending media to. Read at every encode. */
const peers = new Set<PeerId>();

// ---------------------------------------------------------------------------
// Devices and the AudioContext.
// ---------------------------------------------------------------------------

let audioCtx: AudioContext | null = null;

/**
 * 48 kHz is a hard requirement, not a preference: the worklet block and the
 * Opus encoder are both configured for it (README, "The AudioContext").
 * Browsers hand out 44.1 kHz by default on some devices, so ask explicitly,
 * and resume inside the gesture.
 */
async function unlockAudio(): Promise<AudioContext> {
  if (!audioCtx) audioCtx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  await audioCtx.resume();
  return audioCtx;
}

/**
 * `release()` is a lease return, not a stop, when a device is shared between
 * consumers (README, "Carrier switching"). Nothing else holds these tracks
 * here, so stopping on release is correct for this example — see
 * `holochain-host.ts` for the refcounted version.
 */
async function acquire(constraints: MediaStreamConstraints): Promise<TrackHandle | null> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    const track = stream.getTracks()[0];
    return { track, release: () => track.stop() };
  } catch (e) {
    console.error('getUserMedia failed', e);
    return null; // the carrier's startCapture() resolves false; it never throws
  }
}

// ---------------------------------------------------------------------------
// The host record — one object, both carriers.
// ---------------------------------------------------------------------------

const host: VoiceHost & FilmstripHost = {
  targets: () => peers,
  // No RTT measure here, so always 'full' (README, "Carrier switching").
  cadence: () => 'full',
  // No capability handshake here, so never batch: one payload goes to every
  // target, and a single peer that cannot parse a batch would lose all audio
  // (README, "Batching and the capability gate").
  batchEligible: () => false,
  async send(kind, payload, targets) {
    await Promise.all([...targets].map(peer => channel.send(peer, kind, payload)));
  },
  clock: { now: () => Date.now() },
  log: line => console.log(line),

  audioContext: () => audioCtx,
  acquireMic: () => acquire({ audio: true }),
  acquireCamera: () => acquire({ video: { width: 320, height: 240 } }),
};

const voice = new VoiceCarrier();
const filmstrip = new FilmstripCarrier();

// ---------------------------------------------------------------------------
// Receive: hand each payload to the carrier its kind names.
// ---------------------------------------------------------------------------

channel.onMessage((peer, kind, payload) => {
  if (kind === 'voice') voice.receiveFrame(peer, payload);
  else filmstrip.receiveFrame(peer, payload);
});

/** One `<img>` and one playback queue per peer. */
const displays = new Map<PeerId, { playback: FilmstripPlayback; stop: () => void }>();

function showPeer(peer: PeerId, img: HTMLImageElement): void {
  const playback = new FilmstripPlayback({
    paint: frame => {
      img.src = frame.url;
    },
    depth: n => filmstrip.setBufferDepth(peer, n),
  });
  // A null frame means "clear": the sender stopped, or the inactivity TTL
  // fired (README, "Receiving video").
  const unsubscribe = filmstrip.subscribe(peer, frame => {
    if (frame === null) playback.clear();
    else playback.push(frame);
  });
  displays.set(peer, { playback, stop: unsubscribe });
}

function hidePeer(peer: PeerId): void {
  const d = displays.get(peer);
  if (!d) return;
  d.stop();
  d.playback.clear();
  displays.delete(peer);
}

// ---------------------------------------------------------------------------
// Start and stop. `start` must be called from a click or tap.
// ---------------------------------------------------------------------------

export async function start(): Promise<void> {
  await unlockAudio();
  // Bind first: the receive side is live from here, and startCapture()
  // returns false on an unbound carrier.
  voice.bind(host);
  filmstrip.bind(host);
  // Both resolve false rather than throwing when a device, the context, the
  // worklet or the codec is unavailable.
  const [voiceOk, videoOk] = await Promise.all([
    voice.startCapture(),
    filmstrip.startCapture(),
  ]);
  if (!voiceOk) console.error('voice capture did not start');
  if (!videoOk) console.error('camera capture did not start');
}

export async function stop(): Promise<void> {
  for (const peer of [...displays.keys()]) hidePeer(peer);
  await Promise.all([voice.stopCapture(), filmstrip.stopCapture()]);
  voice.unbind();
  filmstrip.unbind();
}

export { peers, showPeer, hidePeer };
