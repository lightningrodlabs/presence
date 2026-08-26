// @vitest-environment jsdom
/**
 * Pins for the filmstrip stop/decode race (field symptom: a frozen
 * filmstrip frame stays painted over a live WebRTC video after the
 * signals->webrtc handover).
 *
 * Mechanism under test: `PeerFilmstrip._onFrame` awaits a JPEG
 * pre-decode before queueing a clip. The sender's courtesy stop (sent
 * by `stopCapture()` immediately after the last clip) delivers `null`
 * to the element while that decode is still pending; the null branch
 * clears the display synchronously, then the decode resolves and — with
 * no guard — re-queues the stale clip, restarts playback, and repaints
 * a frame that no future signal will ever clear (the controller's
 * inactivity TTL is armed only on clip arrival, and no clips arrive
 * once the peer is on WebRTC).
 *
 * The decode stub here is what makes the race deterministic: real
 * `HTMLImageElement.decode` resolves on its own schedule, so the test
 * holds the promise open until the stop has been processed. The
 * normal-path test below is the harness's negative control — it proves
 * the same stubbed pipeline does paint and activate when no clear
 * intervenes, so the race test's "stays clear" assertions are not
 * vacuously green.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';

import '../room/elements/peer-filmstrip';
import type { PeerFilmstrip } from '../room/elements/peer-filmstrip';
import { filmstripController } from '../room/modules/video-filmstrip';

let decodeResolvers: Array<() => void> = [];
let blobCounter = 0;

beforeAll(() => {
  // jsdom has no createObjectURL/revokeObjectURL; the controller calls
  // both on every clip.
  URL.createObjectURL = () => `blob:test-${++blobCounter}`;
  URL.revokeObjectURL = () => {};
  // Deterministic decode: each call parks until the test releases it.
  Object.defineProperty(HTMLImageElement.prototype, 'decode', {
    configurable: true,
    writable: true,
    value: function decode(): Promise<void> {
      return new Promise<void>(resolve => {
        decodeResolvers.push(resolve);
      });
    },
  });
});

afterEach(() => {
  decodeResolvers = [];
  document.body.innerHTML = '';
});

const clipPayload = (seq: number) => ({
  seq,
  ts: Date.now(),
  w: 96,
  h: 96,
  n: 1,
  p: 167,
  t0: Date.now(),
  data: btoa('jpeg-bytes'),
});

const stopPayload = (seq: number) => ({ kind: 'stop', seq, ts: Date.now() });

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

async function mountFilmstrip(peer: string): Promise<{
  el: PeerFilmstrip;
  strip: () => HTMLElement;
  slider: () => HTMLElement;
  activeCalls: boolean[];
}> {
  const el = document.createElement('peer-filmstrip') as PeerFilmstrip;
  const activeCalls: boolean[] = [];
  el.onActiveChange = (active: boolean) => activeCalls.push(active);
  el.agentPubKeyB64 = peer;
  document.body.appendChild(el);
  await el.updateComplete;
  return {
    el,
    strip: () => el.shadowRoot!.querySelector('.strip') as HTMLElement,
    slider: () => el.shadowRoot!.querySelector('.size-slider') as HTMLElement,
    activeCalls,
  };
}

describe('peer-filmstrip stop/decode race', () => {
  it('normal path paints on clip and clears on stop (negative control)', async () => {
    const peer = 'filmstrip-race-control-peer';
    const { el, strip, slider, activeCalls } = await mountFilmstrip(peer);

    filmstripController.receiveFrame(peer, JSON.stringify(clipPayload(1)));
    expect(decodeResolvers.length).toBe(1);
    decodeResolvers[0]();
    await tick();

    expect(strip().style.backgroundImage).toContain('blob:test-');
    expect(slider().style.display).toBe('block');
    expect(activeCalls).toEqual([true]);

    filmstripController.receiveFrame(peer, JSON.stringify(stopPayload(2)));
    expect(strip().style.backgroundImage).toBe('');
    expect(slider().style.display).toBe('none');
    expect(activeCalls).toEqual([true, false]);

    el.remove();
  });

  it('a stop delivered while a clip decode is pending must not repaint after the clear', async () => {
    const peer = 'filmstrip-race-peer';
    const { el, strip, slider, activeCalls } = await mountFilmstrip(peer);

    // Final clip of the handover: _onFrame parks at the decode await.
    filmstripController.receiveFrame(peer, JSON.stringify(clipPayload(1)));
    expect(decodeResolvers.length).toBe(1);

    // Courtesy stop lands (same signal burst) — clears synchronously.
    filmstripController.receiveFrame(peer, JSON.stringify(stopPayload(2)));

    // The stale decode resolves after the clear.
    decodeResolvers[0]();
    await tick();

    // The clear must win: nothing repainted, slider hidden, never active.
    expect(strip().style.backgroundImage).toBe('');
    expect(slider().style.display).toBe('none');
    expect(activeCalls).toEqual([]);

    el.remove();
  });
});
