/**
 * Direct-signal latency & throughput measurements (phase 0 of
 * docs/DIRECT_SIGNALS_PLAN.md).
 *
 * Compares Holochain 0.7's `SendDirectSignal` app request (no WASM on either
 * side) against the zome-call `send_message` path, across TWO conductors —
 * same-conductor sends short-circuit through the conductor's in-process bridge
 * (`should_bridge`) and never touch the network, so they flatter the numbers.
 *
 * Like signal-latency.test.ts this is a measurement instrument, not a gate
 * (tests/README.md): assertions are delivery sanity checks, not thresholds.
 *
 * The raw-wire helpers below (sendDirectSignal / onDirectSignal) exist because
 * @holochain/client 0.21.0 has no direct-signal support and its stock signal
 * decoder throws on the `app_direct` variant. They double as the empirical
 * settlement of the wire encoding for `Vec<u8>` request fields, and as the
 * template for the phase-1 ui adapter (ui/src/direct-signal.ts).
 */

import { describe, expect, it } from 'vitest';
import { PlayerApp, Scenario, runScenario } from '@holochain-open-dev/tryorama';
import { AppBundleSource, AppWebsocket, encodeHashToBase64 } from '@holochain/client';
import { decode, encode } from '@msgpack/msgpack';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HAPP_PATH = path.resolve(__dirname, '../../../workdir/presence.happ');
const appBundleSource: AppBundleSource = { type: 'path', value: HAPP_PATH };
const appSource = { appBundleSource };
const ROLE_NAME = 'presence';
const ZOME_NAME = 'room';

const DIRECT_SIGNAL_MAX_SIZE = 1024 * 1024;

// ---------------------------------------------------------------------------
// Stats helpers (mirrors signal-latency.test.ts)
// ---------------------------------------------------------------------------

function computeStats(values: number[]) {
  if (values.length === 0)
    return { count: 0, min: 0, max: 0, mean: 0, median: 0, p95: 0, p99: 0, stddev: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / sorted.length;
  const variance = sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / sorted.length;
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: Math.round(mean * 100) / 100,
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    p99: sorted[Math.floor(sorted.length * 0.99)],
    stddev: Math.round(Math.sqrt(variance) * 100) / 100,
  };
}

function printStats(label: string, values: number[], unit = 'ms') {
  const stats = computeStats(values);
  console.log(`\n--- ${label} ---`);
  console.log(`  count:  ${stats.count}`);
  console.log(`  min:    ${stats.min} ${unit}`);
  console.log(`  max:    ${stats.max} ${unit}`);
  console.log(`  mean:   ${stats.mean} ${unit}`);
  console.log(`  median: ${stats.median} ${unit}`);
  console.log(`  p95:    ${stats.p95} ${unit}`);
  console.log(`  p99:    ${stats.p99} ${unit}`);
  console.log(`  stddev: ${stats.stddev} ${unit}`);
  return stats;
}

// ---------------------------------------------------------------------------
// Raw-wire direct-signal helpers
// ---------------------------------------------------------------------------

/**
 * Which msgpack encoding the conductor accepts for the request's
 * `signal: Vec<u8>` field: 'bin' (Uint8Array) or 'intarray' (number[]).
 * Settled empirically by the first successful send; logged by test 1.
 */
let settledEncoding: 'bin' | 'intarray' | null = null;

async function rawAppRequest(appWs: AppWebsocket, request: unknown, timeoutMs = 15_000) {
  const client = (appWs as any).client;
  const response: any = await Promise.race([
    client.request(request),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('direct-signal request timed out')), timeoutMs),
    ),
  ]);
  if (response?.type === 'error') {
    throw new Error(`conductor error: ${JSON.stringify(response.value)}`);
  }
  return response;
}

async function sendDirectSignal(
  appWs: AppWebsocket,
  dnaHash: Uint8Array,
  agents: Uint8Array[],
  signal: Uint8Array,
): Promise<void> {
  const make = (enc: 'bin' | 'intarray') => ({
    type: 'send_direct_signal',
    value: {
      dna_hash: dnaHash,
      agents,
      signal: enc === 'bin' ? signal : Array.from(signal),
    },
  });

  if (settledEncoding) {
    await rawAppRequest(appWs, make(settledEncoding));
    return;
  }
  try {
    await rawAppRequest(appWs, make('bin'));
    settledEncoding = 'bin';
  } catch (e: any) {
    if (/timed out/.test(e.message)) throw e;
    await rawAppRequest(appWs, make('intarray'));
    settledEncoding = 'intarray';
  }
}

