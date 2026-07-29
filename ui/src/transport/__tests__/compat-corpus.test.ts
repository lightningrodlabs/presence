import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAP_SDP_FSM,
  CAP_SDP_FSM_SCREEN,
  SIGNAL_MSG_TYPES,
  WIRE_CONTRACT,
  emittableSignalTypes,
  type SignalMsgType,
} from '../wire-contract';
import {
  DEFAULT_CONVERSATION_PAYLOAD,
  conversationPayloadCaps,
} from '../../room/modules/conversation';
import type { ModuleStateEnvelope } from '../../room/modules/types';

/**
 * Phase 1.5 item 2 — the compatibility corpus.
 *
 * One fixture per released wire shape (`fixtures/compat/<version>.json`),
 * each derived from that release's source, and one table test asserting the
 * interop invariant:
 *
 * > For every corpus entry N, the signal types the current build would send
 * > to a peer emitting N's default conversation payload ⊆ the types N
 * > parses.
 *
 * Against the 0.14.7 entry this pins the capability gate (no `SdpFsm` to a
 * build with no handler for it — `StreamsStore.webrtcAvailableFor`).
 * Against the newest entry it pins same-version links to WebRTC via
 * DECLARED caps, closing the silent-downgrade edge the gate introduced: an
 * absent or unrecognized peer payload quietly demoting a current-version
 * link to signals-only with nothing detecting it.
 *
 * No old build is ever compiled; fixtures derive from released source, not
 * from a running old client — deliberate, per the 2026-07-28 decision that
 * backward interop with ≤ v0.14.7 is a non-goal and *forward* interop is
 * the thing being bought.
 *
 * Release ceremony (self-maintaining corpus): after bumping
 * `ui/package.json` version, run
 *
 *     UPDATE_COMPAT_FIXTURE=1 npx vitest run src/transport/__tests__/compat-corpus.test.ts
 *
 * which appends `fixtures/compat/<new version>.json` from the declared
 * surface. It refuses to overwrite an existing entry — released fixtures
 * are immutable; bump the version first.
 */

type CompatEntry = {
  version: string;
  source: string;
  parses: string[];
  emits: string[];
  defaultConversationPayload: Record<string, unknown>;
};

const CORPUS_DIR = fileURLToPath(
  new URL('../../../../fixtures/compat/', import.meta.url),
);

const UI_PACKAGE_JSON = fileURLToPath(
  new URL('../../../package.json', import.meta.url),
);

