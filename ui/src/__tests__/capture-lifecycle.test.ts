import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MicSource, isLiveTrack } from '../mic-source';
import type { CaptureLifecycle, MicSourceBindings } from '../mic-source';
import { CameraSource } from '../camera-source';
import type { CameraSourceBindings } from '../camera-source';
import { ManualClock } from '../clock.testing';

/**
 * Task 2: pins the `CaptureLifecycle` union that replaces the old
 * `_track` null/non-null two-state model on `MicSource`/`CameraSource`.
 * `ended` is the state whose absence made a dead mic unrecoverable in the
 * field: a `getUserMedia` track that dies underneath the app (device
 * unplugged, OS revokes permission) left `_track` non-null, so every
 * `!this._track` predicate kept reading "still open" forever.
 *
 * Both sources are exercised through the same table (`SOURCES` below) —
 * the capture lifecycle is identical for mic and camera; only the
 * constraints shape and mic's extra mute machinery differ, and neither is
 * under test here.
 */

class FakeTrack {
  readyState: 'live' | 'ended' = 'live';

  enabled = true;

  onended: (() => void) | null = null;

  constructor(public kind: 'audio' | 'video') {}

  /** Real MediaStreamTrack.stop() transitions readyState synchronously and
   *  fires `ended` (queued as a task in a real browser; fired inline here
   *  — the store never depends on the firing being async). Idempotent,
   *  matching the spec: a second stop() does not re-fire the event. */
  stop(): void {
    if (this.readyState === 'ended') return;
    this.readyState = 'ended';
    this.onended?.();
  }
}

class FakeStream {
  constructor(private tracks: FakeTrack[]) {}

  getTracks(): FakeTrack[] {
    return this.tracks;
  }

  getAudioTracks(): FakeTrack[] {
    return this.tracks.filter(t => t.kind === 'audio');
  }

  getVideoTracks(): FakeTrack[] {
    return this.tracks.filter(t => t.kind === 'video');
  }
}

/** Install a fake `navigator.mediaDevices.getUserMedia`. The node test
 *  environment has no ambient `navigator` at all (confirmed: `typeof
 *  navigator === 'undefined'` under this repo's node version), so this
 *  assigns the whole object rather than patching an existing one. */
function installFakeNavigator(
  getUserMedia: (constraints: unknown) => Promise<FakeStream>
): void {
  (globalThis as any).navigator = {
    mediaDevices: { getUserMedia },
  };
}

function sequentialStreams(...streams: FakeStream[]): (c: unknown) => Promise<FakeStream> {
  let call = 0;
  return async () => {
    const s = streams[call];
    call += 1;
    return s;
  };
}

function makeMic(clock: ManualClock) {
  const lifecycleEvents: CaptureLifecycle[] = [];
  let deviceId: string | undefined;
  const bindings: MicSourceBindings = {
    getDeviceId: () => deviceId,
    setDeviceId: id => {
      deviceId = id;
    },
    onTrackChange: () => {},
    onMutedChange: () => {},
    onLifecycleChange: l => lifecycleEvents.push(l),
    now: () => clock.now(),
  };
  return { source: new MicSource(bindings), lifecycleEvents };
}

function makeCamera(clock: ManualClock) {
  const lifecycleEvents: CaptureLifecycle[] = [];
  let deviceId: string | undefined;
  const bindings: CameraSourceBindings = {
    getDeviceId: () => deviceId,
    setDeviceId: id => {
      deviceId = id;
    },
    onTrackChange: () => {},
    onLifecycleChange: l => lifecycleEvents.push(l),
    now: () => clock.now(),
  };
  return { source: new CameraSource(bindings), lifecycleEvents };
}

const SOURCES = [
  { name: 'MicSource', kind: 'audio' as const, make: makeMic },
  { name: 'CameraSource', kind: 'video' as const, make: makeCamera },
];

