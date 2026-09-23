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
  destinations: Array<{ track: FakeTrack }> = [];
  createMediaStreamSource(stream: FakeStream) {
    const node = { stream, connected: false, connect: () => { node.connected = true; }, disconnect: () => { node.connected = false; } };
    this.sources.push(node);
    return node;
  }
  createMediaStreamDestination() {
    const track = new FakeTrack('audio', 'mixed');
    this.destinations.push({ track });
    return { stream: new FakeStream([track]) };
  }
  resume = async () => {};
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
  let deviceId: string | undefined;
  const bindings: MicSourceBindings = {
    getDeviceId: () => deviceId,
    setDeviceId: id => { deviceId = id; },
    onTrackChange: (n, o) => void fanout.push({ newTrack: n, oldTrack: o }),
    onMutedChange: () => {},
    onLifecycleChange: () => {},
    now: () => clock.now(),
  };
  const mic = new MicSource(bindings);
  return { mic, fanout, clock };
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
  });

  it('setMixin(null) tears the mix back to the device track with one swap; the destination track is stopped', async () => {
    const r = rig();
    const consumerSwaps: unknown[] = [];
    await r.mic.acquire({ id: 'c', onTrackChanged: t => void consumerSwaps.push(t) });
    const mixin = new FakeTrack('audio', 'system');
    r.mic.setMixin(mixin as unknown as MediaStreamTrack);
    const ctx = (r.mic.ensureAudioContext() as unknown) as FakeAudioContext;
    const mixed = ctx.destinations[0].track;
    r.fanout.length = 0; consumerSwaps.length = 0;

    expect(r.mic.setMixin(null)).toBe(false);
    expect(r.mic.track).toBe(device as unknown as MediaStreamTrack);
    expect(r.mic.outputMode).toBe('device');
    expect(r.fanout).toEqual([{ newTrack: device, oldTrack: mixed }]);
    expect(consumerSwaps).toEqual([device]);
    expect(ctx.sources.every(s => !s.connected)).toBe(true);
    expect(mixed.readyState).toBe('ended');
    expect(mixin.readyState).toBe('live'); // the mixin belongs to the caller (the capture object stops it)
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
    r.fanout.length = 0;
    h!.release();
    expect(r.fanout).toEqual([{ newTrack: null, oldTrack: mixed }]);
    expect(ctx.sources.every(s => !s.connected)).toBe(true);
    expect(mixed.readyState).toBe('ended');
    expect(device.readyState).toBe('ended');
    expect(r.mic.outputMode).toBeNull();
    expect(r.mic.track).toBeNull();
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
