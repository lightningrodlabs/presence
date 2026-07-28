/**
 * Carrier-handover field validation (Phase 1.5 item 4).
 *
 * Two pages, each an agent running the production FsmTransport over a real
 * RTCPeerConnection (loopback ICE + DTLS), signaling relayed page-to-page
 * with Holochain's fire-and-forget semantics. Asserts the Phase 1 carrier
 * invariant against a real network stack, in both directions:
 *
 *   1. Signals carries the peer for the ENTIRE establishment window
 *      (make-before-break: no timeline entry before `connected` ever shows
 *      the peer off signals).
 *   2. Signals stands down the moment WebRTC is `connected`.
 *   3. On a silent peer drop (page closed, no goodbye — the VPN-flap
 *      shape), the survivor traverses the production recovery phases and
 *      signals RESUMES when the transport gives up (`failed`/`closed`).
 *   4. The declared recovery-window exception (carrier-coverage.ts, Phase
 *      1.5 item 5) holds: while `reconnecting`/`disconnected`, the peer is
 *      still OFF signals — bounded, documented, asserted here so a future
 *      change to that trade is a failing test, not a silent drift.
 *   5. A returning peer re-establishes and signals stands down again.
 *
 * Fidelity caveat (see carrier-handover-harness.ts header): the
 * streams-store wiring is mirrored, not executed. The flap is a real
 * teardown detected by real ICE consent loss, not CDP network emulation —
 * Chromium's CDP network conditions do not affect WebRTC's UDP sockets, so
 * closing the peer's page is the honest way to take the network away.
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
  phase: string;
  carrier: 'webrtc' | 'signals';
  onSignals: boolean;
  slot: { connectionId: string; connected: boolean } | null;
  timeline: Array<{
    t: number;
    phase: string;
    connectionId: string;
    route: string;
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

    // --- Baseline: present peer, no WebRTC attempt → signals carries. ---
    for (const page of [pageA, pageB]) {
      const s = await harnessState(page);
      expect(s.carrier).toBe('signals');
      expect(s.onSignals).toBe(true);
    }

    // --- Establish. Both sides call ensureConnection, as the pong cycle
    // does in production; Perfect Negotiation sorts out roles. ---
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
      // here as a failing row.
      const firstConnected = s.timeline.findIndex(e => e.phase === 'connected');
      expect(firstConnected).toBeGreaterThan(-1);
      for (const entry of s.timeline.slice(0, firstConnected)) {
        expect(entry, `pre-connected entry off signals: ${JSON.stringify(entry)}`).toMatchObject({
          onSignals: true,
        });
      }
    }

    // --- Silent drop: close A's page. No leave, no close signal — B's
    // real ICE consent checks are the only way to find out. ---
    await pageA.close();

    // Direction 2: signals resumes once the transport gives up.
    await waitForCarrier(pageB, 'signals', 120_000);

    const afterDrop = await harnessState(pageB);
    const firstConnectedIdx = afterDrop.timeline.findIndex(e => e.phase === 'connected');
    const post = afterDrop.timeline.slice(firstConnectedIdx + 1);

    // The entry that put the peer back on signals is a terminal give-up,
    // routed as a slot clear — not a recovery phase.
    const resumeEntry = post.find(e => e.onSignals);
    expect(resumeEntry).toBeDefined();
    expect(['failed', 'closed', 'idle']).toContain(resumeEntry!.phase);
    expect(resumeEntry!.route).toContain('media-closed');

    // The declared recovery-window exception: while the transport owned
    // recovery, the peer stayed OFF signals with the slot still claiming
    // connected. If this assertion starts failing, the exception declared
    // in carrier-coverage.ts has been repealed — update that invariant
    // text in the same change.
    const recoveryEntries = post.filter(
      e => e.phase === 'reconnecting' || e.phase === 'disconnected',
    );
    for (const entry of recoveryEntries) {
      expect(entry, `recovery entry deviates from declared exception: ${JSON.stringify(entry)}`).toMatchObject({
        onSignals: false,
        route: 'ignore/transport-owns-recovery',
      });
    }

    // --- The peer returns. Fresh page, same agent id; its offer builds an
    // acceptor-side FSM on B (the `install` route) without B re-calling
    // connect — as in production, where the returning peer initiates. ---
    const pageA2 = await context.newPage();
    await openAgent(pageA2, 'agent-A', 'agent-B');
    await pageA2.evaluate(() => (window as any).carrierHarness.connect());

    await waitForCarrier(pageA2, 'webrtc', 30_000);
    await waitForCarrier(pageB, 'webrtc', 30_000);

    const final = await harnessState(pageB);
    expect(final.phase).toBe('connected');
    expect(final.onSignals).toBe(false);
  });
});
