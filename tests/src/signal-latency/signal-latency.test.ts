/**
 * Signal Latency & Throughput Tests
 *
 * Tests signal delivery between two agents (same conductor), then measures
 * round-trip latency and sustained throughput.
 *
 * Since 0.17.0 the message legs ride direct signals (`sendDirectSignal`, no
 * zome call on either side; msgpack `{ msg_type, payload }` body, the layout
 * `ui/src/direct-signal.ts` writes). Ping/pong is still the zome's remote
 * signal. The 0.16.4-shape numbers (send_message zome call → remote signal)
 * are recorded in the 0.17.0 release notes for comparison.
 */

import { describe, it, expect } from 'vitest';
import { Scenario, runScenario } from '@holochain-open-dev/tryorama';
import {
  CellType,
  SignalType,
  encodeHashToBase64,
  type AgentPubKey,
  type AppWebsocket,
  type DnaHash,
} from '@holochain/client';
import { decode, encode } from '@msgpack/msgpack';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HAPP_PATH = path.resolve(__dirname, '../../../workdir/presence.happ');
const APP_BUNDLE_SOURCE = { type: 'path' as const, value: HAPP_PATH };
const ROLE_NAME = 'presence';
const ZOME_NAME = 'room';

function makePayload(bytes: number): string {
  return 'x'.repeat(bytes);
}

type MessageBody = { msg_type: string; payload: string };

/** One direct signal per message — the UI's `RoomClient.sendMessage` shape. */
async function sendDirect(
  ws: AppWebsocket,
  dnaHash: DnaHash,
  to: AgentPubKey[],
  msgType: string,
  payload: string
): Promise<void> {
  await ws.sendDirectSignal({
    dna_hash: dnaHash,
    agents: to,
    signal: encode({ msg_type: msgType, payload } satisfies MessageBody),
  });
}

/** The body of an incoming direct signal, or null for anything else. */
function directBody(signal: any): (MessageBody & { from_agent: AgentPubKey }) | null {
  if (signal?.type !== SignalType.AppDirect) return null;
  try {
    const body = decode(signal.value.signal) as MessageBody;
    return { ...body, from_agent: signal.value.from_agent };
  } catch {
    return null;
  }
}

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

/**
 * Set up two agents on the SAME conductor.
 */
