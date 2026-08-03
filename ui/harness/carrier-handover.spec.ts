/**
 * Carrier-handover field validation (Phase 1.5 item 4; Phase 6.5 rebuilt
 * the page side on the REAL StreamsStore).
 *
 * Two pages, each an agent running the production orchestrator — a real
 * `StreamsStore` over real `FsmTransport`/`RTCPeerConnection` (loopback
 * ICE + DTLS), signaling relayed page-to-page with Holochain's
 * fire-and-forget semantics. Establishment is the production path end to
 * end: pings → pongs carrying capability declarations → the initiator
 * tie-break → InitRequest/InitAccept → SDP over the bus → the store's own
 * `_dispatchMediaEvent` applying the slot. Asserts the Phase 1 carrier
 * invariant against a real network stack, in both directions:
 *
 *   1. Signals carries the peer for the ENTIRE establishment window
 *      (make-before-break: no timeline entry before `connected` ever shows
 *      the peer off signals).
 *   2. Signals stands down the moment WebRTC is `connected`.
 *   3. On a silent peer drop (page closed, no goodbye — the VPN-flap
 *      shape), the survivor traverses the production recovery phases and
 *      the CARRIER flips back to signals when the transport gives up
 *      (`failed`/`closed` clears the real slot).
 *   4. The declared recovery-window exception (carrier-coverage.ts, Phase
 *      1.5 item 5) holds: while `reconnecting`/`disconnected`, the real
 *      slot still claims `connected` and the peer stays OFF signals —
 *      bounded, documented, asserted here so a future change to that trade
 *      is a failing test, not a silent drift.
 *   5. A returning peer re-establishes through the same production
 *      handshake and signals stands down again.
 *
 * Since Phase 6.5 there is NO mirrored store glue in this suite — the
 * "MODELED: only the glue" caveat is retired for the media path. Presence
 * is real too: `onSignals` requires pong-fresh presence, so the
 * silent-drop assertions key on `carrier` (the slot authority) — a
 * vanished peer leaves the present set from pong staleness on its own
 * clock, which is production behavior, not a harness artifact.
 *
 * The flap is a real teardown detected by real ICE consent loss, not CDP
 * network emulation — Chromium's CDP network conditions do not affect
 * WebRTC's UDP sockets, so closing the peer's page is the honest way to
 * take the network away.
 *
 * Runs in the nightly harness gate (.github/workflows/nightly-harness.yaml),
 * not in `verify` — establishment is fast but the silent-drop detection
 * rides real ICE consent timeouts.
 */
import { test, expect, type Page } from '@playwright/test';

type HarnessState = {
  me: string;
  peer: string;
  started: boolean;
  connected: boolean;
  phase: string;
  carrier: 'webrtc' | 'signals';
  onSignals: boolean;
  peerPresent: boolean;
  slot: { connectionId: string; connected: boolean } | null;
  timeline: Array<{
    t: number;
    phase: string;
    connectionId: string;
    carrier: 'webrtc' | 'signals';
    onSignals: boolean;
    slotConnected: boolean | null;
  }>;
};

const PAGE_URL = (me: string, peer: string) =>
  `/harness/carrier-handover-harness.html?me=${me}&peer=${peer}`;

async function harnessState(page: Page): Promise<HarnessState> {
  return page.evaluate(() => (window as any).carrierHarness.state());
}

async function openAgent(page: Page, me: string, peer: string): Promise<void> {
  await page.goto(PAGE_URL(me, peer));
  await page.waitForFunction(() => (window as any).carrierHarness !== undefined);
  await page.evaluate(() => (window as any).carrierHarness.start());
}

/** Wait until the page's store has seen a pong from the peer (real
 *  presence) — the precondition for every carrier claim below. */
async function waitForPresence(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForFunction(
    () => (window as any).carrierHarness.state().peerPresent === true,
    undefined,
    { timeout: timeoutMs },
  );
}

async function waitForCarrier(
  page: Page,
  carrier: 'webrtc' | 'signals',
  timeoutMs: number,
): Promise<void> {
  await page.waitForFunction(
    expected => (window as any).carrierHarness.state().carrier === expected,
    carrier,
    { timeout: timeoutMs },
  );
}

