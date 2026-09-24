import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MicSource } from '../mic-source';
import type { MicSourceBindings } from '../mic-source';
import { ManualClock } from '../clock.testing';

class FakeTrack {
  readyState: 'live' | 'ended' = 'live';
  enabled = true;
  onended: (() => void) | null = null;
  constructor(public kind: 'audio' | 'video', public label = '') {}
  stop(): void {
    if (this.readyState === 'ended') return;
    this.readyState = 'ended';
    this.onended?.();
  }
}
class FakeStream {
  constructor(private tracks: FakeTrack[]) {}
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
  getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); }
}
/** `new MediaStream([track])` as the mix graph builds its source streams. */
class FakeMediaStream extends FakeStream {
  constructor(tracks: FakeTrack[] = []) { super(tracks); }
}

/** Counts graph operations; a source node remembers the stream it wraps. */
class FakeAudioContext {
  readonly sampleRate = 48000;
  state = 'running';
  sources: Array<{ stream: FakeStream; connected: boolean }> = [];
  destinations: Array<{ track: FakeTrack; node: { channelCount: number } }> = [];
  /** One-shot: the next createMediaStreamSource throws, as a real context
   *  does when the graph cannot take another node. Both places MicSource
   *  builds source nodes (`_buildMix`, `_replaceMixDeviceNode`) must
   *  survive it. */
  failNextSource = false;
  /** Every createMediaStreamSource throws (a context that is gone). */
  failAlways = false;
  createMediaStreamSource(stream: FakeStream) {
    if (this.failNextSource || this.failAlways) {
      this.failNextSource = false;
      throw new Error('createMediaStreamSource failed');
    }
    const node = { stream, connected: false, connect: () => { node.connected = true; }, disconnect: () => { node.connected = false; } };
    this.sources.push(node);
    return node;
  }
  createMediaStreamDestination() {
    const track = new FakeTrack('audio', 'mixed');
    // Starts at the Web Audio default (a MediaStreamAudioDestinationNode
    // is stereo unless the caller narrows it), so MicSource's mono write
    // is observable rather than assumed.
    const node = { stream: new FakeStream([track]), channelCount: 2 };
    this.destinations.push({ track, node });
    return node;
  }
  resumeCalls = 0;
  resume = async () => { this.resumeCalls += 1; this.state = 'running'; };
  close = async () => {};
}

function installGlobals(respond: () => Promise<FakeStream>) {
  const calls: unknown[] = [];
  Object.defineProperty(globalThis, 'navigator', {
    value: { mediaDevices: { getUserMedia: async (c: unknown) => { calls.push(c); return respond(); } } },
    configurable: true,
    writable: true,
  });
  (globalThis as any).MediaStream = FakeMediaStream;
  (globalThis as any).AudioContext = FakeAudioContext;
  return { calls };
}

function rig() {
  const clock = new ManualClock(1_000);
  const fanout: Array<{ newTrack: unknown; oldTrack: unknown }> = [];
  /** `readyState` of the old track AS SEEN BY the fanout — the stop-the-
   *  old-last order (`_openAndSwap`) means consumers never see an ended
   *  track before its replacement. */
  const oldStateAtFanout: Array<string | null> = [];
  const dropped: string[] = [];
  let deviceId: string | undefined;
  const bindings: MicSourceBindings = {
    getDeviceId: () => deviceId,
    setDeviceId: id => { deviceId = id; },
    onTrackChange: (n, o) => {
      fanout.push({ newTrack: n, oldTrack: o });
      oldStateAtFanout.push(o ? (o as unknown as FakeTrack).readyState : null);
    },
    onMutedChange: () => {},
    onLifecycleChange: () => {},
    onMixinDropped: reason => void dropped.push(reason),
    now: () => clock.now(),
  };
  const mic = new MicSource(bindings);
  return { mic, fanout, oldStateAtFanout, dropped, clock };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as any).navigator;
  delete (globalThis as any).MediaStream;
  delete (globalThis as any).AudioContext;
});