function loadCorpus(): CompatEntry[] {
  return readdirSync(CORPUS_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(f => JSON.parse(readFileSync(join(CORPUS_DIR, f), 'utf8')));
}

function envelopeFor(payload: Record<string, unknown>): ModuleStateEnvelope {
  return {
    moduleId: 'conversation',
    active: true,
    payload: JSON.stringify(payload),
    updatedAt: 0,
  };
}

/**
 * The signal types the current build would send to a peer whose
 * conversation payload is `payload` — the emission rule, whose gated
 * types are enforced at runtime by the same capability read: `SdpFsm`
 * through `StreamsStore.webrtcAvailableFor` (the video init/accept
 * gates), `SdpFsmScreen` through `_ensureOutgoingScreenShare`. The
 * impl-preference resolution (`resolveWebrtcImpl`) died with SimplePeer
 * in Phase 3; capability is the whole decision now.
 */
function currentBuildSendsTo(payload: Record<string, unknown>): {
  sent: SignalMsgType[];
  webrtcAvailable: boolean;
} {
  const envelope = envelopeFor(payload);
  const caps = conversationPayloadCaps(envelope);
  const sent = emittableSignalTypes(caps);
  return { sent, webrtcAvailable: caps.has(CAP_SDP_FSM) };
}

const CORPUS = loadCorpus();

describe('compat corpus — interop invariant', () => {
  it('has at least the two released entries', () => {
    const versions = CORPUS.map(e => e.version);
    expect(versions).toContain('0.14.7');
    expect(versions).toContain('0.14.8');
  });

  for (const entry of CORPUS) {
    it(`sends nothing that ${entry.version} cannot parse`, () => {
      const { sent } = currentBuildSendsTo(entry.defaultConversationPayload);
      const unparseable = sent.filter(t => !entry.parses.includes(t));
      expect(
        unparseable,
        `current build would emit [${unparseable.join(', ')}] to a ` +
          `${entry.version} peer, which has no handler for them`,
      ).toEqual([]);
    });

    it(`parses everything ${entry.version} emits that is still on the wire`, () => {
      // Forward direction: a released peer's emissions must not hit our
      // unknown-msg_type drop — except the explicitly retired types below,
      // each a deliberate wire change decided through the fixture ceremony.
      //
      // SdpData: Phase 3 deleted SimplePeer, whose SDP exchange it carried.
      // A released peer's SdpData now gets an explicit drop-with-log in
      // `_processSignal`; that link's media forms over SdpFsm or not at all.
      const RETIRED_TYPES = ['SdpData'];
      const unparsed = entry.emits.filter(
        t =>
          !RETIRED_TYPES.includes(t) &&
          (!(SIGNAL_MSG_TYPES as readonly string[]).includes(t) ||
            !WIRE_CONTRACT[t as SignalMsgType].parses),
      );
      expect(unparsed).toEqual([]);
    });
  }
});

describe('compat corpus — pinned resolutions', () => {
  const byVersion = Object.fromEntries(CORPUS.map(e => [e.version, e]));

  it('a 0.14.7 peer gets no WebRTC — never receives SdpFsm', () => {
    const { sent, webrtcAvailable } = currentBuildSendsTo(
      byVersion['0.14.7'].defaultConversationPayload,
    );
    expect(webrtcAvailable).toBe(false);
    expect(sent).not.toContain('SdpFsm');
  });

  it('a 0.14.8 peer (pre-caps, field-probe fallback) still gets SdpFsm', () => {
    const { sent, webrtcAvailable } = currentBuildSendsTo(
      byVersion['0.14.8'].defaultConversationPayload,
    );
    expect(webrtcAvailable).toBe(true);
    expect(sent).toContain('SdpFsm');
  });

  it('two current builds get WebRTC via DECLARED caps — the silent-downgrade pin', () => {
    // The current default payload must carry an explicit caps declaration;
    // if this ever regresses to relying on the field probe, a future
    // payload reshape could silently demote every same-version link to
    // signals-only with nothing detecting it.
    expect(Array.isArray(DEFAULT_CONVERSATION_PAYLOAD.caps)).toBe(true);
    expect(DEFAULT_CONVERSATION_PAYLOAD.caps).toContain(CAP_SDP_FSM);

    const { sent, webrtcAvailable } = currentBuildSendsTo(
      DEFAULT_CONVERSATION_PAYLOAD as unknown as Record<string, unknown>,
    );
    expect(webrtcAvailable).toBe(true);
    expect(sent).toContain('SdpFsm');

    // And everything we emit, we parse — same-version self-consistency.
    for (const t of sent) expect(WIRE_CONTRACT[t].parses).toBe(true);
  });

  it('SdpFsmScreen flows only on a declared sdp-fsm-screen cap — released peers never receive it', () => {
    // The screen-share port (Phase 3 item 2) replaced the SimplePeer/
    // SdpData screen channel with SdpFsmScreen. No released build parses
    // it: 0.14.7 resolves baseline-only, 0.14.8's field-probe fallback
    // yields only sdp-fsm. The production gate is
    // `StreamsStore._ensureOutgoingScreenShare`'s capability check, fed
    // from the same `conversationPayloadCaps` read as this model.
    for (const version of ['0.14.7', '0.14.8']) {
      const { sent } = currentBuildSendsTo(
        byVersion[version].defaultConversationPayload,
      );
      expect(sent, `${version} must not receive SdpFsmScreen`).not.toContain(
        'SdpFsmScreen',
      );
    }
    // Same-version links declare the cap and do receive it.
    expect(DEFAULT_CONVERSATION_PAYLOAD.caps).toContain(CAP_SDP_FSM_SCREEN);
    const { sent } = currentBuildSendsTo(
      DEFAULT_CONVERSATION_PAYLOAD as unknown as Record<string, unknown>,
    );
    expect(sent).toContain('SdpFsmScreen');
  });

  it('an empty caps declaration outranks the field probe (declaration wins)', () => {
    // caps: [] is an explicit "baseline only" even though webrtcImpl is
    // present and the legacy probe would have said fsm-capable.
    const { sent, webrtcAvailable } = currentBuildSendsTo({
      ...byVersion['0.14.8'].defaultConversationPayload,
      caps: [],
    });
    expect(webrtcAvailable).toBe(false);
    expect(sent).not.toContain('SdpFsm');
  });
});

describe('compat corpus — release dump ceremony', () => {
  it('UPDATE_COMPAT_FIXTURE=1 appends the current version fixture (no-op otherwise)', () => {
    if (!process.env.UPDATE_COMPAT_FIXTURE) return;

    const version: string = JSON.parse(
      readFileSync(UI_PACKAGE_JSON, 'utf8'),
    ).version;
    const target = join(CORPUS_DIR, `${version}.json`);
    if (existsSync(target)) {
      throw new Error(
        `fixtures/compat/${version}.json already exists. Released fixtures ` +
          'are immutable — bump ui/package.json version before dumping.',
      );
    }
    let rev = 'unknown rev';
    try {
      rev = execSync('git rev-parse --short HEAD', { cwd: CORPUS_DIR })
        .toString()
        .trim();
    } catch {
      // Provenance degrades gracefully outside a git checkout.
    }
    const entry: CompatEntry = {
      version,
      source: `dumped from source by compat-corpus.test.ts at release ${version} (${rev})`,
      parses: SIGNAL_MSG_TYPES.filter(t => WIRE_CONTRACT[t].parses),
      emits: SIGNAL_MSG_TYPES.filter(t => WIRE_CONTRACT[t].emits),
      defaultConversationPayload: JSON.parse(
        JSON.stringify(DEFAULT_CONVERSATION_PAYLOAD),
      ),
    };
    writeFileSync(target, JSON.stringify(entry, null, 2) + '\n');
  });
});
