/**
 * DNA integration tests for the room zome on Holochain 0.7.
 *
 * Exercises every coordinator extern reachable without a UI, across two
 * conductors: room info, the ALL_AGENTS anchor, attachment CRUD, descendent
 * rooms, and the ping/pong + send_message remote-signal path.
 *
 * Validation Invalid branches (e.g. "RoomInfo cannot be updated/deleted") are
 * NOT reachable through the coordinator API — no extern issues those actions —
 * so they are not tested here; see tests/README.md.
 */

import { assert, describe, expect, it } from 'vitest';
import { runScenario, dhtSync, PlayerApp } from '@holochain-open-dev/tryorama';
import {
  AppBundleSource,
  Record as HolochainRecord,
  SignalType,
  encodeHashToBase64,
} from '@holochain/client';
import { EntryRecord } from '@holochain-open-dev/utils';
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

/** Collect app-signal payloads for a player. */
function collectSignals(player: PlayerApp): unknown[] {
  const signals: unknown[] = [];
  player.appWs.on('signal', (signal) => {
    if (signal.type === SignalType.App) signals.push(signal.value.payload);
  });
  return signals;
}

async function untilSignal(
  signals: unknown[],
  predicate: (s: any) => boolean,
  timeoutMs = 20_000,
): Promise<any> {
  const start = Date.now();
  for (;;) {
    const hit = signals.find(predicate);
    if (hit) return hit;
    if (Date.now() - start > timeoutMs)
      throw new Error(`Timed out after ${timeoutMs}ms waiting for signal`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('room DNA on holochain 0.7', () => {
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

      const agents = await call<Uint8Array[]>(alice, 'get_all_agents', {
        input: null,
        local: true,
      });
      const agentSet = new Set(agents.map((a) => encodeHashToBase64(a)));
      expect(agentSet.has(encodeHashToBase64(alice.agentPubKey))).toBe(true);
      expect(agentSet.has(encodeHashToBase64(bob.agentPubKey))).toBe(true);
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

  it('answers ping with pong and delivers send_message signals', async () => {
    await runScenario(async (scenario) => {
      const [alice, bob] = await scenario.addPlayersWithApps([appSource, appSource]);
      await scenario.shareAllAgents();

      // Trigger init() (cap grant for recv_remote_signal) on both conductors.
      await call(alice, 'get_all_agents', { input: null, local: true });
      await call(bob, 'get_all_agents', { input: null, local: true });

      const aliceSignals = collectSignals(alice);
      const bobSignals = collectSignals(bob);

      // Ping: bob's backend auto-pongs without any UI involvement.
      await call(alice, 'ping', [bob.agentPubKey]);
      const pong = await untilSignal(aliceSignals, (s) => s?.type === 'Pong');
      expect(encodeHashToBase64(pong.from_agent)).toBe(encodeHashToBase64(bob.agentPubKey));

      // Generic message: opaque to the backend, surfaced as a Message signal.
      await call(alice, 'send_message', {
        to_agents: [bob.agentPubKey],
        msg_type: 'test-msg',
        payload: JSON.stringify({ hello: 'world' }),
      });
      const msg = await untilSignal(
        bobSignals,
        (s) => s?.type === 'Message' && s?.msg_type === 'test-msg',
      );
      expect(msg.payload).toBe(JSON.stringify({ hello: 'world' }));
      expect(encodeHashToBase64(msg.from_agent)).toBe(encodeHashToBase64(alice.agentPubKey));
    });
  });
});