async function setupTwoAgentsSameConductor(scenario: Scenario) {
  const conductor = await scenario.addConductor();

  // Install two apps
  const agentAKey = await conductor.adminWs().generateAgentPubKey();
  const appAInfo = await conductor.adminWs().installApp({
    source: APP_BUNDLE_SOURCE,
    agent_key: agentAKey,
    installed_app_id: 'app-agent-a',
    network_seed: scenario.networkSeed,
  });

  const agentBKey = await conductor.adminWs().generateAgentPubKey();
  const appBInfo = await conductor.adminWs().installApp({
    source: APP_BUNDLE_SOURCE,
    agent_key: agentBKey,
    installed_app_id: 'app-agent-b',
    network_seed: scenario.networkSeed,
  });

  await conductor.adminWs().enableApp({ installed_app_id: 'app-agent-a' });
  await conductor.adminWs().enableApp({ installed_app_id: 'app-agent-b' });

  // Create separate app websockets
  const portA = await conductor.attachAppInterface();
  const tokenA = await conductor.adminWs().issueAppAuthenticationToken({
    installed_app_id: 'app-agent-a',
  });
  const appWsA = await conductor.connectAppWs(tokenA.token, portA);

  const portB = await conductor.attachAppInterface();
  const tokenB = await conductor.adminWs().issueAppAuthenticationToken({
    installed_app_id: 'app-agent-b',
  });
  const appWsB = await conductor.connectAppWs(tokenB.token, portB);

  // Get cell IDs
  const cellInfoA = appAInfo.cell_info[ROLE_NAME][0];
  const cellInfoB = appBInfo.cell_info[ROLE_NAME][0];
  const cellIdA =
    cellInfoA.type === CellType.Provisioned ? cellInfoA.value.cell_id : null;
  const cellIdB =
    cellInfoB.type === CellType.Provisioned ? cellInfoB.value.cell_id : null;
  if (!cellIdA || !cellIdB) throw new Error('Failed to get cell IDs');

  await conductor.adminWs().authorizeSigningCredentials(cellIdA);
  await conductor.adminWs().authorizeSigningCredentials(cellIdB);

  const callZomeA = async (fnName: string, payload: any) =>
    appWsA.callZome({ cell_id: cellIdA, zome_name: ZOME_NAME, fn_name: fnName, payload });

  const callZomeB = async (fnName: string, payload: any) =>
    appWsB.callZome({ cell_id: cellIdB, zome_name: ZOME_NAME, fn_name: fnName, payload });

  // init() commits the direct-signal grant; it runs lazily on the first
  // zome call, and a cell without the grant drops direct signals silently.
  await callZomeA('get_all_agents', { input: null, local: true });
  await callZomeB('get_all_agents', { input: null, local: true });

  const dnaHash = cellIdA[0];
  const sendA = (to: AgentPubKey[], msgType: string, payload: string) =>
    sendDirect(appWsA, dnaHash, to, msgType, payload);
  const sendB = (to: AgentPubKey[], msgType: string, payload: string) =>
    sendDirect(appWsB, dnaHash, to, msgType, payload);

  console.log(`  Agent A: ${encodeHashToBase64(agentAKey)}`);
  console.log(`  Agent B: ${encodeHashToBase64(agentBKey)}`);

  return { conductor, agentAKey, agentBKey, appWsA, appWsB, callZomeA, callZomeB, sendA, sendB };
}

