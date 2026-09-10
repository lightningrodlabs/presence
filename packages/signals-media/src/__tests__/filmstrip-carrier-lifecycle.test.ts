import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FilmstripCarrier } from '../filmstrip-carrier.js';
import { makeFakeHost } from './fake-host.js';

/**
 * Bind/unbind symmetry and the two gates on the send site. "The receive side
 * is live once bound" (design spec decision 3) has to mean the reverse too —
 * an unbound carrier holds no per-peer state and no pending timers — and the
 * send site must honour BOTH the target set and the cadence verdict, since
 * filmstrip is the heaviest signals payload.
 *
 * Constrains: src/filmstrip-carrier.ts (`bind`/`unbind`/`isBound`,
 * `subscribe`, `_handleClipFromWorker`).
 */

const PEER = 'uhCAkPeerOne_______________________________________';
const OTHER = 'uhCAkPeerTwo_______________________________________';

function clip(seq: number, ts: number): string {
  return JSON.stringify({
    seq,
    ts,
    t0: ts,
    data: 'eA==', // 1 byte
    n: 1,
    p: 167,
    w: 64,
    h: 64,
  });
}

function stop(seq: number, ts: number): string {
  return JSON.stringify({ kind: 'stop', seq, ts });
}

/** The shape `_handleClipFromWorker` receives from the JPEG worker. */
function workerClip(bytes = [1, 2, 3]) {
  return {
    bytes: new Uint8Array(bytes).buffer,
    w: 192,
    h: 192,
    n: 1,
    p: 167,
    t0: 5_000,
    capturedAt: 5_010,
  };
}