type DirectSignalHandler = (cellId: [Uint8Array, Uint8Array], payload: Uint8Array) => void;

/**
 * Intercept `app_direct` signals BEFORE the stock client handler sees them —
 * @holochain/client 0.21.0's assertHolochainSignal throws UnknownSignalFormat
 * on the variant, which vitest would surface as an unhandled rejection. All
 * other wire messages are forwarded to the original handler untouched.
 */
function onDirectSignal(appWs: AppWebsocket, handler: DirectSignalHandler): () => void {
  const socket = (appWs as any).client.socket;
  const orig = socket.onmessage;
  socket.onmessage = (ev: any) => {
    try {
      if (typeof Buffer !== 'undefined' && Buffer.isBuffer(ev.data)) {
        const message: any = decode(ev.data);
        if (message?.type === 'signal' && message.data) {
          const sig: any = decode(message.data);
          if (sig?.type === 'app_direct') {
            const { cell_id, signal } = sig.value;
            const bytes = signal instanceof Uint8Array ? signal : Uint8Array.from(signal);
            handler(cell_id, bytes);
            return;
          }
        }
      }
    } catch {
      // fall through to the stock handler
    }
    return orig.call(socket, ev);
  };
  return () => {
    socket.onmessage = orig;
  };
}

// ---------------------------------------------------------------------------
// Scenario setup: two players, one conductor EACH
// ---------------------------------------------------------------------------

function roomCell(player: PlayerApp) {
  const cell = player.cells.find((c) => c.name === ROLE_NAME);
  if (!cell) throw new Error(`No cell with role name ${ROLE_NAME}`);
  return cell;
}

const call = <T>(player: PlayerApp, fn_name: string, payload: unknown): Promise<T> =>
  roomCell(player).callZome({ zome_name: ZOME_NAME, fn_name, payload }) as Promise<T>;

async function setupTwoConductors(scenario: Scenario) {
  const [alice, bob] = await scenario.addPlayersWithApps([appSource, appSource]);
  await scenario.shareAllAgents();

  // Arm each cell's init (cap grant for the zome path) with a first zome call.
  await call(alice, 'ping', []);
  await call(bob, 'ping', []);

  // Permanently swallow app_direct signals on both websockets so strays
  // (e.g. late arrivals after a phase interceptor unhooked) never reach the
  // stock @holochain/client handler, which throws on the variant. Phase
  // interceptors layer on top of this one and restore back to it.
  onDirectSignal(alice.appWs, () => {});
  onDirectSignal(bob.appWs, () => {});

  const dnaHash = roomCell(alice).cell_id[0] as unknown as Uint8Array;
  console.log(`  Alice: ${encodeHashToBase64(alice.agentPubKey)}`);
  console.log(`  Bob:   ${encodeHashToBase64(bob.agentPubKey)}`);
  return { alice, bob, dnaHash };
}

/** Build a payload of roughly `size` bytes with a decodable header. */
function directPayload(kind: string, seq: number, size: number): Uint8Array {
  const pad = new Uint8Array(Math.max(0, size));
  return encode({ kind, seq, pad });
}

function decodeDirectPayload(bytes: Uint8Array): { kind: string; seq: number; pad: Uint8Array } {
  return decode(bytes) as any;
}

/** Send direct signals until one is observed by the receiver (absorbs peer discovery). */
async function directWarmup(
  from: PlayerApp,
  to: PlayerApp,
  dnaHash: Uint8Array,
  timeoutMs = 30_000,
): Promise<number> {
  let seen = false;
  const unsub = onDirectSignal(to.appWs, (_cellId, bytes) => {
    if (decodeDirectPayload(bytes).kind === 'warmup') seen = true;
  });
  const start = performance.now();
  try {
    let attempt = 0;
    while (!seen) {
      if (performance.now() - start > timeoutMs)
        throw new Error('direct-signal warmup timed out — peer never reachable');
      await sendDirectSignal(from.appWs, dnaHash, [to.agentPubKey as unknown as Uint8Array], directPayload('warmup', attempt++, 0));
      await new Promise((r) => setTimeout(r, 500));
    }
  } finally {
    unsub();
  }
  return Math.round(performance.now() - start);
}

