import { describe, it, expect, vi } from 'vitest';
import {
  RoomOwnership,
  decideHolderMessage,
  decideTakerMessage,
  roomLockName,
  TAKEOVER_ACK_TIMEOUT_MS,
  ROOM_CHANNEL_NAME,
} from '../room-ownership';
import type {
  LockManagerLike,
  RoomChannelLike,
  RoomOwnershipSeams,
} from '../room-ownership';
import { ManualClock } from '../clock.testing';

/**
 * View-layer round: the cross-pane room-ownership protocol, extracted
 * from presence-app (§8's flagship extraction candidate — it was inline
 * view code with zero tests). Pure decisions table-test; the handshake
 * runs end-to-end over an in-process channel hub and a fake lock
 * manager, with the taker's ack window on a ManualClock.
 */

// ---------------------------------------------------------------------------
// Fakes

/** In-process BroadcastChannel semantics: same-name channels, no echo. */
function channelHub() {
  type Fake = RoomChannelLike & { closed: boolean };
  const channels: Fake[] = [];
  return {
    open(): Fake {
      const c: Fake = {
        closed: false,
        onmessage: null,
        postMessage(data: unknown) {
          if (c.closed) throw new Error('channel closed');
          for (const other of channels) {
            if (other !== c && !other.closed) other.onmessage?.({ data });
          }
        },
        close() {
          c.closed = true;
        },
      };
      channels.push(c);
      return c;
    },
  };
}

/**
 * Web Locks semantics the protocol relies on: exclusive per name, held
 * until the holder callback's returned promise resolves, ifAvailable
 * fails fast, a signal-bearing wait grants on release or rejects
 * AbortError on abort.
 */
function fakeLockManager(): LockManagerLike & {
  heldNames: () => string[];
} {
  const held = new Map<string, Promise<unknown>>();
  const grant = async (
    name: string,
    cb: (lock: object | null) => unknown
  ) => {
    const holding = Promise.resolve(cb({ name }));
    held.set(name, holding);
    holding.finally(() => {
      if (held.get(name) === holding) held.delete(name);
    });
    await holding;
  };
  return {
    heldNames: () => [...held.keys()],
    async request(name, options, callback) {
      if (!held.has(name)) return grant(name, callback);
      if (options.ifAvailable) {
        await callback(null);
        return;
      }
      const current = held.get(name)!;
      await new Promise<void>((resolve, reject) => {
        const onAbort = () =>
          reject(Object.assign(new Error('timed out'), { name: 'AbortError' }));
        if (options.signal?.aborted) {
          onAbort();
          return;
        }
        options.signal?.addEventListener('abort', onAbort);
        current.finally(() => {
          options.signal?.removeEventListener('abort', onAbort);
          resolve();
        });
      });
      return grant(name, callback);
    },
  };
}

function pane(overrides: Partial<RoomOwnershipSeams> = {}) {
  const clock = new ManualClock();
  const seams: RoomOwnershipSeams = {
    getLocks: () => undefined,
    openChannel: () => {
      throw new Error('no channel seam provided');
    },
    clock,
    ...overrides,
  };
  return { ownership: new RoomOwnership(seams), clock };
}

const DNA = 'uhC0k-dna-1';
const OTHER_DNA = 'uhC0k-dna-2';

// ---------------------------------------------------------------------------
// Pure decision tables

describe('decideHolderMessage', () => {
  const table: Array<{ name: string; data: unknown; want: object }> = [
    { name: 'null', data: null, want: { action: 'ignore', reason: 'malformed' } },
    { name: 'a string', data: 'kick', want: { action: 'ignore', reason: 'malformed' } },
    {
      name: 'another room´s kick',
      data: { type: 'kick', dnaHashB64: OTHER_DNA },
      want: { action: 'ignore', reason: 'other-room' },
    },
    {
      name: 'a released echo for our room',
      data: { type: 'released', dnaHashB64: DNA },
      want: { action: 'ignore', reason: 'not-kick' },
    },
    {
      name: 'a kick for our room',
      data: { type: 'kick', dnaHashB64: DNA },
      want: { action: 'ack-and-release' },
    },
  ];
  it.each(table)('$name', ({ data, want }) => {
    expect(decideHolderMessage(data, DNA)).toEqual(want);
  });
});

