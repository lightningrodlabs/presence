// Copied from presence ui/src/room/modules/__tests__/filmstrip-rx-logging.test.ts at ab90584 (signals-media extraction). Presence keeps its own copy until the adoption round.
/**
 * Filmstrip receive stats must reach the host's log sink, not just
 * console.log. Motivating gap (2026-08-25 field diagnosis): during the lMp
 * audio outage the exported logs could not answer "was video still flowing
 * from this peer?" — the rx stats line existed only in DevTools, and flow
 * had to be inferred indirectly from a `PresenceAdd reason=media-live`
 * event. One throttled log line per peer makes signals-video flow
 * first-class forensic evidence, the way `VoicePlayoutReset` already is for
 * voice.
 *
 * Constrains: src/filmstrip-carrier.ts (the rx stats window).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FilmstripCarrier } from '../filmstrip-carrier.js';
import { makeFakeHost } from './fake-host.js';

const PEER = 'uhCAkFakePeerPubKeyB64_____________________________';

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
  let carrier: FilmstripCarrier;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    // Node has no object-URL implementation; the receive path only needs
    // the calls to not throw.
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
  });

  test('a closing stats window emits one FilmstripRx log line for the peer', () => {
    const f = makeFakeHost();
    carrier.bind(f.host);

    carrier.receiveFrame(PEER, clip(1, 0));
    vi.setSystemTime(1100);
    carrier.receiveFrame(PEER, clip(2, 1100));

    const lines = f.logs.filter(l => l.startsWith('FilmstripRx'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`[${PEER.slice(0, 8)}]`);
    expect(lines[0]).toMatch(/fps=/);
    expect(lines[0]).toMatch(/loss=/);
  });

  test('windows closing inside the log interval are throttled; a later one logs again', () => {
    const f = makeFakeHost();
    carrier.bind(f.host);

    carrier.receiveFrame(PEER, clip(1, 0));
    vi.setSystemTime(1100);
    carrier.receiveFrame(PEER, clip(2, 1100)); // logs (1st)
    vi.setSystemTime(2200);
    carrier.receiveFrame(PEER, clip(3, 2200)); // window closes, throttled

    // 30s reporting cadence (NOT a liveness window — pure log volume
    // control, mirroring VoicePlayoutReset's throttle).
    vi.setSystemTime(1100 + 30_000 + 1100);
    carrier.receiveFrame(PEER, clip(4, 1100 + 30_000 + 1100));

    const lines = f.logs.filter(l => l.startsWith('FilmstripRx'));
    expect(lines).toHaveLength(2);
  });
});