describe('FilmstripCarrier lifecycle', () => {
  let carrier: FilmstripCarrier;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    (URL as unknown as Record<string, unknown>).createObjectURL = vi.fn(
      () => 'blob:fake'
    );
    (URL as unknown as Record<string, unknown>).revokeObjectURL = vi.fn();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    carrier = new FilmstripCarrier();
  });

  afterEach(() => {
    carrier.unbind();
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (globalThis as unknown as Record<string, unknown>).document;
    delete (globalThis as unknown as Record<string, unknown>).MediaStream;
    delete (globalThis as unknown as Record<string, unknown>).createImageBitmap;
  });

  it('is unbound until bind and bound after it', () => {
    const f = makeFakeHost();
    expect(carrier.isBound).toBe(false);
    carrier.bind(f.host);
    expect(carrier.isBound).toBe(true);
    carrier.unbind();
    expect(carrier.isBound).toBe(false);
  });

  it('subscribe replays the latest frame and then sees every new one', () => {
    const f = makeFakeHost();
    carrier.bind(f.host);
    carrier.receiveFrame(PEER, clip(1, 0));

    const seen: (unknown | null)[] = [];
    const unsub = carrier.subscribe(PEER, frame => seen.push(frame));

    expect(seen).toHaveLength(1); // replayed
    expect(seen[0]).toMatchObject({ url: 'blob:fake', frameCount: 1, periodMs: 167 });

    carrier.receiveFrame(PEER, clip(2, 10));
    expect(seen).toHaveLength(2);

    unsub();
    carrier.receiveFrame(PEER, clip(3, 20));
    expect(seen).toHaveLength(2);
  });

  it('a subscriber on a peer that has sent nothing gets no replay', () => {
    const f = makeFakeHost();
    carrier.bind(f.host);
    const seen: unknown[] = [];
    carrier.subscribe(PEER, frame => seen.push(frame));
    expect(seen).toHaveLength(0);
  });

  it('an explicit stop payload clears the display and resets the seq high-water', () => {
    const f = makeFakeHost();
    carrier.bind(f.host);
    const seen: (unknown | null)[] = [];

    carrier.receiveFrame(PEER, clip(5, 0));
    carrier.subscribe(PEER, frame => seen.push(frame));
    seen.length = 0;

    carrier.receiveFrame(PEER, stop(6, 10));

    expect(seen).toEqual([null]);
    expect(carrier.getLatest(PEER)).toBeNull();
    expect(carrier.signalsVideoStats.has(PEER)).toBe(false);

    // A restarted sender begins at seq 1 again; without the reset this
    // clip would be dropped as a duplicate against the old high-water.
    carrier.receiveFrame(PEER, clip(1, 20));
    expect(seen).toHaveLength(2);
    expect(carrier.getLatest(PEER)).not.toBeNull();
  });

  it('the inactivity TTL clears a display when the sender vanishes', () => {
    const f = makeFakeHost();
    carrier.bind(f.host);
    const seen: (unknown | null)[] = [];
    carrier.receiveFrame(PEER, clip(1, 0));
    carrier.subscribe(PEER, frame => seen.push(frame));
    seen.length = 0;

    vi.advanceTimersByTime(5000);

    expect(seen).toEqual([null]);
    expect(carrier.getLatest(PEER)).toBeNull();
  });

  it('unbind drops every per-peer map and every pending timer', () => {
    const f = makeFakeHost();
    carrier.bind(f.host);
    carrier.receiveFrame(PEER, clip(1, 0));
    carrier.receiveFrame(OTHER, clip(1, 0));
    carrier.setBufferDepth(PEER, 3);
    expect(carrier.peerLastRecvMs.size).toBe(2);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    carrier.unbind();

    expect(carrier.peerLastRecvMs.size).toBe(0);
    expect(carrier.peerLastSentMs.size).toBe(0);
    expect(carrier.signalsVideoStats.size).toBe(0);
    expect(carrier.getLatest(PEER)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(carrier.isBound).toBe(false);
  });

  it('the send site drops a clip when the host has no targets', () => {
    const f = makeFakeHost({ targets: [] });
    carrier.bind(f.host);

    (carrier as any)._handleClipFromWorker(workerClip());

    expect(f.sent).toHaveLength(0);
    expect(carrier.peerLastSentMs.size).toBe(0);
  });

  it('the send site drops a clip below full cadence', () => {
    const f = makeFakeHost({ targets: [PEER], cadence: 'voice-only' });
    carrier.bind(f.host);

    (carrier as any)._handleClipFromWorker(workerClip());
    expect(f.sent).toHaveLength(0);

    f.setCadence('paused');
    (carrier as any)._handleClipFromWorker(workerClip());
    expect(f.sent).toHaveLength(0);

    f.setCadence('full');
    (carrier as any)._handleClipFromWorker(workerClip());
    expect(f.sent).toHaveLength(1);
  });

  it("the send site ships a 'filmstrip' payload to the host's targets and stamps them on the host clock", () => {
    const f = makeFakeHost({ targets: [PEER, OTHER], cadence: 'full' });
    f.clock.set(777);
    carrier.bind(f.host);

    (carrier as any)._handleClipFromWorker(workerClip([9, 9, 9, 9]));

    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].kind).toBe('filmstrip');
    expect(f.sent[0].targets).toEqual([PEER, OTHER]);

    const payload = JSON.parse(f.sent[0].payload);
    expect(payload).toMatchObject({
      seq: 0,
      ts: 5_010,
      t0: 5_000,
      w: 192,
      h: 192,
      n: 1,
      p: 167,
    });
    expect(typeof payload.data).toBe('string');

    // Local send stamps ride the HOST clock, so a host never compares two
    // timebases against peerLastRecvMs.
    expect(carrier.peerLastSentMs.get(PEER)).toBe(777);
    expect(carrier.peerLastSentMs.get(OTHER)).toBe(777);

    // seq advances per clip.
    (carrier as any)._handleClipFromWorker(workerClip());
    expect(JSON.parse(f.sent[1].payload).seq).toBe(1);
  });

  it('an unbound carrier sends nothing', () => {
    const f = makeFakeHost({ targets: [PEER], cadence: 'full' });
    (carrier as any)._handleClipFromWorker(workerClip());
    expect(f.sent).toHaveLength(0);
  });

  it('startCapture unwinds — camera released, worker terminated — when the sampler cannot start', async () => {
    // This is the one arm with no origin counterpart: Presence's
    // `_sendTrackToWorker` logged and left the camera open behind a pump that
    // would never produce a frame. Dropping the unwind must fail here.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const g = globalThis as unknown as Record<string, unknown>;
    g.MediaStream = class {
      constructor(public tracks: unknown[] = []) {}
    };
    g.createImageBitmap = () => Promise.resolve({ close: () => {} });
    // A camera that opens fine, but an element that refuses to play — the
    // real WebKit/autoplay failure mode the sampler resolves `false` on.
    g.document = {
      createElement: () => ({
        muted: false,
        playsInline: false,
        srcObject: null,
        videoWidth: 640,
        play: () => Promise.reject(new Error('no autoplay')),
        pause: () => {},
      }),
    };

    const release = vi.fn();
    const track = { kind: 'video', readyState: 'live' } as unknown as MediaStreamTrack;
    const acquireCamera = vi.fn(async () => ({ track, release }));
    const worker = {
      postMessage: vi.fn(),
      terminate: vi.fn(),
      onmessage: null,
      onerror: null,
    };
    const f = makeFakeHost({ targets: [PEER], cadence: 'full' });
    carrier.bind({
      ...f.host,
      acquireCamera,
      createWorker: () => worker as unknown as Worker,
    });

    expect(await carrier.startCapture()).toBe(false);

    expect(acquireCamera).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'stop' });
    // Two expected lines: the sampler's own diagnosis, then the carrier's
    // unwind. The carrier's is the one this test is about.
    expect(
      err.mock.calls.filter(c => c[0] === 'filmstrip: sampler failed to start')
    ).toHaveLength(1);

    // The camera handle was dropped, so a later attempt acquires again
    // instead of short-circuiting on a stale handle.
    expect(await carrier.startCapture()).toBe(false);
    expect(acquireCamera).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it('fps and capture-side setters reject values outside the declared options', () => {
    carrier.setFps(3);
    expect(carrier.getFps()).toBe(3);
    carrier.setFps(9 as never);
    expect(carrier.getFps()).toBe(3);

    carrier.setCaptureSide(96);
    expect(carrier.getCaptureSide()).toBe(96);
    carrier.setCaptureSide(1000 as never);
    expect(carrier.getCaptureSide()).toBe(96);
  });
});
