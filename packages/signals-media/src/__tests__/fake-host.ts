import type { VoiceHost, FilmstripHost, PeerId, MediaKind, TrackHandle } from '../types.js';
import { ManualClock } from './manual-clock.js';

export interface SentPayload {
  kind: MediaKind;
  payload: string;
  targets: PeerId[];
}

/**
 * A `VoiceHost & FilmstripHost` that records everything the library asks of
 * it. Every host answer is settable, so a test drives target-set changes,
 * cadence changes and batch eligibility without touching the library.
 */
export function makeFakeHost(
  opts: {
    targets?: PeerId[];
    cadence?: 'full' | 'voice-only' | 'paused';
    batchEligible?: boolean;
    clock?: ManualClock;
  } = {}
) {
  const clock = opts.clock ?? new ManualClock(1_000_000);
  const sent: SentPayload[] = [];
  const logs: string[] = [];
  let targets = new Set<PeerId>(opts.targets ?? []);
  let cadence = opts.cadence ?? 'full';
  let batchEligible = opts.batchEligible ?? false;
  const track = {
    readyState: 'live',
    enabled: true,
    kind: 'audio',
    stop() {},
  } as unknown as MediaStreamTrack;
  const host: VoiceHost & FilmstripHost = {
    targets: () => targets,
    cadence: () => cadence,
    send: async (kind, payload, t) => {
      sent.push({ kind, payload, targets: [...t] });
    },
    clock,
    log: line => {
      logs.push(line);
    },
    acquireMic: async () => ({ track, release: () => {} } satisfies TrackHandle),
    acquireCamera: async () => ({ track, release: () => {} } satisfies TrackHandle),
    audioContext: () => ({ currentTime: 0, sampleRate: 48000 } as unknown as AudioContext),
    batchEligible: () => batchEligible,
  };
  return {
    host,
    sent,
    logs,
    clock,
    setTargets: (t: PeerId[]) => {
      targets = new Set(t);
    },
    setCadence: (c: typeof cadence) => {
      cadence = c;
    },
    setBatchEligible: (b: boolean) => {
      batchEligible = b;
    },
  };
}
