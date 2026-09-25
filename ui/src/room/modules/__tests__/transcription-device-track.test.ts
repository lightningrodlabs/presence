/**
 * Transcription reads the DEVICE track, never MicSource's output
 * (release-0.16.0 final review, I1). Since the system-audio round the
 * output is a mix destination whenever a share is on, and a pump built on
 * it would transcribe the shared audio — a video, the peers' own voices
 * out of Moss — and broadcast it as the sharer's words. The module
 * header's intent is "each speaker transcribes their own microphone".
 *
 * The rig runs the production `MicSource` over the same fakes
 * `mic-source-mixin.test.ts` uses, plus a fake `MediaStreamTrackProcessor`
 * that records the track it was built on and lets the test hand frames to
 * whichever reader it likes. The first case is the positive control for
 * the fake: frames handed to the device reader reach `pushAudio`, so a
 * case asserting zero pushes is not passing on a fake that cannot deliver.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get, writable } from '@holochain-open-dev/stores';
import type { StreamsStore } from '../../../streams-store';
import { MicSource } from '../../../mic-source';
import { ManualClock } from '../../../clock.testing';
import { transcriptionController } from '../transcription';

class FakeTrack {
  readyState: 'live' | 'ended' = 'live';
  enabled = true;
  onended: (() => void) | null = null;
  constructor(public kind: 'audio' | 'video', public label = '') {}
  getSettings() { return { sampleRate: 48_000 }; }
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
class FakeMediaStream extends FakeStream {
  constructor(tracks: FakeTrack[] = []) { super(tracks); }
}
class FakeAudioContext {
  readonly sampleRate = 48000;
  state = 'running';
  createMediaStreamSource(stream: FakeStream) {
    return { stream, connect: () => {}, disconnect: () => {} };
  }
  createMediaStreamDestination() {
    return { stream: new FakeStream([new FakeTrack('audio', 'mixed')]), channelCount: 2 };
  }
  resume = async () => {};
  close = async () => {};
}

/** One AudioData: 480 f32 samples of a constant. */
function fakeAudioData(value = 0.1) {
  return {
    numberOfFrames: 480,
    copyTo: (dst: Float32Array) => dst.fill(value),
    close: () => {},
  };
}

/**
 * A MediaStreamTrackProcessor whose reader blocks until the test feeds
 * it. `built` lists every track a processor was constructed on, in
 * order; `feed(track, data)` resolves that track's pending read.
 */
function fakeProcessorClass() {
  const built: FakeTrack[] = [];
  const pending = new Map<FakeTrack, Array<(r: { done: boolean; value?: unknown }) => void>>();
  const cancelled: FakeTrack[] = [];
  class Processor {
    readable: { getReader: () => { read: () => Promise<{ done: boolean; value?: unknown }>; cancel: () => Promise<void> } };
    constructor({ track }: { track: FakeTrack }) {
      built.push(track);
      this.readable = {
        getReader: () => ({
          read: () =>
            new Promise(resolve => {
              const q = pending.get(track) ?? [];
              q.push(resolve);
              pending.set(track, q);
            }),
          cancel: async () => {
            cancelled.push(track);
            for (const resolve of pending.get(track) ?? []) resolve({ done: true });
            pending.delete(track);
          },
        }),
      };
    }
  }
  const feed = async (track: FakeTrack, data = fakeAudioData()) => {
    const q = pending.get(track) ?? [];
    const resolve = q.shift();
    if (!resolve) throw new Error(`no pending read on ${track.label}`);
    resolve({ done: false, value: data });
    // Let the pump loop consume it and re-arm.
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  const hasPendingRead = (track: FakeTrack) => (pending.get(track)?.length ?? 0) > 0;
  return { Processor, built, feed, cancelled, hasPendingRead };
}

function fakeHost() {
  const pushed: Int16Array[] = [];
  const localModels = {
    capabilities: async () => ({ asr: { available: true } }),
    asr: {
      openSession: async () => ({
        sessionId: 's1',
        onFinal: () => () => {},
        onError: () => () => {},
        onPartial: () => () => {},
        pushAudio: async (pcm: Int16Array) => { if (pcm.length > 0) pushed.push(pcm); },
        close: async () => {},
      }),
    },
  };
  return { localModels, pushed };
}

/** Real MicSource; getUserMedia answers from `devices` in order and counts calls. */
function rig(devices: FakeTrack[]) {
  const clock = new ManualClock(1_000);
  const getUserMediaCalls: unknown[] = [];
  const queue = [...devices];
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      mediaDevices: {
        getUserMedia: async (c: unknown) => {
          getUserMediaCalls.push(c);
          const t = queue.shift();
          if (!t) throw new Error('NotFoundError');
          return new FakeStream([t]);
        },
      },
    },
    configurable: true,
    writable: true,
  });
  (globalThis as any).MediaStream = FakeMediaStream;
  (globalThis as any).AudioContext = FakeAudioContext;
  let deviceId: string | undefined;
  const mic = new MicSource({
    getDeviceId: () => deviceId,
    setDeviceId: id => { deviceId = id; },
    onTrackChange: () => {},
    onMutedChange: () => {},
    onLifecycleChange: () => {},
    onMixinDropped: () => {},
    now: () => clock.now(),
  });
  const host = fakeHost();
  const micOn = {
    conversation: {
      moduleId: 'conversation',
      active: true,
      payload: JSON.stringify({ micMuted: false }),
      updatedAt: 1,
    },
  };
  const store = {
    myPubKeyB64: 'me',
    clock,
    localModels: host.localModels,
    micSource: mic,
    _myModuleStates: writable(micOn),
    _transcriptLog: writable(new Map()),
    sendModuleData: async () => {},
  } as unknown as StreamsStore;
  return { mic, store, host, getUserMediaCalls, clock };
}

