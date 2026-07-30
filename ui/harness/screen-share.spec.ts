/**
 * Screen-share field validation (Phase 3.5 — the assessment's own section;
 * files the Phase 3 review's F4).
 *
 * Two pages, each running BOTH production screen-share FSM transports over
 * real RTCPeerConnections (loopback ICE + DTLS), signaling relayed
 * page-to-page in the production `SdpFsmScreen` envelope shape with
 * Holochain's fire-and-forget semantics. Asserts, against a real network
 * stack, the claims the Phase 3 port made that vitest mocks cannot
 * falsify — the three items the Phase 3.5 section specifies:
 *
 *   1. Sharer→viewer establishment over `SdpFsmScreen`: the sharer's offer
 *      builds the viewer's FSM lazily (the `install` route — there is no
 *      reservation to check anymore) and a real captured video track
 *      arrives, wiring the `_screenShareStreams` mirror.
 *   2. Role-routing under MUTUAL share: A→B and B→A are two independent
 *      connections on two transport pairs, kept apart by the sender's
 *      `dir` tag — connectionId cannot do it (each side allocates its
 *      own). Both directions must be connected AT THE SAME TIME with zero
 *      dropped signals. Plus the malformed-`dir` arm: a bogus envelope
 *      increments the drop counter and creates no state
 *      (`decideScreenSignalRoute` in the real routing path).
 *   3. Teardown and supersede: a reloaded sharer's fresh offer replaces
 *      the viewer's live FSM in place — the no-close-event route (§3.1(c))
 *      — and the slot ADOPTS the new connection (a `replace` write, the
 *      Phase 3 review's F1 semantics); transient recovery phases never
 *      clear a slot; and a final silent drop (page close, no goodbye —
 *      real ICE consent loss is the only witness) reaches a `media-closed`
 *      give-up that clears both slots and the streams mirror.
 *
 * Fidelity caveat (see screen-share-harness.ts header): the streams-store
 * wiring is mirrored, not executed; the decisions (routing, phase route,
 * slot writes) are the production functions.
 *
 * Runs in the nightly harness gate (.github/workflows/nightly-harness.yaml),
 * not in `verify` — the drop detection rides real ICE consent timeouts.
 */
import { test, expect, type Page } from '@playwright/test';

type Slot = { connectionId: string; connected: boolean } | null;

type HarnessState = {
  me: string;
  peer: string;
  started: boolean;
  sharing: boolean;
  out: { phase: string; slot: Slot };
  in: { phase: string; slot: Slot };
  streams: Record<string, { video: number }>;
  routed: { toIn: number; toOut: number; dropped: number };
  timeline: Array<{
    t: number;
    role: 'out' | 'in';
    phase: string;
    connectionId: string;
    route: string;
    write: string;
    outSlotConnected: boolean | null;
    inSlotConnected: boolean | null;
  }>;
};

const PAGE_URL = (me: string, peer: string, epoch0 = 0) =>
  `/harness/screen-share-harness.html?me=${me}&peer=${peer}&epoch0=${epoch0}`;

async function harnessState(page: Page): Promise<HarnessState> {
  return page.evaluate(() => (window as any).screenHarness.state());
}

async function openAgent(
  page: Page,
  me: string,
  peer: string,
  epoch0 = 0,
): Promise<void> {
  await page.goto(PAGE_URL(me, peer, epoch0));
  await page.waitForFunction(() => (window as any).screenHarness !== undefined);
  await page.evaluate(() => (window as any).screenHarness.start());
}

/** Wait until the expression over the harness state is truthy. */
async function waitForState(
  page: Page,
  pick: string,
  timeoutMs: number,
): Promise<void> {
  await page.waitForFunction(
    // eslint-disable-next-line no-new-func
    expr => new Function('s', `return ${expr}`)((window as any).screenHarness.state()),
    pick,
    { timeout: timeoutMs },
  );
}

