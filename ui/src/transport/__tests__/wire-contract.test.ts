import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  SIGNAL_MSG_TYPES,
  WIRE_CONTRACT,
  WIRE_CAPS,
  CAP_SDP_FSM,
  CAP_SDP_FSM_SCREEN,
  isSignalMsgType,
  emittableSignalTypes,
  wireContractSnapshot,
} from '../wire-contract';

/**
 * Phase 1.5 item 1 — the wire-contract tripwire.
 *
 * The declared wire surface (`wire-contract.ts`) is snapshot-tested against
 * the committed `fixtures/wire-contract.json`. Changing the wire without
 * updating the fixture fails `verify`; updating the fixture is the
 * deliberate ceremony that did not exist when `SdpFsm` shipped unnoticed
 * (MAINTAINABILITY_ASSESSMENT.md §3.8).
 *
 * The ceremony:
 *
 *     UPDATE_WIRE_FIXTURE=1 npx vitest run src/transport/__tests__/wire-contract.test.ts
 *
 * then review and commit the fixture diff *as part of the change that moved
 * the wire*, and — if the shape a release emits changed — append a compat
 * fixture at release time (see `compat-corpus.test.ts`).
 */

const FIXTURE_PATH = fileURLToPath(
  new URL('../../../../fixtures/wire-contract.json', import.meta.url),
);

describe('wire-contract snapshot', () => {
  it('matches the committed fixture (fixtures/wire-contract.json)', () => {
    const actual = wireContractSnapshot();

    if (process.env.UPDATE_WIRE_FIXTURE) {
      writeFileSync(FIXTURE_PATH, JSON.stringify(actual, null, 2) + '\n');
    }

    let committed: unknown;
    try {
      committed = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
    } catch (e) {
      throw new Error(
        `Could not read ${FIXTURE_PATH} — if this is the first run, generate it with ` +
          `UPDATE_WIRE_FIXTURE=1 (${e instanceof Error ? e.message : e})`,
      );
    }

    expect(
      actual,
      'The declared wire surface differs from fixtures/wire-contract.json. ' +
        'If the wire change is intentional, re-run with UPDATE_WIRE_FIXTURE=1 ' +
        'and commit the fixture diff with the change.',
    ).toEqual(committed);
  });
});

describe('isSignalMsgType', () => {
  it('accepts every declared type', () => {
    for (const t of SIGNAL_MSG_TYPES) expect(isSignalMsgType(t)).toBe(true);
  });

  it('rejects strings off the union', () => {
    for (const t of ['', 'Ping', 'pingui', 'SdpFsm2', 'unknown-future-type']) {
      expect(isSignalMsgType(t)).toBe(false);
    }
  });
});

describe('emittableSignalTypes — the emission rule', () => {
  const baseline = SIGNAL_MSG_TYPES.filter(
    t => WIRE_CONTRACT[t].emits && WIRE_CONTRACT[t].requiresCap === null,
  );

  it('no declaration interpreted as empty caps ⇒ exactly the baseline set', () => {
    expect(emittableSignalTypes(new Set())).toEqual(baseline);
  });

  it('the baseline set excludes exactly the capability-gated types', () => {
    const emitted = SIGNAL_MSG_TYPES.filter(t => WIRE_CONTRACT[t].emits);
    expect(emitted.filter(t => !baseline.includes(t))).toEqual([
      'SdpFsm',
      'SdpFsmScreen',
    ]);
  });

  it('declaring sdp-fsm adds exactly SdpFsm', () => {
    const withFsm = emittableSignalTypes(new Set([CAP_SDP_FSM]));
    expect(withFsm).toContain('SdpFsm');
    expect(withFsm.filter(t => t !== 'SdpFsm')).toEqual(baseline);
  });

  it('declaring sdp-fsm-screen adds exactly SdpFsmScreen', () => {
    const withScreen = emittableSignalTypes(new Set([CAP_SDP_FSM_SCREEN]));
    expect(withScreen).toContain('SdpFsmScreen');
    expect(withScreen.filter(t => t !== 'SdpFsmScreen')).toEqual(baseline);
  });

  it('unknown capability strings gate nothing on', () => {
    expect(emittableSignalTypes(new Set(['quantum-teleport']))).toEqual(
      baseline,
    );
  });

  it('this build declares every capability its own gated emissions require', () => {
    // If a WIRE_CONTRACT row required a cap that WIRE_CAPS does not declare,
    // two current builds would drop that type between themselves — the
    // silent-downgrade edge, one level up.
    const own = new Set<string>(WIRE_CAPS);
    const emitted = SIGNAL_MSG_TYPES.filter(t => WIRE_CONTRACT[t].emits);
    expect(emittableSignalTypes(own)).toEqual(emitted);
  });
});