describe('decideTakerMessage', () => {
  const table: Array<{ name: string; data: unknown; want: object }> = [
    { name: 'null', data: null, want: { action: 'ignore', reason: 'malformed' } },
    {
      name: 'a kick (our own broadcast class)',
      data: { type: 'kick', dnaHashB64: DNA },
      want: { action: 'ignore', reason: 'not-released' },
    },
    {
      name: 'another room released',
      data: { type: 'released', dnaHashB64: OTHER_DNA },
      want: { action: 'ignore', reason: 'other-room' },
    },
    {
      name: 'our room released',
      data: { type: 'released', dnaHashB64: DNA },
      want: { action: 'takeover-acknowledged' },
    },
  ];
  it.each(table)('$name', ({ data, want }) => {
    expect(decideTakerMessage(data, DNA)).toEqual(want);
  });
});

// ---------------------------------------------------------------------------
// Acquire outcomes

describe('RoomOwnership.acquire', () => {
  it('no Web Locks API → no-lock-manager, not holding', async () => {
    const { ownership } = pane();
    expect(await ownership.acquire(DNA, { onKicked: () => {} })).toBe(
      'no-lock-manager'
    );
    expect(ownership.holding).toBe(false);
  });

  it('free lock → acquired, holding, lock named per room DNA', async () => {
    const locks = fakeLockManager();
    const hub = channelHub();
    const { ownership } = pane({
      getLocks: () => locks,
      openChannel: () => hub.open(),
    });
    expect(await ownership.acquire(DNA, { onKicked: () => {} })).toBe(
      'acquired'
    );
    expect(ownership.holding).toBe(true);
    expect(locks.heldNames()).toEqual([roomLockName(DNA)]);
  });

  it('held lock, fail-fast (no waitMs) → already-open', async () => {
    const locks = fakeLockManager();
    const hub = channelHub();
    const holder = pane({ getLocks: () => locks, openChannel: () => hub.open() });
    await holder.ownership.acquire(DNA, { onKicked: () => {} });

    const second = pane({ getLocks: () => locks, openChannel: () => hub.open() });
    expect(await second.ownership.acquire(DNA, { onKicked: () => {} })).toBe(
      'already-open'
    );
    expect(second.ownership.holding).toBe(false);
    expect(holder.ownership.holding).toBe(true);
  });

  it('held lock, bounded wait expires → already-open (AbortError swallowed silently)', async () => {
    const locks = fakeLockManager();
    const hub = channelHub();
    const holder = pane({ getLocks: () => locks, openChannel: () => hub.open() });
    await holder.ownership.acquire(DNA, { onKicked: () => {} });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const second = pane({
        getLocks: () => locks,
        openChannel: () => hub.open(),
      });
      // Real (small) wall-clock wait: the abort signal is consumed by the
      // lock manager, deliberately outside the clock seam (see module doc).
      expect(
        await second.ownership.acquire(DNA, {
          waitMs: 20,
          onKicked: () => {},
        })
      ).toBe('already-open');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('lock manager rejecting with a non-abort error → already-open, warned', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { ownership } = pane({
        getLocks: () => ({
          request: () => Promise.reject(new Error('boom')),
        }),
      });
      expect(await ownership.acquire(DNA, { onKicked: () => {} })).toBe(
        'already-open'
      );
      expect(warn).toHaveBeenCalledWith('locks.request failed', expect.any(Error));
    } finally {
      warn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// The takeover handshake, end-to-end

function twoPanes() {
  const locks = fakeLockManager();
  const hub = channelHub();
  const make = () =>
    pane({ getLocks: () => locks, openChannel: () => hub.open() });
  return { locks, holder: make(), taker: make() };
}

describe('takeover handshake', () => {
  it('kick → ack → release: taker resolves true, holder is kicked out and lets go', async () => {
    const { holder, taker } = twoPanes();
    const kicked = vi.fn();
    await holder.ownership.acquire(DNA, { onKicked: kicked });

    const ok = await taker.ownership.requestTakeover(DNA);
    expect(ok).toBe(true);
    expect(kicked).toHaveBeenCalledTimes(1);
    expect(holder.ownership.holding).toBe(false);

    // The freed lock is genuinely acquirable by the taker (the
    // waitMs re-acquire step of the click flow).
    expect(
      await taker.ownership.acquire(DNA, { waitMs: 20, onKicked: () => {} })
    ).toBe('acquired');
  });

  it('nobody holding → the ack window lapses on the clock and resolves false', async () => {
    const { taker } = twoPanes();
    const p = taker.ownership.requestTakeover(DNA);
    taker.clock.advance(TAKEOVER_ACK_TIMEOUT_MS);
    expect(await p).toBe(false);
  });

  it('a holder of a DIFFERENT room ignores the kick and keeps its lock', async () => {
    const { holder, taker } = twoPanes();
    const kicked = vi.fn();
    await holder.ownership.acquire(OTHER_DNA, { onKicked: kicked });

    const p = taker.ownership.requestTakeover(DNA);
    taker.clock.advance(TAKEOVER_ACK_TIMEOUT_MS);
    expect(await p).toBe(false);
    expect(kicked).not.toHaveBeenCalled();
    expect(holder.ownership.holding).toBe(true);
  });

  it('the ack is posted BEFORE the holder closes its channel (the ordering invariant)', async () => {
    // If release ran first, the holder's postMessage would throw on the
    // closed channel: the swallow-warn arm fires and the taker never
    // hears 'released'. Success of the handshake is therefore the pin —
    // this test locks the failure shape explicitly.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { holder, taker } = twoPanes();
      await holder.ownership.acquire(DNA, { onKicked: () => {} });
      const p = taker.ownership.requestTakeover(DNA);
      taker.clock.advance(TAKEOVER_ACK_TIMEOUT_MS);
      expect(await p).toBe(true);
      expect(warn).not.toHaveBeenCalledWith(
        'released broadcast failed',
        expect.anything()
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe('release', () => {
  it('is idempotent and safe when not holding', async () => {
    const { holder } = twoPanes();
    holder.ownership.release(); // never acquired
    await holder.ownership.acquire(DNA, { onKicked: () => {} });
    holder.ownership.release();
    holder.ownership.release();
    expect(holder.ownership.holding).toBe(false);
  });

  it('after release, another pane acquires fail-fast', async () => {
    const { holder, taker } = twoPanes();
    await holder.ownership.acquire(DNA, { onKicked: () => {} });
    holder.ownership.release();
    // The fake frees the lock when the holder promise resolves.
    await Promise.resolve();
    expect(await taker.ownership.acquire(DNA, { onKicked: () => {} })).toBe(
      'acquired'
    );
  });
});

describe('channel discipline', () => {
  it('every pane meets on the one channel name', async () => {
    const locks = fakeLockManager();
    const names: string[] = [];
    const hub = channelHub();
    const { ownership, clock } = pane({
      getLocks: () => locks,
      openChannel: name => {
        names.push(name);
        return hub.open();
      },
    });
    await ownership.acquire(DNA, { onKicked: () => {} });
    const p = ownership.requestTakeover(OTHER_DNA);
    clock.advance(TAKEOVER_ACK_TIMEOUT_MS);
    await p;
    expect(names).toEqual([ROOM_CHANNEL_NAME, ROOM_CHANNEL_NAME]);
  });
});