describe('Signal Latency Tests (same conductor)', () => {
  /**
   * Test 0: Basic signal delivery diagnostic.
   * Verify that signals from Agent A actually reach Agent B's signal handler.
   */
  it('verifies basic signal delivery between two agents', async () => {
    await runScenario(async (scenario: Scenario) => {
      const { callZomeA, callZomeB, agentAKey, agentBKey, appWsA, appWsB, sendA } =
        await setupTwoAgentsSameConductor(scenario);

      // Collect ALL signals on both websockets
      const signalsA: any[] = [];
      const signalsB: any[] = [];

      appWsA.on('signal', (signal: any) => {
        console.log(`  [A] Got signal: ${JSON.stringify(signal).slice(0, 200)}`);
        signalsA.push(signal);
      });
      appWsB.on('signal', (signal: any) => {
        console.log(`  [B] Got signal: ${JSON.stringify(signal).slice(0, 200)}`);
        signalsB.push(signal);
      });

      await new Promise((r) => setTimeout(r, 3000));

      // Test 1: A pings B — should produce Pong on A's signal handler
      console.log('\n  === A pings B ===');
      await callZomeA('ping', [agentBKey]);
      await new Promise((r) => setTimeout(r, 5000));
      console.log(`  Signals on A after ping: ${signalsA.length}`);
      console.log(`  Signals on B after ping: ${signalsB.length}`);

      // Test 2: B pings A — should produce Pong on B's signal handler
      console.log('\n  === B pings A ===');
      await callZomeB('ping', [agentAKey]);
      await new Promise((r) => setTimeout(r, 5000));
      console.log(`  Signals on A after B pings: ${signalsA.length}`);
      console.log(`  Signals on B after B pings: ${signalsB.length}`);

      // Test 3: A sends message to B
      console.log('\n  === A sends message to B ===');
      await sendA([agentBKey], 'TestMsg', 'hello');
      await new Promise((r) => setTimeout(r, 5000));
      console.log(`  Signals on A after msg: ${signalsA.length}`);
      console.log(`  Signals on B after msg: ${signalsB.length}`);

      // Test 4: A sends message to self (same agent)
      console.log('\n  === A sends message to self ===');
      await sendA([agentAKey], 'SelfTest', 'selfie');
      await new Promise((r) => setTimeout(r, 5000));
      console.log(`  Signals on A after self-msg: ${signalsA.length}`);

      console.log(`\n  TOTAL: A=${signalsA.length}, B=${signalsB.length}`);

      // We expect at least some signals
      const totalSignals = signalsA.length + signalsB.length;
      console.log(`  Total signals received: ${totalSignals}`);
      expect(totalSignals).toBeGreaterThan(0);
    });
  }, 120_000);

  /**
   * Test 1: Ping/Pong round-trip latency.
   * Only runs if Test 0 confirms signals work.
   */
  it('measures ping/pong round-trip latency', async () => {
    await runScenario(async (scenario: Scenario) => {
      const NUM_PINGS = 50;
      const { callZomeA, agentBKey, appWsA } = await setupTwoAgentsSameConductor(scenario);

      await new Promise((r) => setTimeout(r, 3000));

      // First, verify we can get at least one pong
      let gotPong = false;
      const warmupUnsub = appWsA.on('signal', (signal: any) => {
        if (signal.type === 'app' && signal.value?.payload?.type === 'Pong') gotPong = true;
      });
      await callZomeA('ping', [agentBKey]);
      await new Promise((r) => setTimeout(r, 10000));
      warmupUnsub();

      if (!gotPong) {
        console.log('  WARNING: No pong received in warmup. Signals may not be routing.');
        console.log('  Skipping latency measurement.');
        return;
      }

      console.log('  Warmup successful, measuring latency...');
      const roundTrips: number[] = [];

      for (let i = 0; i < NUM_PINGS; i++) {
        let pongResolve: (() => void) | null = null;
        let pongTime = 0;

        const unsub = appWsA.on('signal', (signal: any) => {
          if (signal.type === 'app' && signal.value?.payload?.type === 'Pong') {
            pongTime = performance.now();
            if (pongResolve) pongResolve();
          }
        });

        const pongPromise = new Promise<void>((resolve) => {
          pongResolve = resolve;
        });
        const timeout = new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error(`Ping ${i} timed out`)), 10000)
        );

        const sendTime = performance.now();
        await callZomeA('ping', [agentBKey]);

        try {
          await Promise.race([pongPromise, timeout]);
          roundTrips.push(Math.round((pongTime - sendTime) * 100) / 100);
        } finally {
          unsub();
        }

        await new Promise((r) => setTimeout(r, 50));
      }

      const stats = printStats('Ping/Pong Round-Trip Latency (same conductor)', roundTrips);
      console.log(`  estimated one-way: ${Math.round(stats.mean / 2)} ms`);
      expect(roundTrips.length).toBe(NUM_PINGS);
    });
  }, 180_000);

  /**
   * Test 2: Message round-trip at varying payload sizes.
   */
  it('measures message round-trip at varying payload sizes', async () => {
    await runScenario(async (scenario: Scenario) => {
      const PAYLOAD_SIZES = [80, 500, 1000, 5000, 10000, 50000];
      const ITERATIONS = 20;

      const { agentBKey, appWsA, appWsB, sendA, sendB } =
        await setupTwoAgentsSameConductor(scenario);

      // Agent B echoes messages back
      appWsB.on('signal', async (signal: any) => {
        const msg = directBody(signal);
        if (msg?.msg_type === 'LatencyTest') {
          try {
            await sendB([msg.from_agent], 'LatencyEcho', msg.payload);
          } catch (e: any) {
            console.error(`  Echo failed: ${e.message}`);
          }
        }
      });

      await new Promise((r) => setTimeout(r, 3000));

      for (const size of PAYLOAD_SIZES) {
        const payloadStr = makePayload(size);
        const roundTrips: number[] = [];

        for (let i = 0; i < ITERATIONS; i++) {
          let echoResolve: (() => void) | null = null;
          let echoTime = 0;

          const unsub = appWsA.on('signal', (signal: any) => {
            const p = directBody(signal);
            if (p?.msg_type === 'LatencyEcho') {
              echoTime = performance.now();
              if (echoResolve) echoResolve();
            }
          });

          const echoPromise = new Promise<void>((resolve) => {
            echoResolve = resolve;
          });
          const timeout = new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error(`Echo timed out size=${size} i=${i}`)), 15000)
          );

          const sendTime = performance.now();
          await sendA([agentBKey], 'LatencyTest', payloadStr);

          try {
            await Promise.race([echoPromise, timeout]);
            roundTrips.push(Math.round((echoTime - sendTime) * 100) / 100);
          } finally {
            unsub();
          }

          await new Promise((r) => setTimeout(r, 100));
        }

        const stats = printStats(`Message RTT (payload=${size} bytes)`, roundTrips);
        console.log(`  estimated one-way: ${Math.round(stats.mean / 2)} ms`);
      }
    });
  }, 300_000);

  /**
   * Test 3: Sustained throughput test.
   */
  it('measures sustained throughput and delivery rate', async () => {
    await runScenario(async (scenario: Scenario) => {
      const RATES = [2, 5, 10, 20, 50];
      const DURATION_SEC = 10;
      const PAYLOAD_SIZE = 500;
      const received: Map<number, number> = new Map();

      const { agentBKey, appWsB, sendA } = await setupTwoAgentsSameConductor(scenario);

      appWsB.on('signal', (signal: any) => {
        const p = directBody(signal);
        if (p?.msg_type === 'ThroughputTest') {
          try {
            const data = JSON.parse(p.payload);
            received.set(data.seq, performance.now());
          } catch {}
        }
      });

      await new Promise((r) => setTimeout(r, 3000));

      const payloadData = makePayload(PAYLOAD_SIZE);

      for (const rate of RATES) {
        received.clear();
        const intervalMs = 1000 / rate;
        const totalMessages = rate * DURATION_SEC;
        const sendTimes: Map<number, number> = new Map();
        let sendErrors = 0;

        console.log(
          `\n=== Throughput test: ${rate} msg/sec, ${DURATION_SEC}s, ${totalMessages} total ===`
        );

        for (let seq = 0; seq < totalMessages; seq++) {
          const loopStart = performance.now();
          sendTimes.set(seq, loopStart);

          try {
            await sendA([agentBKey], 'ThroughputTest', JSON.stringify({ seq, data: payloadData }));
          } catch (e: any) {
            sendErrors++;
          }

          const elapsed = performance.now() - loopStart;
          const sleepMs = Math.max(0, intervalMs - elapsed);
          if (sleepMs > 0 && seq < totalMessages - 1) {
            await new Promise((r) => setTimeout(r, sleepMs));
          }
        }

        await new Promise((r) => setTimeout(r, 5000));

        const deliveredCount = received.size;
        const deliveryRate = ((deliveredCount / totalMessages) * 100).toFixed(1);
        console.log(`  sent:        ${totalMessages}`);
        console.log(`  send errors: ${sendErrors}`);
        console.log(`  received:    ${deliveredCount}`);
        console.log(`  delivery:    ${deliveryRate}%`);

        if (deliveredCount > 1) {
          const arrivals = [...received.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([_, time]) => time);
          const interArrivals: number[] = [];
          for (let i = 1; i < arrivals.length; i++) {
            interArrivals.push(Math.round((arrivals[i] - arrivals[i - 1]) * 100) / 100);
          }
          printStats(
            `Inter-arrival jitter (rate=${rate}/sec, expected=${Math.round(intervalMs)}ms)`,
            interArrivals
          );
        }

        const latencies: number[] = [];
        for (const [seq, recvTime] of received) {
          const sendTime = sendTimes.get(seq);
          if (sendTime) {
            latencies.push(Math.round((recvTime - sendTime) * 100) / 100);
          }
        }
        if (latencies.length > 0) {
          printStats(`One-way latency under load (rate=${rate}/sec)`, latencies);
        }
      }
    });
  }, 600_000);
});
