/**
 * DNA integration tests for the room zome on Holochain 0.7.1.
 *
 * Exercises every coordinator extern reachable without a UI, across two
 * conductors: room info, the ALL_AGENTS anchor, attachment CRUD, descendent
 * rooms, the ping/pong remote-signal path, and the direct-signal path that
 * carries the UI's `Message` traffic since 0.17.0.
 *
 * Validation Invalid branches (e.g. "RoomInfo cannot be updated/deleted") are
 * NOT reachable through the coordinator API — no extern issues those actions —
 * so they are not tested here; see tests/README.md.
 */

import { assert, describe, expect, it } from 'vitest';
import { runScenario, dhtSync, PlayerApp } from '@holochain-open-dev/tryorama';
import {
  AppBundleSource,
  DirectSignal,
  Record as HolochainRecord,
  SignalType,
  encodeHashToBase64,
} from '@holochain/client';
import { EntryRecord } from '@holochain-open-dev/utils';
import { decode, encode } from '@msgpack/msgpack';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HAPP_PATH = path.resolve(__dirname, '../../../workdir/presence.happ');
const appBundleSource: AppBundleSource = { type: 'path', value: HAPP_PATH };
const appSource = { appBundleSource };
const ROLE_NAME = 'presence';
const ZOME_NAME = 'room';

function roomCell(player: PlayerApp) {
  const cell = player.cells.find((c) => c.name === ROLE_NAME);
  if (!cell) throw new Error(`No cell with role name ${ROLE_NAME}`);
  return cell;
}

const call = <T>(player: PlayerApp, fn_name: string, payload: unknown): Promise<T> =>
  roomCell(player).callZome({ zome_name: ZOME_NAME, fn_name, payload }) as Promise<T>;

/** Collect app-signal payloads (the zome's `emit_signal`) for a player. */
function collectSignals(player: PlayerApp): unknown[] {
  const signals: unknown[] = [];
  player.appWs.on('signal', (signal) => {
    if (signal.type === SignalType.App) signals.push(signal.value.payload);
  });
  return signals;
}

/** Collect direct signals (no zome involved) for a player. */
function collectDirectSignals(player: PlayerApp): DirectSignal[] {
  const signals: DirectSignal[] = [];
  player.appWs.on('signal', (signal) => {
    if (signal.type === SignalType.AppDirect) signals.push(signal.value);
  });
  return signals;
}