describe('MicSource mixin: build, tear, and what consumers see', () => {
  let device: FakeTrack;
  beforeEach(() => {
    device = new FakeTrack('audio', 'device');
    installGlobals(async () => new FakeStream([device]));
  });

  it('setMixin builds the mix: the output is the destination track, consumers and the store fanout see ONE swap', async () => {
    const r = rig();
    const consumerSwaps: unknown[] = [];
    const handle = await r.mic.acquire({ id: 'c', onTrackChanged: t => void consumerSwaps.push(t) });
    expect(handle!.track).toBe(device as unknown as MediaStreamTrack);
    r.fanout.length = 0;

    const mixin = new FakeTrack('audio', 'system');
    expect(r.mic.setMixin(mixin as unknown as MediaStreamTrack)).toBe(true);

    const ctx = (r.mic.ensureAudioContext() as unknown) as FakeAudioContext;
    expect(ctx.sources.map(s => s.stream.getAudioTracks()[0])).toEqual([device, mixin]);
    expect(ctx.sources.every(s => s.connected)).toBe(true);
    const mixed = ctx.destinations[0].track;
    expect(r.mic.track).toBe(mixed as unknown as MediaStreamTrack);
    expect(r.mic.deviceTrack).toBe(device as unknown as MediaStreamTrack);
    expect(r.mic.outputMode).toBe('mixed');
    expect(r.fanout).toEqual([{ newTrack: mixed, oldTrack: device }]);
    expect(consumerSwaps).toEqual([mixed]);
    expect(device.readyState).toBe('live'); // the device keeps feeding the graph
    // Mono: a stereo destination would feed 2-channel AudioData into the
    // voice module's 1-channel AudioEncoder, which closes the encoder.
    expect(ctx.destinations[0].node.channelCount).toBe(1);
  });

  it('setMixin(null) tears the mix back to the device track with one swap; the destination track is stopped', async () => {
    const r = rig();
    const consumerSwaps: unknown[] = [];
    await r.mic.acquire({ id: 'c', onTrackChanged: t => void consumerSwaps.push(t) });
    const mixin = new FakeTrack('audio', 'system');
    r.mic.setMixin(mixin as unknown as MediaStreamTrack);
    const ctx = (r.mic.ensureAudioContext() as unknown) as FakeAudioContext;
    const mixed = ctx.destinations[0].track;
    r.fanout.length = 0; consumerSwaps.length = 0; r.oldStateAtFanout.length = 0;

    expect(r.mic.setMixin(null)).toBe(false);
    expect(r.mic.track).toBe(device as unknown as MediaStreamTrack);
    expect(r.mic.outputMode).toBe('device');
    expect(r.fanout).toEqual([{ newTrack: device, oldTrack: mixed }]);
    expect(consumerSwaps).toEqual([device]);
    expect(ctx.sources.every(s => !s.connected)).toBe(true);
    expect(mixed.readyState).toBe('ended');
    // …but only AFTER the swap fanned out: the old track is stopped last.
    expect(r.oldStateAtFanout).toEqual(['live']);
    expect(mixin.readyState).toBe('live'); // the mixin belongs to the caller (the capture object stops it)
    expect(r.dropped).toEqual([]); // the caller removed it; nothing to report
  });

  it('a device that died without its event, under a mix, tears it on the next reconcile and reports device-closed', async () => {
    const r = rig();
    await r.mic.acquire({ id: 'c' });
    const mixin = new FakeTrack('audio', 'system');
    r.mic.setMixin(mixin as unknown as MediaStreamTrack);
    r.fanout.length = 0;
    // Ended without `onended` firing (the FakeTrack fires it; bypass it).
    device.readyState = 'ended';
    expect(r.mic.setMixin(mixin as unknown as MediaStreamTrack)).toBe(false);
    expect(r.mic.outputMode).toBe('device');
    expect(r.dropped).toEqual(['device-closed']);
    // The mixin is not kept for a rebuild nobody would perform.
    expect(r.mic.setMixin(mixin as unknown as MediaStreamTrack)).toBe(false);
    expect(r.dropped).toEqual(['device-closed']); // no second report: it was already gone
  });

  it('a mixin track that ends underneath the mix tears it and reports mixin-ended', async () => {
    const r = rig();
    await r.mic.acquire({ id: 'c' });
    const mixin = new FakeTrack('audio', 'system');
    r.mic.setMixin(mixin as unknown as MediaStreamTrack);
    r.fanout.length = 0;
    mixin.stop();
    // MicSource observes the track on its next reconcile, not by event —
    // the store's `capture.onended` is the push path; this is the pull.
    expect(r.mic.setMixin(mixin as unknown as MediaStreamTrack)).toBe(false);
    expect(r.mic.outputMode).toBe('device');
    expect(r.fanout).toEqual([{ newTrack: device, oldTrack: expect.anything() }]);
    expect(r.dropped).toEqual([]); // setMixin with an ended track is the caller's own removal
  });

  it('a suspended context is resumed when the mix is built and under the gesture (resumeAudioContext)', async () => {
    const r = rig();
    await r.mic.acquire({ id: 'c' });
    const ctx = (r.mic.ensureAudioContext() as unknown) as FakeAudioContext;
    const atCreation = ctx.resumeCalls; // ensureAudioContext resumes once at creation
    ctx.state = 'suspended';
    r.mic.setMixin(new FakeTrack('audio', 'system') as unknown as MediaStreamTrack);
    expect(ctx.resumeCalls).toBe(atCreation + 1);
    ctx.state = 'suspended';
    r.mic.resumeAudioContext();
    expect(ctx.resumeCalls).toBe(atCreation + 2);
    ctx.state = 'running';
    r.mic.resumeAudioContext();
    expect(ctx.resumeCalls).toBe(atCreation + 2); // running: nothing to resume
  });

  it('an ended mixin is refused (negative control for the ended arm)', async () => {
    const r = rig();
    await r.mic.acquire({ id: 'c' });
    const mixin = new FakeTrack('audio', 'system');
    mixin.stop();
    r.fanout.length = 0;
    expect(r.mic.setMixin(mixin as unknown as MediaStreamTrack)).toBe(false);
    expect(r.mic.outputMode).toBe('device');
    expect(r.fanout).toEqual([]);
  });

  it('no AudioContext → the mixin is refused and the device track keeps flowing (Review Focus 5)', async () => {
    const r = rig();
    await r.mic.acquire({ id: 'c' });
    delete (globalThis as any).AudioContext;
    r.fanout.length = 0;
    expect(r.mic.setMixin(new FakeTrack('audio') as unknown as MediaStreamTrack)).toBe(false);
    expect(r.mic.track).toBe(device as unknown as MediaStreamTrack);
    expect(r.fanout).toEqual([]);
  });

  it('mute writes enabled on the output AND the device; unmute restores both (Review Focus 3)', async () => {
    const r = rig();
    await r.mic.acquire({ id: 'c' });
    const mixin = new FakeTrack('audio', 'system');
    r.mic.setMixin(mixin as unknown as MediaStreamTrack);
    const mixed = ((r.mic.ensureAudioContext() as unknown) as FakeAudioContext).destinations[0].track;
    r.mic.setMuted(true);
    expect(mixed.enabled).toBe(false);
    expect(device.enabled).toBe(false);
    r.mic.setMuted(false);
    expect(mixed.enabled).toBe(true);
    expect(device.enabled).toBe(true);
  });

  it('a mixin installed while muted starts muted', async () => {
    const r = rig();
    await r.mic.acquire({ id: 'c' });
    r.mic.setMuted(true);
    r.mic.setMixin(new FakeTrack('audio') as unknown as MediaStreamTrack);
    const mixed = ((r.mic.ensureAudioContext() as unknown) as FakeAudioContext).destinations[0].track;
    expect(mixed.enabled).toBe(false);
  });
});

