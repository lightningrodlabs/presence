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

import { render } from 'lit';
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

/**
 * Re-entrancy (release-0.16.0 final review, M1): a second Leave click
 * during the finalize wait used to run stopAndAnnounce, disconnect and
 * the `quit-room` event twice. `_quitting` guards the method, the Leave
 * button renders disabled while it is set, and a reconnect (Lit DOM
 * reuse) resets it.
 */
describe('quitRoom re-entrancy guard', () => {
  it('two Leave clicks during the finalize wait: one stopAndAnnounce, one disconnect, one quit-room event', async () => {
    const clock = new ManualClock(1_000);
    const el = makeQuittingRoomView(clock);
    let release!: () => void;
    const stop = vi
      .spyOn(transcriptionController, 'stopAndAnnounce')
      .mockImplementation(() => new Promise<void>(r => (release = r)));
    el._speakerLabels.refresh = vi.fn(async () => {});
    const quitEvents = vi.fn();
    el.addEventListener('quit-room', quitEvents);

    const first = el.quitRoom();
    await flush();
    const second = el.quitRoom(); // the second click, mid-wait
    await flush();
    expect(stop).toHaveBeenCalledTimes(1);

    release();
    await Promise.all([first, second]);
    expect(el.streamsStore.disconnect).toHaveBeenCalledTimes(1);
    expect(el.streamsStore.logger.endSession).toHaveBeenCalledTimes(1);
    expect(quitEvents).toHaveBeenCalledTimes(1);
    // The guard stays set after the quit: the element is on its way out.
    expect(el._quitting).toBe(true);
  });

  it('the Leave button renders disabled while quitting, and not otherwise', () => {
    const el = makeQuittingRoomView(new ManualClock(1_000));
    const renderLeave = () => {
      const host = document.createElement('div');
      render(el._renderLeaveButton(), host);
      return host.querySelector('.btn-stop') as HTMLElement;
    };
    expect(renderLeave().classList.contains('disabled')).toBe(false);
    expect(renderLeave().getAttribute('aria-disabled')).toBeNull();

    el._quitting = true;
    expect(renderLeave().classList.contains('disabled')).toBe(true);
    expect(renderLeave().getAttribute('aria-disabled')).toBe('true');
  });

  it('a reconnect resets the guard (Lit DOM reuse)', () => {
    const el = makeQuittingRoomView(new ManualClock(1_000));
    el._quitting = true;
    // connectedCallback enables updating, which would schedule a full
    // render against this fake store; the guard reset is what is under
    // test, so the render is stubbed out on this instance only.
    el.scheduleUpdate = async () => {};
    el.connectedCallback();
    expect(el._quitting).toBe(false);
    // …and it reached the base class (the render root exists).
    expect(el.renderRoot).toBeTruthy();
  });
});