async function untilSignal<T>(
  signals: T[],
  predicate: (s: T) => boolean,
  timeoutMs = 20_000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const hit = signals.find(predicate);
    if (hit) return hit;
    if (Date.now() - start > timeoutMs)
      throw new Error(`Timed out after ${timeoutMs}ms waiting for signal`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * The direct-signal wire body the UI writes (`ui/src/direct-signal.ts`):
 * msgpack `{ msg_type, payload }`. Built here by hand, not imported, so this
 * suite pins the layout from the far side of the wire.
 */
type MessageBody = { msg_type: string; payload: string };
const encodeBody = (body: MessageBody): Uint8Array => encode(body);
const decodeBody = (bytes: Uint8Array): MessageBody => decode(bytes) as MessageBody;

/** Run `init` on both conductors: it commits the zome-call grant for
 *  `recv_remote_signal` AND the direct-signal grant. Holochain runs init
 *  lazily on the first zome call, so a fresh cell drops direct signals
 *  until something has been called on it. */
async function initBoth(alice: PlayerApp, bob: PlayerApp) {
  await call(alice, 'get_all_agents', { input: null, local: true });
  await call(bob, 'get_all_agents', { input: null, local: true });
}

describe('room DNA on holochain 0.7.1', () => {
  it('sets and reads room info across two conductors', async () => {
    await runScenario(async (scenario) => {
      const [alice, bob] = await scenario.addPlayersWithApps([appSource, appSource]);
      await scenario.shareAllAgents();

      const roomInfo = { name: 'Test Room', icon_src: null, meta_data: null };
      await call(alice, 'set_room_info', roomInfo);

      const aliceRead = await call<HolochainRecord | null>(alice, 'get_room_info', {
        input: null,
        local: true,
      });
      assert(aliceRead);
      assert.deepEqual(new EntryRecord<any>(aliceRead).entry, roomInfo);

      await dhtSync([alice, bob], roomCell(alice).cell_id[0]);

      const bobRead = await call<HolochainRecord | null>(bob, 'get_room_info', {
        input: null,
        local: true,
      });
      assert(bobRead);
      assert.deepEqual(new EntryRecord<any>(bobRead).entry, roomInfo);
    });
  });

  it('registers both agents on the ALL_AGENTS anchor', async () => {
    await runScenario(async (scenario) => {
      const [alice, bob] = await scenario.addPlayersWithApps([appSource, appSource]);
      await scenario.shareAllAgents();

      // First zome call runs init(), which registers the agent on the anchor.
      await call(alice, 'get_all_agents', { input: null, local: true });
      await call(bob, 'get_all_agents', { input: null, local: true });

      await dhtSync([alice, bob], roomCell(alice).cell_id[0]);

      // One entry per agent, carrying the anchor link's commit timestamp —
      // the room-wide "first joined" constant the UI sorts grid tiles on
      // (ui/src/room/tile-order-policy.ts).
      const agents = await call<Array<{ agent: Uint8Array; joined_at: number }>>(
        alice,
        'get_all_agents',
        { input: null, local: true }
      );
      const byAgent = new Map(agents.map((a) => [encodeHashToBase64(a.agent), a.joined_at]));
      expect(byAgent.size).toBe(agents.length);
      expect(byAgent.has(encodeHashToBase64(alice.agentPubKey))).toBe(true);
      expect(byAgent.has(encodeHashToBase64(bob.agentPubKey))).toBe(true);
      for (const joinedAt of byAgent.values()) {
        expect(typeof joinedAt).toBe('number');
        expect(joinedAt).toBeGreaterThan(0);
      }

      // A second anchor link for the same agent (a re-created cell whose
      // older link is still in the DHT) must not move them: one row per
      // agent, earliest link wins.
      const aliceB64 = encodeHashToBase64(alice.agentPubKey);
      const firstJoin = byAgent.get(aliceB64);
      await new Promise((r) => setTimeout(r, 5));
      await call(alice, 'add_agent_to_anchor', null);
      const again = await call<Array<{ agent: Uint8Array; joined_at: number }>>(
        alice,
        'get_all_agents',
        { input: null, local: true }
      );
      const aliceRows = again.filter((a) => encodeHashToBase64(a.agent) === aliceB64);
      expect(aliceRows).toHaveLength(1);
      expect(aliceRows[0].joined_at).toBe(firstJoin);
    });
  });

  it('creates, updates, and deletes attachments', async () => {
    await runScenario(async (scenario) => {
      const [alice, bob] = await scenario.addPlayersWithApps([appSource, appSource]);
      await scenario.shareAllAgents();

      const attachment = { wal: 'weave://example/one' };
      const created = await call<HolochainRecord>(alice, 'create_attachment', attachment);
      const createdHash = created.signed_action.hashed.hash;
      assert.deepEqual(new EntryRecord<any>(created).entry, attachment);

      await dhtSync([alice, bob], roomCell(alice).cell_id[0]);

      const bobAll = await call<HolochainRecord[]>(bob, 'get_all_attachments', {
        input: null,
        local: true,
      });
      expect(bobAll.length).toBe(1);
      assert.deepEqual(new EntryRecord<any>(bobAll[0]).entry, attachment);

      // Update from bob's side
      const updated = { wal: 'weave://example/two' };
      await call(bob, 'update_attachment', {
        input: {
          original_attachment_hash: createdHash,
          previous_attachment_hash: createdHash,
          updated_attachment: updated,
        },
        local: true,
      });

      await dhtSync([alice, bob], roomCell(alice).cell_id[0]);

      const latest = await call<HolochainRecord | null>(alice, 'get_latest_attachment', {
        input: createdHash,
        local: true,
      });
      assert(latest);
      assert.deepEqual(new EntryRecord<any>(latest).entry, updated);

      const revisions = await call<HolochainRecord[]>(
        alice,
        'get_all_revisions_for_attachment',
        { input: createdHash, local: true },
      );
      expect(revisions.length).toBe(2);

      // The original is still readable as-authored after the update.
      const original = await call<HolochainRecord | null>(alice, 'get_original_attachment', {
        input: createdHash,
        local: true,
      });
      assert(original);
      assert.deepEqual(new EntryRecord<any>(original).entry, attachment);

      // Delete
      await call(alice, 'delete_attachment', { input: createdHash, local: true });
      await dhtSync([alice, bob], roomCell(alice).cell_id[0]);

      const bobAllAfter = await call<HolochainRecord[]>(bob, 'get_all_attachments', {
        input: null,
        local: true,
      });
      expect(bobAllAfter.length).toBe(0);

      const deletes = await call<unknown[] | null>(
        bob,
        'get_all_deletes_for_attachment',
        { input: createdHash, local: true },
      );
      assert(deletes);
      expect(deletes.length).toBe(1);

      const oldestDelete = await call<unknown | null>(
        bob,
        'get_oldest_delete_for_attachment',
        { input: createdHash, local: true },
      );
      assert(oldestDelete);
    });
  });

  it('creates, lists, and deletes descendent rooms', async () => {
    await runScenario(async (scenario) => {
      const [alice, bob] = await scenario.addPlayersWithApps([appSource, appSource]);
      await scenario.shareAllAgents();

      const dnaHash = roomCell(alice).cell_id[0];
      const room = {
        network_seed_appendix: 'child-1',
        dna_hash: dnaHash,
        name: 'Child Room',
        icon_src: null,
        meta_data: null,
      };
      await call(alice, 'create_descendent_room', room);

      await dhtSync([alice, bob], roomCell(alice).cell_id[0]);

      const bobRooms = await call<[any, Uint8Array, Uint8Array][]>(
        bob,
        'get_all_descendent_rooms',
        { input: null, local: true },
      );
      expect(bobRooms.length).toBe(1);
      const [entry, author, linkHash] = bobRooms[0];
      expect(entry.name).toBe('Child Room');
      expect(encodeHashToBase64(author)).toBe(encodeHashToBase64(alice.agentPubKey));

      // Anyone may delete the anchor link (validation allows it) — bob deletes.
      await call(bob, 'delete_descendent_room', { input: linkHash, local: true });
      await dhtSync([alice, bob], roomCell(alice).cell_id[0]);

      const aliceRooms = await call<unknown[]>(alice, 'get_all_descendent_rooms', {
        input: null,
        local: true,
      });
      expect(aliceRooms.length).toBe(0);
    });
  });

  it('answers ping with pong inside the zome (the remote-signal path stays)', async () => {
    await runScenario(async (scenario) => {
      const [alice, bob] = await scenario.addPlayersWithApps([appSource, appSource]);
      await scenario.shareAllAgents();
      await initBoth(alice, bob);

      const aliceSignals = collectSignals(alice);

      // Ping: bob's zome auto-pongs; no UI and no direct signal involved.
      await call(alice, 'ping', [bob.agentPubKey]);
      const pong = await untilSignal(aliceSignals, (s: any) => s?.type === 'Pong');
      expect(encodeHashToBase64((pong as any).from_agent)).toBe(
        encodeHashToBase64(bob.agentPubKey),
      );
    });
  });

  it('delivers a direct signal A→B with the conductor-stamped from_agent', async () => {
    await runScenario(async (scenario) => {
      const [alice, bob] = await scenario.addPlayersWithApps([appSource, appSource]);
      await scenario.shareAllAgents();
      await initBoth(alice, bob);

      const bobDirect = collectDirectSignals(bob);
      const bobApp = collectSignals(bob);

      const body = { msg_type: 'test-msg', payload: JSON.stringify({ hello: 'world' }) };
      await alice.appWs.sendDirectSignal({
        dna_hash: roomCell(alice).cell_id[0],
        agents: [bob.agentPubKey],
        signal: encodeBody(body),
      });

      const got = await untilSignal(bobDirect, (s) => decodeBody(s.signal).msg_type === 'test-msg');
      expect(encodeHashToBase64(got.from_agent)).toBe(encodeHashToBase64(alice.agentPubKey));
      expect(encodeHashToBase64(got.cell_id[0])).toBe(encodeHashToBase64(roomCell(bob).cell_id[0]));
      expect(encodeHashToBase64(got.cell_id[1])).toBe(encodeHashToBase64(bob.agentPubKey));
      expect(decodeBody(got.signal)).toEqual(body);

      // Nothing ran in the zome on the way in: no app signal was emitted.
      expect(bobApp.filter((s: any) => s?.type === 'Message')).toEqual([]);
    });
  });

  it('delivers a direct-signal payload well past 8 KiB intact', async () => {
    await runScenario(async (scenario) => {
      const [alice, bob] = await scenario.addPlayersWithApps([appSource, appSource]);
      await scenario.shareAllAgents();
      await initBoth(alice, bob);

      const bobDirect = collectDirectSignals(bob);

      // 64 KiB of payload — eight times the brief's threshold, a plausible
      // voice batch or SDP with many candidates; the ceiling is 1 MiB.
      const payload = 'x'.repeat(64 * 1024);
      const bytes = encodeBody({ msg_type: 'big', payload });
      expect(bytes.byteLength).toBeGreaterThan(8 * 1024);

      await alice.appWs.sendDirectSignal({
        dna_hash: roomCell(alice).cell_id[0],
        agents: [bob.agentPubKey],
        signal: bytes,
      });

      const got = await untilSignal(bobDirect, (s) => decodeBody(s.signal).msg_type === 'big');
      expect(encodeHashToBase64(got.from_agent)).toBe(encodeHashToBase64(alice.agentPubKey));
      expect(decodeBody(got.signal).payload).toBe(payload);
    });
  });
});
