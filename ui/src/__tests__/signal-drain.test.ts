import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StreamsStore } from '../streams-store';

/**
 * Characterization of `StreamsStore.handleSignal`'s queue drain.
 *
 * `StreamsStore` cannot be constructed under vitest — `environment: 'node'` and
 * the constructor reads `window.sessionStorage`. But the drain touches only five
 * members, so the real shipped method can be exercised by building the prototype
 * directly and supplying those. This tests the code that ships, not a copy of it.
 *
 * The defect under test: `_processingSignal` is a latch that makes every
 * incoming signal push-and-return while true. If a handler threw, the reset was
 * skipped and the latch stranded true — silencing pings, pongs, presence, SDP
 * and module data for the rest of the session, with no error surfaced and no
 * recovery short of a reload.
 */

type Drain = {
  _signalQueue: unknown[];
  _processingSignal: boolean;
  signalDelayMs: number;
  logger: { logCustomMessage: (m: string) => void };
  _processSignal: (s: unknown) => Promise<void>;
  handleSignal: (s: unknown) => Promise<void>;
};

/**
 * Build a `StreamsStore` that has never run its constructor, with only the
 * members `handleSignal` touches.
 *
 * This is load-bearing and fragile in one specific way: it is valid only while
 * the drain reads exactly these five members. If someone later has it read a
 * field the real constructor initialises, that field is `undefined` here and
 * the failure shows up as a confusing mid-test error rather than as "you added
 * a dependency". If that happens, either stub the new member here or — better —
 * take it as the signal that the drain should be extracted into a function that
 * takes what it needs, the way `auto-flip-policy.ts` does.
 *
 *   _signalQueue      the queue being drained
 *   _processingSignal the latch under test
 *   signalDelayMs     the artificial-delay knob (0 disables the await)
 *   logger            the sink for dropped-signal messages
 *   _processSignal    the per-signal handler, stubbed to throw or record
 */
function makeDrain(processSignal: (s: unknown) => Promise<void>) {
  const logged: string[] = [];
  const store = Object.create(StreamsStore.prototype) as Drain;
  store._signalQueue = [];
  store._processingSignal = false;
  store.signalDelayMs = 0;
  store.logger = { logCustomMessage: (m: string) => logged.push(m) };
  store._processSignal = processSignal;
  return { store, logged };
}

const sig = (id: string) =>
  ({ type: 'Message', msg_type: 'PingUi', payload: id }) as unknown;

describe('handleSignal drain', () => {
  // The drain deliberately mirrors dropped signals to console.error so real
  // handler bugs keep their stack. Silence it here so an expected drop doesn't
  // look like a test failure in the output.
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('processes queued signals in order on the happy path', async () => {
    const seen: string[] = [];
    const { store } = makeDrain(async s => {
      seen.push((s as { payload: string }).payload);
    });

    await store.handleSignal(sig('a'));
    await store.handleSignal(sig('b'));

    expect(seen).toEqual(['a', 'b']);
    expect(store._processingSignal).toBe(false);
  });

  it('releases the latch when a handler throws', async () => {
    const { store } = makeDrain(async () => {
      throw new Error('malformed payload');
    });

    await store.handleSignal(sig('boom'));

    // The whole defect in one assertion: before the `finally`, this was true
    // and every later signal was dropped for the rest of the session.
    expect(store._processingSignal).toBe(false);
  });

  it('still processes the next signal after a handler throws', async () => {
    const seen: string[] = [];
    const { store } = makeDrain(async s => {
      const { payload } = s as { payload: string };
      if (payload === 'bad') throw new Error('malformed payload');
      seen.push(payload);
    });

    await store.handleSignal(sig('bad'));
    await store.handleSignal(sig('good'));

    expect(seen).toEqual(['good']);
  });

  it('does not discard signals already queued behind a throwing one', async () => {
    const seen: string[] = [];
    const { store } = makeDrain(async s => {
      const { payload } = s as { payload: string };
      if (payload === 'bad') throw new Error('malformed payload');
      seen.push(payload);
    });

    // Two signals arrive before the drain runs; the first one throws.
    store._signalQueue.push(sig('bad'));
    await store.handleSignal(sig('queued-behind'));

    expect(seen).toEqual(['queued-behind']);
    expect(store._processingSignal).toBe(false);
  });

  it('survives a throw that is not an Error', async () => {
    const { store, logged } = makeDrain(async () => {
      // eslint-disable-next-line no-throw-literal
      throw 'a bare string';
    });

    await store.handleSignal(sig('x'));

    expect(store._processingSignal).toBe(false);
    expect(logged.join('\n')).toContain('a bare string');
  });

  it('logs the dropped signal rather than failing silently', async () => {
    const { store, logged } = makeDrain(async () => {
      throw new Error('malformed payload');
    });

    await store.handleSignal(sig('x'));

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('Dropped signal');
    expect(logged[0]).toContain('Message/PingUi');
    expect(logged[0]).toContain('malformed payload');
  });

  it('rejects re-entrant drains but keeps the signal', async () => {
    const seen: string[] = [];
    let reentered = false;
    const { store } = makeDrain(async s => {
      const { payload } = s as { payload: string };
      seen.push(payload);
      // Re-enter while the latch is held, as a nested signal delivery would.
      if (!reentered) {
        reentered = true;
        await store.handleSignal(sig('nested'));
      }
    });

    await store.handleSignal(sig('outer'));

    // The nested call returns early, but its signal is queued and still drained.
    expect(seen).toEqual(['outer', 'nested']);
    expect(store._processingSignal).toBe(false);
  });

  it('does not leave the latch set when the queue is empty', async () => {
    const { store } = makeDrain(async () => {});
    const spy = vi.fn();
    store._processSignal = spy;

    store._signalQueue = [];
    await store.handleSignal(sig('only'));

    expect(spy).toHaveBeenCalledTimes(1);
    expect(store._processingSignal).toBe(false);
  });
});
