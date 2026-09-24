// @vitest-environment jsdom
/**
 * The Leave button's finalization budget (Task 4 review I3). quitRoom
 * awaits transcript finalization (stopAndAnnounce, then a speaker-label
 * refresh) before disconnecting; both await host round trips with no
 * timeout of their own. A wedged host must not hold the user in the room:
 * past QUIT_FINALIZE_MAX_MS on the store's clock, the store disconnects.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../room/logs-graph', () => ({}));

import { QUIT_FINALIZE_MAX_MS } from '../room/room-view';
import { transcriptionController } from '../room/modules/transcription';
import { ManualClock } from '../clock.testing';

const never = () => new Promise<never>(() => {});

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function makeQuittingRoomView(clock: ManualClock) {
  const el = document.createElement('room-view') as any;
  el.streamsStore = {
    clock,
    disconnect: vi.fn(),
    logger: { endSession: vi.fn() },
  };
  // Transcribing, with one speaker in the log: both finalization steps run.
  el._myModuleStates = {
    value: {
      transcription: {
        moduleId: 'transcription',
        active: true,
        payload: JSON.stringify({ enabled: true, requested: true }),
        updatedAt: 1,
      },
    },
  };
  el._transcriptLog = { value: new Map([['speaker', []]]) };
  return el;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('quitRoom finalization budget', () => {
  it('a never-resolving stopAndAnnounce does not hold the user past QUIT_FINALIZE_MAX_MS', async () => {
    const clock = new ManualClock(1_000);
    const el = makeQuittingRoomView(clock);
    vi.spyOn(transcriptionController, 'stopAndAnnounce').mockImplementation(never);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const quitting = el.quitRoom();
    await flush();
    clock.advance(QUIT_FINALIZE_MAX_MS - 1);
    await flush();
    expect(el.streamsStore.disconnect).not.toHaveBeenCalled();

    clock.advance(1);
    await quitting;
    expect(el.streamsStore.disconnect).toHaveBeenCalledWith('quitRoom-button');
  });

  it('a never-resolving speaker-label refresh does not hold the user either', async () => {
    const clock = new ManualClock(1_000);
    const el = makeQuittingRoomView(clock);
    vi.spyOn(transcriptionController, 'stopAndAnnounce').mockResolvedValue(undefined);
    el._speakerLabels.refresh = vi.fn(never);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const quitting = el.quitRoom();
    await flush();
    expect(el._speakerLabels.refresh).toHaveBeenCalled();
    clock.advance(QUIT_FINALIZE_MAX_MS);
    await quitting;
    expect(el.streamsStore.disconnect).toHaveBeenCalledWith('quitRoom-button');
  });

  it('negative control: prompt finalization disconnects at once and leaves no timer armed', async () => {
    const clock = new ManualClock(1_000);
    const el = makeQuittingRoomView(clock);
    vi.spyOn(transcriptionController, 'stopAndAnnounce').mockResolvedValue(undefined);
    el._speakerLabels.refresh = vi.fn(async () => {});

    await el.quitRoom();
    expect(el.streamsStore.disconnect).toHaveBeenCalledWith('quitRoom-button');
    expect(clock.pendingTimerCount).toBe(0);
  });
});
