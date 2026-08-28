/**
 * @vitest-environment jsdom
 *
 * Filmstrip receive stats must reach the PresenceLogger pipeline, not
 * just console.log. Motivating gap (2026-08-25 field diagnosis): during
 * the lMp audio outage the exported logs could not answer "was video
 * still flowing from this peer?" — the rx stats line existed only in
 * DevTools, and flow had to be inferred indirectly from a
 * `PresenceAdd reason=media-live` event. One throttled custom log per
 * peer makes signals-video flow first-class forensic evidence, the way
 * `VoicePlayoutReset` already is for voice.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { filmstripController } from '../video-filmstrip';
import type { StreamsStore } from '../../../streams-store';

const PEER = 'uhCAkFakePeerPubKeyB64_____________________________';

function makeFakeStore() {
  const logCustomMessage = vi.fn();
  const store = {
    logger: { logCustomMessage },
    clock: { now: () => Date.now() },
  } as unknown as StreamsStore;
  return { store, logCustomMessage };
}

function clip(seq: number, ts: number): string {
  return JSON.stringify({
    seq,
    ts,
    t0: ts,
    data: 'eA==', // 1 byte
    n: 6,
    p: 167,
    w: 64,
    h: 48,
  });
}

describe('filmstrip rx logging', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    // jsdom has no object-URL implementation; the receive path only
    // needs the calls to not throw.
    URL.createObjectURL = vi.fn(() => 'blob:fake');
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    filmstripController.unbind();
    vi.useRealTimers();
  });

  test('a closing stats window emits one FilmstripRx custom log for the peer', () => {
    const { store, logCustomMessage } = makeFakeStore();
    filmstripController.bind(store);

    filmstripController.receiveFrame(PEER, clip(1, 0));
    vi.setSystemTime(1100);
    filmstripController.receiveFrame(PEER, clip(2, 1100));

    const lines = logCustomMessage.mock.calls
      .map(c => c[0] as string)
      .filter(l => l.startsWith('FilmstripRx'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`[${PEER.slice(0, 8)}]`);
    expect(lines[0]).toMatch(/fps=/);
    expect(lines[0]).toMatch(/loss=/);
  });

  test('windows closing inside the log interval are throttled; a later one logs again', () => {
    const { store, logCustomMessage } = makeFakeStore();
    filmstripController.bind(store);

    filmstripController.receiveFrame(PEER, clip(1, 0));
    vi.setSystemTime(1100);
    filmstripController.receiveFrame(PEER, clip(2, 1100)); // logs (1st)
    vi.setSystemTime(2200);
    filmstripController.receiveFrame(PEER, clip(3, 2200)); // window closes, throttled

    // 30s reporting cadence (NOT a liveness window — pure log volume
    // control, mirroring VoicePlayoutReset's throttle).
    vi.setSystemTime(1100 + 30_000 + 1100);
    filmstripController.receiveFrame(PEER, clip(4, 1100 + 30_000 + 1100));

    const lines = logCustomMessage.mock.calls
      .map(c => c[0] as string)
      .filter(l => l.startsWith('FilmstripRx'));
    expect(lines).toHaveLength(2);
  });
});