describe('Direct signals vs zome-call signals (two conductors)', () => {
  /**
   * Test 1: delivery sanity in both directions, wire-encoding settlement,
   * payload integrity, and the 1 MiB size limit.
   */
  it('delivers direct signals across conductors and settles the wire encoding', async () => {
    await runScenario(async (scenario: Scenario) => {
      const { alice, bob, dnaHash } = await setupTwoConductors(scenario);

      const warmupMs = await directWarmup(alice, bob, dnaHash);
      console.log(`  first delivery after ${warmupMs} ms; request encoding: ${settledEncoding}`);

      // Payload integrity + cell_id, A -> B
      const marker = new Uint8Array(256).map((_, i) => i % 251);
      const received: { cellId: [Uint8Array, Uint8Array]; bytes: Uint8Array }[] = [];
      const unsubB = onDirectSignal(bob.appWs, (cellId, bytes) => {
        if (decodeDirectPayload(bytes).kind === 'integrity') received.push({ cellId, bytes });
      });
      await sendDirectSignal(
        alice.appWs,
        dnaHash,
        [bob.agentPubKey as unknown as Uint8Array],
        encode({ kind: 'integrity', seq: 0, pad: marker }),
      );
      const deadline = performance.now() + 10_000;
      while (received.length === 0 && performance.now() < deadline)
        await new Promise((r) => setTimeout(r, 50));
      unsubB();
      expect(received.length).toBe(1);
      expect(Array.from(decodeDirectPayload(received[0].bytes).pad)).toEqual(Array.from(marker));
      expect(encodeHashToBase64(received[0].cellId[1] as any)).toBe(
        encodeHashToBase64(bob.agentPubKey),
      );

      // Reverse direction, B -> A
      let reverse = false;
      const unsubA = onDirectSignal(alice.appWs, (_c, bytes) => {
        if (decodeDirectPayload(bytes).kind === 'reverse') reverse = true;
      });
      await sendDirectSignal(bob.appWs, dnaHash, [alice.agentPubKey as unknown as Uint8Array], directPayload('reverse', 0, 0));
      const rDeadline = performance.now() + 10_000;
      while (!reverse && performance.now() < rDeadline)
        await new Promise((r) => setTimeout(r, 50));
      expect(reverse).toBe(true);
      unsubA();

      // Effective send-size ceiling. DIRECT_SIGNAL_MAX_SIZE is 1 MiB, but the
      // conductor signs the RAW payload through the lair keystore, whose IPC
      // frames are capped at 8 KiB (lair_keystore_api sodium_secretstream
      // MAX_FRAME) — a 1 MiB signal fails to SIGN, not to send. Probe what
      // actually passes rather than trusting the declared constant.
      const probes = [1024, 2048, 4096, 6144, 7168, 7900, 8000, 8192, 16384, 65536, DIRECT_SIGNAL_MAX_SIZE];
      let ceiling = 0;
      for (const size of probes) {
        try {
          await rawAppRequest(alice.appWs, {
            type: 'send_direct_signal',
            value: {
              dna_hash: dnaHash,
              agents: [bob.agentPubKey],
              signal:
                settledEncoding === 'intarray'
                  ? Array.from(new Uint8Array(size))
                  : new Uint8Array(size),
            },
          });
          ceiling = size;
        } catch (e: any) {
          console.log(`  ${size}B payload REJECTED at send: ${e.message.slice(0, 140)}`);
          break;
        }
      }
      console.log(`  effective send ceiling: >= ${ceiling} B payload (declared limit ${DIRECT_SIGNAL_MAX_SIZE} B)`);
      expect(ceiling).toBeGreaterThan(0);

      // One byte over the DECLARED limit must be rejected…
      const overLimit = new Uint8Array(DIRECT_SIGNAL_MAX_SIZE + 1);
      await expect(
        rawAppRequest(alice.appWs, {
          type: 'send_direct_signal',
          value: {
            dna_hash: dnaHash,
            agents: [bob.agentPubKey],
            signal: settledEncoding === 'intarray' ? Array.from(overLimit) : overLimit,
          },
        }),
      ).rejects.toThrow();
      // …and empty agents is an error.
      await expect(
        rawAppRequest(alice.appWs, {
          type: 'send_direct_signal',
          value: { dna_hash: dnaHash, agents: [], signal: directPayload('x', 0, 0) },
        }),
      ).rejects.toThrow();
    });
  }, 180_000);

  /**
   * Test 2: echo RTT by payload size, direct vs zome, same environment.
   * Bob echoes each probe back over the same path it arrived on.
   */
  it('measures direct vs zome echo RTT across payload sizes', async () => {
    await runScenario(async (scenario: Scenario) => {
      const SHARED_SIZES = [80, 500, 1000, 5000, 10000, 50000];
      const DIRECT_ONLY_SIZES = [200_000, 1_000_000];
      const ITERATIONS = 20;

      const { alice, bob, dnaHash } = await setupTwoConductors(scenario);
      await directWarmup(alice, bob, dnaHash);
      await directWarmup(bob, alice, dnaHash);

      // Bob: echo direct probes back directly.
      const unsubBobDirect = onDirectSignal(bob.appWs, (_c, bytes) => {
        const msg = decodeDirectPayload(bytes);
        if (msg.kind !== 'probe') return;
        void sendDirectSignal(
          bob.appWs,
          dnaHash,
          [alice.agentPubKey as unknown as Uint8Array],
          encode({ kind: 'echo', seq: msg.seq, pad: msg.pad }),
        ).catch((e) => console.error(`  direct echo failed: ${e.message}`));
      });

      // Bob: echo zome probes back via send_message (mirrors signal-latency.test.ts).
      bob.appWs.on('signal', (signal: any) => {
        if (signal.type !== 'app') return;
        const p = signal.value.payload as any;
        if (p?.type === 'Message' && p?.msg_type === 'LatencyTest') {
          void call(bob, 'send_message', {
            to_agents: [p.from_agent],
            msg_type: 'LatencyEcho',
            payload: p.payload,
          }).catch((e: any) => console.error(`  zome echo failed: ${e.message}`));
        }
      });

      // Alice: direct echo receiver.
      const directEchoes = new Map<number, number>();
      const unsubAliceDirect = onDirectSignal(alice.appWs, (_c, bytes) => {
        const msg = decodeDirectPayload(bytes);
        if (msg.kind === 'echo') directEchoes.set(msg.seq, performance.now());
      });

      const summary: string[] = [];
      let seq = 0;

      for (const size of [...SHARED_SIZES, ...DIRECT_ONLY_SIZES]) {
        const zomeToo = size <= 50000;

        // Direct path. Sizes above the effective send ceiling (see test 1 —
        // lair's 8 KiB IPC frame caps the payload the conductor can sign)
        // fail at the request; skip the size on the first such error.
        const directRtts: number[] = [];
        let sendRejected: string | null = null;
        for (let i = 0; i < ITERATIONS; i++) {
          const mySeq = seq++;
          const probe = directPayload('probe', mySeq, size);
          const sendTime = performance.now();
          try {
            await sendDirectSignal(alice.appWs, dnaHash, [bob.agentPubKey as unknown as Uint8Array], probe);
          } catch (e: any) {
            sendRejected = e.message;
            break;
          }
          const deadline = sendTime + 15_000;
          while (!directEchoes.has(mySeq) && performance.now() < deadline)
            await new Promise((r) => setTimeout(r, 2));
          if (directEchoes.has(mySeq))
            directRtts.push(Math.round((directEchoes.get(mySeq)! - sendTime) * 100) / 100);
          else console.log(`  direct echo lost: size=${size} i=${i}`);
          await new Promise((r) => setTimeout(r, 50));
        }
        if (sendRejected)
          console.log(`\n  DIRECT size=${size}B unsupported at send: ${sendRejected.slice(0, 140)}`);
        const d = printStats(`DIRECT echo RTT (payload=${size}B)`, directRtts);

        // Zome path
        if (zomeToo) {
          const zomeRtts: number[] = [];
          const payloadStr = 'x'.repeat(size);
          for (let i = 0; i < ITERATIONS; i++) {
            let echoTime = 0;
            const unsub = alice.appWs.on('signal', (signal: any) => {
              if (signal.type !== 'app') return;
              const p = signal.value.payload as any;
              if (p?.type === 'Message' && p?.msg_type === 'LatencyEcho') echoTime = performance.now();
            });
            const sendTime = performance.now();
            await call(alice, 'send_message', {
              to_agents: [bob.agentPubKey],
              msg_type: 'LatencyTest',
              payload: payloadStr,
            });
            const deadline = sendTime + 15_000;
            while (echoTime === 0 && performance.now() < deadline)
              await new Promise((r) => setTimeout(r, 2));
            unsub();
            if (echoTime > 0) zomeRtts.push(Math.round((echoTime - sendTime) * 100) / 100);
            else console.log(`  zome echo lost: size=${size} i=${i}`);
            await new Promise((r) => setTimeout(r, 50));
          }
          const z = printStats(`ZOME echo RTT (payload=${size}B)`, zomeRtts);
          summary.push(
            `  ${String(size).padStart(9)}B  direct ${String(d.median).padStart(8)}ms  zome ${String(z.median).padStart(8)}ms  (${z.median && d.median ? (z.median / d.median).toFixed(1) : '?'}x)`,
          );
        } else {
          summary.push(`  ${String(size).padStart(9)}B  direct ${String(d.median).padStart(8)}ms  zome        n/a`);
        }
      }

      unsubBobDirect();
      unsubAliceDirect();
      console.log('\n=== Median echo RTT summary (two conductors) ===');
      summary.forEach((l) => console.log(l));
    });
  }, 600_000);

  /**
   * Test 3: sustained one-way throughput & delivery rate, direct vs zome,
   * 500-byte payloads. 50/sec is the voice module's frame rate.
   */
  it('measures sustained throughput and delivery, direct vs zome', async () => {
    await runScenario(async (scenario: Scenario) => {
      const RATES = [10, 20, 50];
      const DURATION_SEC = 10;
      const PAYLOAD_SIZE = 500;

      const { alice, bob, dnaHash } = await setupTwoConductors(scenario);
      await directWarmup(alice, bob, dnaHash);

      const directReceived = new Map<number, number>();
      onDirectSignal(bob.appWs, (_c, bytes) => {
        const msg = decodeDirectPayload(bytes);
        if (msg.kind === 'tp') directReceived.set(msg.seq, performance.now());
      });

      const zomeReceived = new Map<number, number>();
      bob.appWs.on('signal', (signal: any) => {
        if (signal.type !== 'app') return;
        const p = signal.value.payload as any;
        if (p?.type === 'Message' && p?.msg_type === 'ThroughputTest') {
          try {
            zomeReceived.set(JSON.parse(p.payload).seq, performance.now());
          } catch {}
        }
      });

      for (const rate of RATES) {
        const intervalMs = 1000 / rate;
        const total = rate * DURATION_SEC;

        for (const path of ['direct', 'zome'] as const) {
          const bucket = path === 'direct' ? directReceived : zomeReceived;
          bucket.clear();
          const sendTimes = new Map<number, number>();
          let sendErrors = 0;

          for (let s = 0; s < total; s++) {
            const loopStart = performance.now();
            sendTimes.set(s, loopStart);
            try {
              if (path === 'direct') {
                await sendDirectSignal(
                  alice.appWs,
                  dnaHash,
                  [bob.agentPubKey as unknown as Uint8Array],
                  directPayload('tp', s, PAYLOAD_SIZE),
                );
              } else {
                await call(alice, 'send_message', {
                  to_agents: [bob.agentPubKey],
                  msg_type: 'ThroughputTest',
                  payload: JSON.stringify({ seq: s, data: 'x'.repeat(PAYLOAD_SIZE) }),
                });
              }
            } catch {
              sendErrors++;
            }
            const sleep = Math.max(0, intervalMs - (performance.now() - loopStart));
            if (sleep > 0 && s < total - 1) await new Promise((r) => setTimeout(r, sleep));
          }

          await new Promise((r) => setTimeout(r, 5000));

          console.log(`\n=== ${path.toUpperCase()} ${rate}/sec x ${DURATION_SEC}s ===`);
          console.log(`  sent: ${total}  errors: ${sendErrors}  received: ${bucket.size}  delivery: ${((bucket.size / total) * 100).toFixed(1)}%`);
          const latencies: number[] = [];
          for (const [s, recv] of bucket) {
            const st = sendTimes.get(s);
            if (st) latencies.push(Math.round((recv - st) * 100) / 100);
          }
          if (latencies.length)
            printStats(`One-way latency (${path}, ${rate}/sec)`, latencies);
        }
      }
    });
  }, 600_000);
});