describe('MicSource mixin: device swaps and close', () => {
  it('a device change while mixed rebuilds only the device source; the output track and consumers are untouched', async () => {
    const device1 = new FakeTrack('audio', 'd1');
    const device2 = new FakeTrack('audio', 'd2');
    let n = 0;
    installGlobals(async () => new FakeStream([[device1, device2][n++]!]));
    const r = rig();
    const consumerSwaps: unknown[] = [];
    await r.mic.acquire({ id: 'c', onTrackChanged: t => void consumerSwaps.push(t) });
    r.mic.setMixin(new FakeTrack('audio', 'system') as unknown as MediaStreamTrack);
    const ctx = (r.mic.ensureAudioContext() as unknown) as FakeAudioContext;
    const mixed = ctx.destinations[0].track;
    r.fanout.length = 0; consumerSwaps.length = 0;

    await r.mic.changeDevice('other');

    expect(r.mic.deviceTrack).toBe(device2 as unknown as MediaStreamTrack);
    expect(r.mic.track).toBe(mixed as unknown as MediaStreamTrack);
    expect(ctx.destinations).toHaveLength(1); // same destination, same output track
    expect(ctx.sources.filter(s => s.connected).map(s => s.stream.getAudioTracks()[0])).toEqual(expect.arrayContaining([device2]));
    expect(ctx.sources.find(s => s.stream.getAudioTracks()[0] === device1)!.connected).toBe(false);
    expect(device1.readyState).toBe('ended');
    expect(r.fanout).toEqual([]);
    expect(consumerSwaps).toEqual([]);
  });

  it('a rebuild that fails after a device change drops the mixin and reports mix-failed (the store ends the share)', async () => {
    const device1 = new FakeTrack('audio', 'd1');
    const device2 = new FakeTrack('audio', 'd2');
    let n = 0;
    installGlobals(async () => new FakeStream([[device1, device2][n++]!]));
    const r = rig();
    await r.mic.acquire({ id: 'c' });
    r.mic.setMixin(new FakeTrack('audio', 'system') as unknown as MediaStreamTrack);
    const ctx = (r.mic.ensureAudioContext() as unknown) as FakeAudioContext;
    const mixed = ctx.destinations[0].track;
    r.fanout.length = 0; r.oldStateAtFanout.length = 0;
    // Both source-node sites throw: the in-place swap AND the rebuild.
    ctx.failNextSource = true;
    ctx.failAlways = true;
    await r.mic.changeDevice('other');
    expect(r.mic.outputMode).toBe('device');
    expect(r.mic.track).toBe(device2 as unknown as MediaStreamTrack);
    expect(r.fanout).toEqual([{ newTrack: device2, oldTrack: mixed }]);
    expect(r.oldStateAtFanout).toEqual(['live']); // stopped after the swap, not before
    expect(mixed.readyState).toBe('ended');
    expect(r.dropped).toEqual(['mix-failed']);
  });

  it('a device change whose source node cannot be built falls back to a full rebuild of the mix', async () => {
    const device1 = new FakeTrack('audio', 'd1');
    const device2 = new FakeTrack('audio', 'd2');
    let n = 0;
    installGlobals(async () => new FakeStream([[device1, device2][n++]!]));
    const r = rig();
    const consumerSwaps: unknown[] = [];
    await r.mic.acquire({ id: 'c', onTrackChanged: t => void consumerSwaps.push(t) });
    r.mic.setMixin(new FakeTrack('audio', 'system') as unknown as MediaStreamTrack);
    const ctx = (r.mic.ensureAudioContext() as unknown) as FakeAudioContext;
    const firstMixed = ctx.destinations[0].track;
    r.fanout.length = 0; consumerSwaps.length = 0;

    ctx.failNextSource = true; // the in-place device-node replacement throws
    await r.mic.changeDevice('other');

    // Without the fallback the graph would keep feeding system audio from
    // a destination whose only microphone node had been disconnected.
    expect(ctx.destinations).toHaveLength(2);
    const rebuilt = ctx.destinations[1].track;
    expect(r.mic.outputMode).toBe('mixed');
    expect(r.mic.track).toBe(rebuilt as unknown as MediaStreamTrack);
    expect(firstMixed.readyState).toBe('ended');
    expect(ctx.sources.filter(s => s.connected).map(s => s.stream.getAudioTracks()[0]!.label))
      .toEqual(['d2', 'system']);
    expect(r.fanout).toEqual([{ newTrack: rebuilt, oldTrack: firstMixed }]);
    expect(consumerSwaps).toEqual([rebuilt]);
  });

  it('a first build whose source node cannot be built is refused (negative control for _buildMix\'s catch)', async () => {
    const device = new FakeTrack('audio', 'd');
    installGlobals(async () => new FakeStream([device]));
    const r = rig();
    await r.mic.acquire({ id: 'c' });
    const ctx = (r.mic.ensureAudioContext() as unknown) as FakeAudioContext;
    r.fanout.length = 0;

    ctx.failNextSource = true;
    expect(r.mic.setMixin(new FakeTrack('audio', 'system') as unknown as MediaStreamTrack)).toBe(false);

    expect(r.mic.outputMode).toBe('device');
    expect(r.mic.track).toBe(device as unknown as MediaStreamTrack);
    expect(r.fanout).toEqual([]);
  });

  it('a reopen after the device died while mixed also keeps the output (the reconciler path)', async () => {
    const device1 = new FakeTrack('audio', 'd1');
    const device2 = new FakeTrack('audio', 'd2');
    let n = 0;
    installGlobals(async () => new FakeStream([[device1, device2][n++]!]));
    const r = rig();
    await r.mic.acquire({ id: 'c' });
    r.mic.setMixin(new FakeTrack('audio', 'system') as unknown as MediaStreamTrack);
    const mixed = ((r.mic.ensureAudioContext() as unknown) as FakeAudioContext).destinations[0].track;
    device1.stop();
    expect(r.mic.lifecycle.state).toBe('ended');
    r.fanout.length = 0;
    expect(await r.mic.reopen()).toBe(true);
    expect(r.mic.deviceTrack).toBe(device2 as unknown as MediaStreamTrack);
    expect(r.mic.track).toBe(mixed as unknown as MediaStreamTrack);
    expect(r.fanout).toEqual([]);
  });

  it('tear while a swap is pending: the swap completes on the device path (Review Focus 1)', async () => {
    const device1 = new FakeTrack('audio', 'd1');
    const device2 = new FakeTrack('audio', 'd2');
    let release!: () => void;
    let n = 0;
    installGlobals(() => {
      n += 1;
      if (n === 1) return Promise.resolve(new FakeStream([device1]));
      return new Promise(res => { release = () => res(new FakeStream([device2])); });
    });
    const r = rig();
    await r.mic.acquire({ id: 'c' });
    r.mic.setMixin(new FakeTrack('audio', 'system') as unknown as MediaStreamTrack);
    const pending = r.mic.changeDevice('other');
    r.mic.setMixin(null); // the host ended the grant mid-swap
    release();
    await pending;
    expect(r.mic.outputMode).toBe('device');
    expect(r.mic.track).toBe(device2 as unknown as MediaStreamTrack);
    const ctx = (r.mic.ensureAudioContext() as unknown) as FakeAudioContext;
    expect(ctx.sources.every(s => !s.connected)).toBe(true);
  });

  it('closing the device while mixed disconnects the graph and fans out the close with the output track', async () => {
    const device = new FakeTrack('audio', 'd');
    installGlobals(async () => new FakeStream([device]));
    const r = rig();
    const h = await r.mic.acquire({ id: 'c' });
    r.mic.setMixin(new FakeTrack('audio', 'system') as unknown as MediaStreamTrack);
    const ctx = (r.mic.ensureAudioContext() as unknown) as FakeAudioContext;
    const mixed = ctx.destinations[0].track;
    r.fanout.length = 0; r.oldStateAtFanout.length = 0;
    h!.release();
    expect(r.fanout).toEqual([{ newTrack: null, oldTrack: mixed }]);
    expect(r.oldStateAtFanout).toEqual(['live']); // close fans out before the stops
    expect(ctx.sources.every(s => !s.connected)).toBe(true);
    expect(mixed.readyState).toBe('ended');
    expect(device.readyState).toBe('ended');
    expect(r.mic.outputMode).toBeNull();
    expect(r.mic.track).toBeNull();
    expect(r.dropped).toEqual(['device-closed']);
  });

  it('the host ends the grant while a stale-device acquire is opening: the tear waits for the open, and both steps are device changes (no close, no re-add)', async () => {
    const device1 = new FakeTrack('audio', 'd1');
    const device2 = new FakeTrack('audio', 'd2');
    let release!: () => void;
    let n = 0;
    installGlobals(() => {
      n += 1;
      if (n === 1) return Promise.resolve(new FakeStream([device1]));
      return new Promise(res => { release = () => res(new FakeStream([device2])); });
    });
    const r = rig();
    await r.mic.acquire({ id: 'voice' });
    r.mic.setMixin(new FakeTrack('audio', 'system') as unknown as MediaStreamTrack);
    const mixed = ((r.mic.ensureAudioContext() as unknown) as FakeAudioContext).destinations[0].track;
    device1.stop(); // the device died under the mix
    r.fanout.length = 0;
    // A second consumer acquires (voice starting capture when a peer falls to
    // signals): the stale path clears the dead device and awaits getUserMedia.
    const pending = r.mic.acquire({ id: 'filmstrip' });
    expect(r.mic.setMixin(null)).toBe(false); // recorded; the tear itself waits for the open
    expect(r.mic.outputMode).toBe('mixed'); // …so the old graph is still what consumers hold
    expect(r.fanout).toEqual([]); // no close fanout on no device
    release();
    await pending;
    expect(r.mic.outputMode).toBe('device');
    expect(r.mic.track).toBe(device2 as unknown as MediaStreamTrack);
    // ONE device-change fanout (replaceTrack on every peer) — never
    // (null, mixed) then (device2, null), which is removeTrack + addTrack.
    expect(r.fanout).toEqual([{ newTrack: device2, oldTrack: mixed }]);
  });

  it('a mixin deferred onto an open that then FAILS is dropped and reported, so a later reopen cannot install over it', async () => {
    // The PR #5 re-review's repro. The picker is open (the request gate
    // passed while the mic was live); the device dies and a second
    // consumer's acquire starts a replacement; the grant lands mid-open
    // and is recorded. If that open fails, nothing would ever build the
    // recorded mixin — `_openAndSwap` reconciles for a live mixin or an
    // existing mix, and after a failed open there is neither device nor
    // mix — so it must not be held silently.
    const device1 = new FakeTrack('audio', 'd1');
    const device2 = new FakeTrack('audio', 'd2');
    let rejectOpen!: () => void;
    let n = 0;
    installGlobals(() => {
      n += 1;
      if (n === 1) return Promise.resolve(new FakeStream([device1]));
      if (n === 2) return new Promise<FakeStream>((_res, rej) => { rejectOpen = () => rej(new Error('NotAllowedError')); });
      return Promise.resolve(new FakeStream([device2]));
    });
    const r = rig();
    await r.mic.acquire({ id: 'voice' });
    device1.stop();
    expect(r.mic.lifecycle.state).toBe('ended');
    const opening = r.mic.acquire({ id: 'filmstrip' });
    const mixin = new FakeTrack('audio', 'system');
    expect(r.mic.setMixin(mixin as unknown as MediaStreamTrack)).toBe(true); // recorded, deferred

    rejectOpen();
    await opening;

    expect(r.mic.lifecycle.state).toBe('failed');
    expect(r.dropped).toEqual(['device-closed']);
    // The reopen that follows is a plain device open — before the fix it
    // installed the device track over the orphaned mixin and the store
    // went on showing "Including" with nothing mixed.
    expect(await r.mic.reopen()).toBe(true);
    expect(r.mic.outputMode).toBe('device');
    expect(r.mic.track).toBe(device2 as unknown as MediaStreamTrack);
    expect(r.dropped).toEqual(['device-closed']);
  });

  it('a mixin deferred onto an open that SUCCEEDS is built onto the new device (the deferral kept)', async () => {
    const device1 = new FakeTrack('audio', 'd1');
    const device2 = new FakeTrack('audio', 'd2');
    let release!: () => void;
    let n = 0;
    installGlobals(() => {
      n += 1;
      if (n === 1) return Promise.resolve(new FakeStream([device1]));
      return new Promise<FakeStream>(res => { release = () => res(new FakeStream([device2])); });
    });
    const r = rig();
    await r.mic.acquire({ id: 'voice' });
    device1.stop();
    const opening = r.mic.acquire({ id: 'filmstrip' });
    expect(r.mic.setMixin(new FakeTrack('audio', 'system') as unknown as MediaStreamTrack)).toBe(true);

    release();
    await opening;

    expect(r.mic.outputMode).toBe('mixed');
    expect(r.mic.deviceTrack).toBe(device2 as unknown as MediaStreamTrack);
    expect(r.dropped).toEqual([]);
  });

  it('reopen honours a recorded live mixin instead of installing the device over it (the _openAndSwap half of the rule)', async () => {
    // `setMixin` with no device records the mixin and answers false (v1
    // needs the mic held), so a caller that ignores that answer leaves a
    // mixin with no mix behind it. Both open paths must then build it
    // rather than install the bare device: `_ensureOpen` always did;
    // `_openAndSwap` (reopen, changeDevice) reconciled only while a mix
    // already existed.
    const device = new FakeTrack('audio', 'd');
    installGlobals(async () => new FakeStream([device]));
    const r = rig();
    const mixin = new FakeTrack('audio', 'system');
    expect(r.mic.setMixin(mixin as unknown as MediaStreamTrack)).toBe(false);

    expect(await r.mic.reopen()).toBe(true);

    expect(r.mic.outputMode).toBe('mixed');
    expect(r.mic.deviceTrack).toBe(device as unknown as MediaStreamTrack);
    expect(r.dropped).toEqual([]);
  });

  it('acquire after a mixin was set hands out the mixed output', async () => {
    const device = new FakeTrack('audio', 'd');
    installGlobals(async () => new FakeStream([device]));
    const r = rig();
    await r.mic.acquire({ id: 'a' });
    r.mic.setMixin(new FakeTrack('audio', 'system') as unknown as MediaStreamTrack);
    const mixed = ((r.mic.ensureAudioContext() as unknown) as FakeAudioContext).destinations[0].track;
    const h = await r.mic.acquire({ id: 'b' });
    expect(h!.track).toBe(mixed as unknown as MediaStreamTrack);
  });
});