test.describe('carrier handover across a real WebRTC link', () => {
  test.setTimeout(180_000);

  test('signals carries until connected, resumes on silent drop, stands down on return', async ({
    context,
  }) => {
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    await openAgent(pageA, 'agent-A', 'agent-B');
    await openAgent(pageB, 'agent-B', 'agent-A');

    // --- Baseline: pongs flowing, conversation not joined → the peer is
    // present, no WebRTC attempt exists, signals carries. ---
    await waitForPresence(pageA, 15_000);
    await waitForPresence(pageB, 15_000);
    for (const page of [pageA, pageB]) {
      const s = await harnessState(page);
      expect(s.carrier).toBe('signals');
      expect(s.onSignals).toBe(true);
      expect(s.slot).toBeNull();
    }

    // --- Join the call on both sides (activates the conversation module
    // through the store's real path). Establishment then runs by itself:
    // caps propagate in pong metadata, the higher key initiates,
    // InitRequest/InitAccept and the SDP exchange ride the bus. ---
    await pageA.evaluate(() => (window as any).carrierHarness.connect());
    await pageB.evaluate(() => (window as any).carrierHarness.connect());

    await waitForCarrier(pageA, 'webrtc', 30_000);
    await waitForCarrier(pageB, 'webrtc', 30_000);

    // Direction 1: signals stood down only now that ICE + DTLS are up.
    for (const page of [pageA, pageB]) {
      const s = await harnessState(page);
      expect(s.phase).toBe('connected');
      expect(s.onSignals).toBe(false);

      // Make-before-break: every timeline entry BEFORE the first
      // `connected` kept the peer on signals. The silence window §3.1
      // documents — off signals from the start of negotiation — shows up
      // here as a failing row. (Presence is guaranteed by flowing pongs
      // throughout establishment, so onSignals is meaningful here.)
      const firstConnected = s.timeline.findIndex(e => e.phase === 'connected');
      expect(firstConnected).toBeGreaterThan(-1);
      for (const entry of s.timeline.slice(0, firstConnected)) {
        expect(entry, `pre-connected entry off signals: ${JSON.stringify(entry)}`).toMatchObject({
          onSignals: true,
          carrier: 'signals',
        });
      }
    }

    // --- Silent drop: close A's page. No leave, no close signal — B's
    // real ICE consent checks are the only way to find out. ---
    await pageA.close();

    // Direction 2: the carrier flips back to signals once the transport
    // gives up and the store clears the real slot. (onSignals is NOT the
    // wait condition: the vanished peer also leaves the present set when
    // pongs go stale — real presence, production behavior.)
    await waitForCarrier(pageB, 'signals', 120_000);

    const afterDrop = await harnessState(pageB);
    const firstConnectedIdx = afterDrop.timeline.findIndex(e => e.phase === 'connected');
    const post = afterDrop.timeline.slice(firstConnectedIdx + 1);

    // The entry that flipped the carrier is a terminal give-up clearing
    // the slot — not a recovery phase.
    const resumeEntry = post.find(e => e.carrier === 'signals');
    expect(resumeEntry).toBeDefined();
    expect(['failed', 'closed', 'idle']).toContain(resumeEntry!.phase);
    expect(resumeEntry!.slotConnected).toBeNull();

    // The declared recovery-window exception: while the transport owned
    // recovery, the REAL slot kept claiming connected (carrier stays
    // webrtc, peer off signals). If this assertion starts failing, the
    // exception declared in carrier-coverage.ts has been repealed —
    // update that invariant text in the same change.
    const recoveryEntries = post.filter(
      e => e.phase === 'reconnecting' || e.phase === 'disconnected',
    );
    // Non-empty, or the exception assertions below pass vacuously and
    // "repealing the exception is a failing test" stops being true
    // (PR #3 review finding F3).
    expect(recoveryEntries.length).toBeGreaterThan(0);
    for (const entry of recoveryEntries) {
      expect(entry, `recovery entry deviates from declared exception: ${JSON.stringify(entry)}`).toMatchObject({
        carrier: 'webrtc',
        slotConnected: true,
        onSignals: false,
      });
    }

    // --- The peer returns. Fresh page, same agent id; it joins the call
    // and initiates; B's acceptor-side FSM and slot install through the
    // store's own signaling route without B re-joining anything — as in
    // production, where the returning peer initiates. ---
    const pageA2 = await context.newPage();
    await openAgent(pageA2, 'agent-A', 'agent-B');
    await waitForPresence(pageA2, 15_000);
    await pageA2.evaluate(() => (window as any).carrierHarness.connect());

    await waitForCarrier(pageA2, 'webrtc', 30_000);
    await waitForCarrier(pageB, 'webrtc', 30_000);

    const final = await harnessState(pageB);
    expect(final.phase).toBe('connected');
    expect(final.onSignals).toBe(false);
  });
});
