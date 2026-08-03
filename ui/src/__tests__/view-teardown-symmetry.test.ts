// @vitest-environment jsdom
/**
 * Teardown-symmetry pins for the four leaks fixed by the 2026-08 retro
 * (MAINTAINABILITY_ASSESSMENT.md §7.4 item 1, §7.5 item 5's first step):
 *
 *   1. room-view's document-level keydown listener is removed on disconnect.
 *   2. room-view's asset-store unsubscriber is invoked on disconnect.
 *   3. RoomView.disconnectedCallback and PresenceApp.disconnectedCallback
 *      reach super.disconnectedCallback() — without it Lit never runs
 *      hostDisconnected on the reactive controllers, so every
 *      StoreSubscriber outlives its element. The controller spy below is
 *      the direct pin: it fails if the super call is dropped again.
 *   4. StreamsStore.static connect holds exactly ONE allAgents
 *      subscription and disconnect() releases it (it used to hold two,
 *      releasing neither, which kept the room store's lazy polling alive
 *      past the room).
 *
 * Scope, stated honestly: these tests drive the lifecycle methods directly
 * on constructed (never-mounted) elements — they pin the teardown halves
 * and the add/remove listener symmetry by reference, not a full
 * mount/render cycle. A full jsdom mount of room-view needs a fake-deps
 * mount harness (22 store subscriptions, weave context, shoelace render
 * paths) that does not exist yet; if one lands, fold these pins into it.
 * The static-connect test IS end-to-end over the real connect()/
 * disconnect() glue, on real jsdom storage and the real transports.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

// logs-graph pulls plotly.js, which does not survive jsdom import; the
// element is render-only courtesy UI (Phase 5 demotion) and irrelevant to
// teardown. Everything else loads for real.
vi.mock('../room/logs-graph', () => ({}));

import '../room/room-view';
import '../presence-app';
import { StreamsStore } from '../streams-store';
import { PresenceLogger } from '../logging';

function makeRoomView(): any {
  const el = document.createElement('room-view') as any;
  // The only store member disconnectedCallback touches.
  el.streamsStore = { disconnect: vi.fn() };
  return el;
}

describe('RoomView.disconnectedCallback (leaks 1–3)', () => {
  it('removes the document-level keydown handler it registered', () => {
    const el = makeRoomView();
    // What firstUpdated does — same property reference.
    document.addEventListener('keydown', el.keyDownListener);
    el.closeClosables = vi.fn();

    // Negative control: while registered, Escape reaches the handler —
    // proving the dispatch probe can detect a leaked listener.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(el.closeClosables).toHaveBeenCalledTimes(1);

    el.disconnectedCallback();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(el.closeClosables).toHaveBeenCalledTimes(1); // unchanged: removed
  });

  it('invokes the retained asset-store unsubscriber', () => {
    const el = makeRoomView();
    el._unsubscribe = vi.fn();
    el.disconnectedCallback();
    expect(el._unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('reaches super.disconnectedCallback so controllers get hostDisconnected', () => {
    const el = makeRoomView();
    const hostDisconnected = vi.fn();
    el.addController({ hostDisconnected });
    el.disconnectedCallback();
    expect(hostDisconnected).toHaveBeenCalledTimes(1);
  });

  it('still tells the store to disconnect', () => {
    const el = makeRoomView();
    el.disconnectedCallback();
    expect(el.streamsStore.disconnect).toHaveBeenCalledWith(
      'room-view-disconnectedCallback'
    );
  });
});

describe('PresenceApp.disconnectedCallback (leak 3, second copy)', () => {
  it('reaches super.disconnectedCallback so controllers get hostDisconnected', () => {
    const el = document.createElement('presence-app') as any;
    const hostDisconnected = vi.fn();
    el.addController({ hostDisconnected });
    el.disconnectedCallback();
    expect(hostDisconnected).toHaveBeenCalledTimes(1);
  });
});

describe('StreamsStore.connect allAgents subscription (leak 4)', () => {
  beforeAll(() => {
    // jsdom has no mediaDevices; static connect stores it in the deps
    // record and start() assigns ondevicechange.
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { enumerateDevices: async () => [], ondevicechange: null },
      configurable: true,
    });
  });

  it('subscribes exactly once and disconnect() releases it', async () => {
    const allAgents = {
      subscribeCalls: 0,
      active: 0,
      subscribe(cb: (val: any) => void) {
        this.subscribeCalls += 1;
        this.active += 1;
        cb({ status: 'complete', value: [] });
        return () => {
          this.active -= 1;
        };
      },
    };
    const roomStore = {
      client: {
        client: { myPubKey: new Uint8Array([1, 2, 3, 4]) },
        onSignal: () => () => {},
        sendMessage: async () => {},
      },
      allAgents,
    } as any;

    const store = await StreamsStore.connect(
      roomStore,
      async () => '',
      new PresenceLogger()
    );
    // One subscription serving both the load gate and ongoing updates —
    // the doubled load-gate subscription is the regression this pins.
    expect(allAgents.subscribeCalls).toBe(1);
    expect(allAgents.active).toBe(1);

    store.disconnect('view-teardown-symmetry-test');
    expect(allAgents.active).toBe(0);
  });
});