describe.each(SOURCES)('$name capture lifecycle', ({ kind, make }) => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as any).navigator;
  });

  it('starts idle', () => {
    const clock = new ManualClock(1_000);
    const { source } = make(clock);
    expect(source.lifecycle).toEqual({ state: 'idle' });
  });

  it('(a) acquire opens the device: idle -> acquiring -> live', async () => {
    const clock = new ManualClock(1_000);
    const track = new FakeTrack(kind);
    installFakeNavigator(sequentialStreams(new FakeStream([track])));
    const { source, lifecycleEvents } = make(clock);

    const result = await source.acquire({ id: 'c1' });

    expect(result?.track).toBe(track);
    expect(source.lifecycle).toEqual({ state: 'live', track });
    expect(lifecycleEvents).toEqual([
      { state: 'acquiring', since: 1_000 },
      { state: 'live', track },
    ]);
  });

  it('(b) the ended event on the live track transitions lifecycle to ended', async () => {
    const clock = new ManualClock(1_000);
    const track = new FakeTrack(kind);
    installFakeNavigator(sequentialStreams(new FakeStream([track])));
    const { source, lifecycleEvents } = make(clock);

    await source.acquire({ id: 'c1' });
    lifecycleEvents.length = 0; // isolate the transition under test
    clock.advance(500);

    track.stop(); // platform/user ends the device out from under us

    expect(source.lifecycle).toEqual({ state: 'ended', endedAt: 1_500 });
    expect(lifecycleEvents).toEqual([{ state: 'ended', endedAt: 1_500 }]);
  });

  it('(c) acquiring again after ended opens a NEW live track, not the corpse', async () => {
    const clock = new ManualClock(1_000);
    const trackA = new FakeTrack(kind);
    const trackB = new FakeTrack(kind);
    installFakeNavigator(
      sequentialStreams(new FakeStream([trackA]), new FakeStream([trackB]))
    );
    const { source } = make(clock);

    const first = await source.acquire({ id: 'c1' });
    expect(first?.track).toBe(trackA);

    trackA.stop(); // ends while c1 still holds the reference (does not release)
    expect(source.lifecycle.state).toBe('ended');
    expect(trackA.readyState).toBe('ended');

    const second = await source.acquire({ id: 'c2' });

    expect(second?.track).toBe(trackB);
    expect(second?.track).not.toBe(trackA);
    expect(source.lifecycle).toEqual({ state: 'live', track: trackB });
  });

  it('(d) a getUserMedia rejection transitions lifecycle to failed with the error text', async () => {
    const clock = new ManualClock(1_000);
    installFakeNavigator(async () => {
      throw new Error('Permission denied');
    });
    const { source, lifecycleEvents } = make(clock);

    const result = await source.acquire({ id: 'c1' });

    expect(result).toBeNull();
    expect(source.lifecycle).toEqual({
      state: 'failed',
      error: 'Error: Permission denied',
      failedAt: 1_000,
    });
    expect(lifecycleEvents.map(l => l.state)).toEqual(['acquiring', 'failed']);
  });

  it('(e) changeDevice attaches the ended-watch to the NEW track', async () => {
    const clock = new ManualClock(1_000);
    const trackA = new FakeTrack(kind);
    const trackB = new FakeTrack(kind);
    installFakeNavigator(
      sequentialStreams(new FakeStream([trackA]), new FakeStream([trackB]))
    );
    const { source } = make(clock);

    await source.acquire({ id: 'c1' });
    await source.changeDevice('device-2');

    expect(source.lifecycle).toEqual({ state: 'live', track: trackB });

    clock.advance(10);
    trackB.stop(); // end the NEW track, not the old one

    expect(source.lifecycle).toEqual({ state: 'ended', endedAt: 1_010 });
  });

  it('release then re-acquire closes to idle and reopens live (unchanged two-state path)', async () => {
    const clock = new ManualClock(1_000);
    const trackA = new FakeTrack(kind);
    const trackB = new FakeTrack(kind);
    installFakeNavigator(
      sequentialStreams(new FakeStream([trackA]), new FakeStream([trackB]))
    );
    const { source, lifecycleEvents } = make(clock);

    const handle = await source.acquire({ id: 'c1' });
    handle?.release();
    expect(source.lifecycle).toEqual({ state: 'idle' });

    await source.acquire({ id: 'c2' });
    expect(source.lifecycle).toEqual({ state: 'live', track: trackB });
    expect(lifecycleEvents.map(l => l.state)).toEqual([
      'acquiring',
      'live',
      'idle',
      'acquiring',
      'live',
    ]);
  });
});

describe('isLiveTrack', () => {
  it('is false for null, true for a live track, false for an ended one', () => {
    const track = new FakeTrack('audio');
    expect(isLiveTrack(null)).toBe(false);
    expect(isLiveTrack(track as unknown as MediaStreamTrack)).toBe(true);
    track.stop();
    expect(isLiveTrack(track as unknown as MediaStreamTrack)).toBe(false);
  });
});

/**
 * Step 2 (brief): the negative control. Every lifecycle test above proves
 * nothing if the fixture cannot actually reproduce a track dying — the
 * `MockRTCPeerConnection`-cannot-throw lesson (CLAUDE.md, working
 * agreement on mocks): a mock that structurally cannot fail makes the
 * guard it exists to exercise permanently green. This test fails on its
 * own if `FakeTrack.stop()` is ever "simplified" to drop the `onended`
 * dispatch — which would silently turn every `(b)`/`(c)`/`(e)` case above
 * into a test of a lifecycle transition that can never actually occur.
 */
describe('negative control: the fake track can transition to ended and fire its handler', () => {
  it('stop() flips readyState and invokes onended exactly once, even if called twice', () => {
    const track = new FakeTrack('audio');
    let fired = 0;
    track.onended = () => {
      fired += 1;
    };

    expect(track.readyState).toBe('live');

    track.stop();
    expect(track.readyState).toBe('ended');
    expect(fired).toBe(1);

    track.stop(); // idempotent — a real track's second stop() is a no-op
    expect(fired).toBe(1);
  });
});