async function ticks(n: number) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

describe('transcription pumps the device track, not the mic output', () => {
  const g = globalThis as any;
  const savedProcessor = g.MediaStreamTrackProcessor;
  const savedWindow = g.window;
  let processors: ReturnType<typeof fakeProcessorClass>;

  beforeEach(() => {
    processors = fakeProcessorClass();
    g.MediaStreamTrackProcessor = processors.Processor;
    if (!g.window) g.window = { setInterval: vi.fn(() => 1), clearInterval: vi.fn(), localStorage: { getItem: () => null } };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(async () => {
    transcriptionController.unbind();
    await ticks(10);
    g.MediaStreamTrackProcessor = savedProcessor;
    g.window = savedWindow;
    delete g.navigator;
    delete g.MediaStream;
    delete g.AudioContext;
    vi.restoreAllMocks();
  });

  it('with a share mixed in, the reader is built on the device track and its frames reach the session (positive control for the fake)', async () => {
    const device = new FakeTrack('audio', 'device');
    const r = rig([device]);
    // The capture reconciler's own acquire opens the device; then a share.
    await r.mic.acquire({ id: 'capture-reconciler' });
    const mixin = new FakeTrack('audio', 'system');
    expect(r.mic.setMixin(mixin as unknown as MediaStreamTrack)).toBe(true);
    const mixed = r.mic.track as unknown as FakeTrack;
    expect(mixed).not.toBe(device);

    transcriptionController.bind(r.store);
    expect(await transcriptionController.startCapture()).toBe(true);
    await vi.waitFor(() => expect(get(transcriptionController.isCapturing)).toBe(true));

    expect(processors.built).toEqual([device]);
    expect(processors.built).not.toContain(mixed);

    await processors.feed(device);
    expect(r.host.pushed).toHaveLength(1);
    expect(r.host.pushed[0]).toHaveLength(480);
  });

  it('a share without the microphone: no reader, no frames, and transcription opens no device of its own', async () => {
    const r = rig([]); // getUserMedia would throw: there is no device to open
    const mixin = new FakeTrack('audio', 'system');
    expect(r.mic.setMixin(mixin as unknown as MediaStreamTrack)).toBe(true);
    expect(r.mic.track).not.toBeNull();
    expect(r.mic.deviceTrack).toBeNull();

    transcriptionController.bind(r.store);
    expect(await transcriptionController.startCapture()).toBe(true);
    await ticks(20);

    expect(r.getUserMediaCalls).toEqual([]);
    expect(processors.built).toEqual([]);
    expect(r.host.pushed).toEqual([]);
    expect(get(transcriptionController.isCapturing)).toBe(false);
    expect(get(transcriptionController.lastError)).toBeNull();
  });

  it('the microphone joining a running share is picked up: the reader is built on the device when it goes live', async () => {
    const device = new FakeTrack('audio', 'device');
    const r = rig([device]);
    const mixin = new FakeTrack('audio', 'system');
    r.mic.setMixin(mixin as unknown as MediaStreamTrack);
    transcriptionController.bind(r.store);
    expect(await transcriptionController.startCapture()).toBe(true);
    await ticks(20);
    expect(processors.built).toEqual([]);

    // The reconciler opens the microphone; the output (the mix) does not change.
    const outputBefore = r.mic.track;
    await r.mic.acquire({ id: 'capture-reconciler' });
    expect(r.mic.track).toBe(outputBefore);

    await vi.waitFor(() => expect(processors.built).toEqual([device]));
    await vi.waitFor(() => expect(get(transcriptionController.isCapturing)).toBe(true));
    await processors.feed(device);
    expect(r.host.pushed).toHaveLength(1);
  });

  it('a device change while mixed rebuilds the reader onto the new device track; the output is untouched', async () => {
    const device1 = new FakeTrack('audio', 'device-1');
    const device2 = new FakeTrack('audio', 'device-2');
    const r = rig([device1, device2]);
    await r.mic.acquire({ id: 'capture-reconciler' });
    const mixin = new FakeTrack('audio', 'system');
    r.mic.setMixin(mixin as unknown as MediaStreamTrack);
    const outputBefore = r.mic.track;

    transcriptionController.bind(r.store);
    expect(await transcriptionController.startCapture()).toBe(true);
    await vi.waitFor(() => expect(processors.built).toEqual([device1]));

    await r.mic.changeDevice('b');
    expect(r.mic.deviceTrack).toBe(device2 as unknown as MediaStreamTrack);
    expect(r.mic.track).toBe(outputBefore);

    await vi.waitFor(() => expect(processors.built).toEqual([device1, device2]));
    expect(processors.cancelled).toEqual([device1]);
    await processors.feed(device2);
    expect(r.host.pushed).toHaveLength(1);
  });

  it('the mute gate reads the device track: muted during a share drops frames even though the output stays enabled', async () => {
    const device = new FakeTrack('audio', 'device');
    const r = rig([device]);
    await r.mic.acquire({ id: 'capture-reconciler' });
    const mixin = new FakeTrack('audio', 'system');
    r.mic.setMixin(mixin as unknown as MediaStreamTrack);
    transcriptionController.bind(r.store);
    expect(await transcriptionController.startCapture()).toBe(true);
    await vi.waitFor(() => expect(processors.built).toEqual([device]));

    r.mic.setMuted(true);
    expect((r.mic.track as unknown as FakeTrack).enabled).toBe(true); // the share keeps flowing to peers
    expect(device.enabled).toBe(false);
    await processors.feed(device);
    expect(r.host.pushed).toEqual([]);

    r.mic.setMuted(false);
    await processors.feed(device);
    expect(r.host.pushed).toHaveLength(1);
  });
});