test.describe('screen share across real WebRTC links', () => {
  test.setTimeout(240_000);

  test('establishes lazily, routes mutual shares by role, adopts a replaced FSM, tears down on silent drop', async ({
    context,
  }) => {
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    await openAgent(pageA, 'agent-A', 'agent-B');
    await openAgent(pageB, 'agent-B', 'agent-A');

    // --- 1. A shares to B: lazy viewer-side establishment. ---
    await pageA.evaluate(() => (window as any).screenHarness.share());

    await waitForState(pageA, 's.out.slot && s.out.slot.connected', 30_000);
    await waitForState(pageB, 's.in.slot && s.in.slot.connected', 30_000);
    await waitForState(pageB, "!!s.streams['agent-A']", 30_000);

    const bAfterEstablish = await harnessState(pageB);
    // The viewer's very first incoming-side event installed the slot from
    // the offer — the lazy-acceptor route. If a reservation handshake ever
    // creeps back in, or the slot is pre-installed some other way, this
    // stops being `install`.
    const firstIn = bAfterEstablish.timeline.find(e => e.role === 'in');
    expect(firstIn).toBeDefined();
    expect(firstIn!.route).toBe('signaling/signaling-started');
    expect(firstIn!.write).toBe('install');
    // A real video track arrived and the paint mirror is wired.
    expect(bAfterEstablish.streams['agent-A'].video).toBeGreaterThan(0);
    // Nothing was mis-routed or dropped while establishing one direction.
    expect(bAfterEstablish.routed.dropped).toBe(0);
    expect(bAfterEstablish.routed.toOut).toBe(0); // B is not sharing yet

    // --- 2. Mutual share: B shares back. Both directions must hold
    // connected simultaneously, on independent connections. ---
    await pageB.evaluate(() => (window as any).screenHarness.share());

    await waitForState(pageB, 's.out.slot && s.out.slot.connected', 30_000);
    await waitForState(pageA, 's.in.slot && s.in.slot.connected', 30_000);
    await waitForState(pageA, "!!s.streams['agent-B']", 30_000);

    for (const [page, peer] of [
      [pageA, 'agent-B'],
      [pageB, 'agent-A'],
    ] as const) {
      const s = await harnessState(page);
      expect(s.out.slot?.connected, `${s.me} outgoing`).toBe(true);
      expect(s.in.slot?.connected, `${s.me} incoming`).toBe(true);
      expect(s.streams[peer].video).toBeGreaterThan(0);
      // Zero drops under mutual traffic: every signal carried a valid dir
      // and reached a transport. A dir mix-up would surface either here or
      // as a connection that never reaches connected.
      expect(s.routed.dropped).toBe(0);
      // Both directions saw real signal traffic.
      expect(s.routed.toIn).toBeGreaterThan(0);
      expect(s.routed.toOut).toBeGreaterThan(0);
      // Two independent connections, not one shared/confused one.
      expect(s.out.slot!.connectionId).not.toBe(s.in.slot!.connectionId);
    }

    // --- 2b. Malformed dir: dropped, no state created. ---
    const beforeInject = await harnessState(pageA);
    await pageA.evaluate(() => (window as any).screenHarness.injectIncoming('both'));
    const afterInject = await harnessState(pageA);
    expect(afterInject.routed.dropped).toBe(beforeInject.routed.dropped + 1);
    // The live connections are untouched and no phantom appeared.
    expect(afterInject.out.slot).toEqual(beforeInject.out.slot);
    expect(afterInject.in.slot).toEqual(beforeInject.in.slot);

    // --- 3a. Replace-without-event → adopt (the §3.1(c) route; review
    // F1's supersede semantics). The sharer re-initiates at a HIGHER
    // epoch while B's old in-FSM is still `connected` (well inside
    // consent-loss detection, ~5-6s on loopback): ConnectionManager's
    // epoch ordering destroys the live FSM in place via fsm.destroy(),
    // which emits nothing; the new `signaling` must ADOPT the slot (a
    // `replace` write), never install beside it or be blocked by it.
    // The epoch0 seam stands in for production's session-scoped counter
    // allocating a later generation. (A plain reload instead resets
    // epochs — the equal-epoch case — which the FSM absorbs internally:
    // fresh RtcPeer, SAME connectionId, no slot events; that path needs
    // no slot machinery and is deliberately not asserted here.) ---
    const bBeforeReload = await harnessState(pageB);
    const oldInConnId = bBeforeReload.in.slot!.connectionId;

    await pageA.close();
    const pageA2 = await context.newPage();
    await openAgent(pageA2, 'agent-A', 'agent-B', 10);
    await pageA2.evaluate(() => (window as any).screenHarness.share());

    await waitForState(
      pageB,
      `s.in.slot && s.in.slot.connected && s.in.slot.connectionId !== ${JSON.stringify(oldInConnId)}`,
      30_000,
    );
    await waitForState(pageB, "!!s.streams['agent-A']", 30_000);

    const bAfterAdopt = await harnessState(pageB);
    const adoptEntry = bAfterAdopt.timeline.find(
      e => e.role === 'in' && e.write === 'replace',
    );
    expect(adoptEntry, 'viewer slot adopted the replacing connection').toBeDefined();

    // B's own outgoing share survives the reload one way or the other:
    // its FSM either recovered against the returned peer or gave up and
    // cleared, in which case share() re-ensures. Restore full mutual
    // before the teardown segment so both roles have live state to clear.
    await pageB.evaluate(() => (window as any).screenHarness.share());
    await waitForState(pageB, 's.out.slot && s.out.slot.connected', 60_000);
    await waitForState(pageB, 's.in.slot && s.in.slot.connected', 30_000);

    // --- 3b. Silent drop: close A for good. No goodbye on the wire; B's
    // real ICE consent checks are the only witness. Both of B's
    // directions must reach a terminal give-up that clears slot and
    // stream mirror. ---
    await pageA2.close();

    await waitForState(pageB, '!s.out.slot && !s.in.slot', 120_000);

    const final = await harnessState(pageB);
    expect(final.streams['agent-A']).toBeUndefined();
    for (const role of ['out', 'in'] as const) {
      const entries = final.timeline.filter(e => e.role === role);
      // The entry that cleared the slot is a terminal give-up routed as
      // media-closed — not a recovery phase. A `closed` can trail it as a
      // `none/no-slot` duplicate (the manager closes an FSM on `failed`);
      // consumers of closed must be idempotent, so the harness tolerates
      // exactly that shape and nothing else after the clear.
      const clearIdx = entries.map(e => e.write).lastIndexOf('clear');
      expect(clearIdx, `${role} has a clearing entry`).toBeGreaterThan(-1);
      const clearing = entries[clearIdx];
      expect(clearing.route, `${role} clearing route`).toContain('media-closed');
      expect(['failed', 'closed', 'idle']).toContain(clearing.phase);
      for (const after of entries.slice(clearIdx + 1)) {
        expect(after.write, `${role} post-clear entry`).toMatch(/^none\//);
      }
      const recovery = entries.filter(
        e => e.phase === 'reconnecting' || e.phase === 'disconnected',
      );
      // Non-empty, or the per-entry assertion below passes vacuously
      // (carrier-handover.spec.ts learned this as PR #3 review F3). A
      // page-close drop reliably surfaces as consent loss →
      // `reconnecting` before the give-up, on both roles.
      expect(recovery.length, `${role} recovery entries`).toBeGreaterThan(0);
      for (const entry of recovery) {
        // Transient phases never touch the slot — the FSM owns recovery
        // for screen share too, and the share pane state survives the
        // gap. The slot claim visible at each recovery entry must still
        // be present (not cleared).
        const claim = role === 'out' ? entry.outSlotConnected : entry.inSlotConnected;
        expect(entry.route, `${role} recovery entry`).toBe(
          'ignore/transport-owns-recovery',
        );
        expect(claim, `${role} slot survived recovery entry`).not.toBeNull();
      }
    }
  });
});
