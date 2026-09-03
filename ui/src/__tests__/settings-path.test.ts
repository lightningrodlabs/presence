import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Round 3 item 6 — the settings dead path, resolved as
 * delete-and-declare. The four store setters (setTurnUrl,
 * setTurnUsername, setTurnCredential, setSignalDelay) had zero callers —
 * the Settings panel writes localStorage directly, and public methods
 * are invisible to noUnusedLocals — so they were deleted and the actual
 * knob-timing semantics are declared where the panel renders them:
 * TURN edits apply to connections established after the change (live
 * closures); signal delay is a start()-time snapshot and takes effect
 * on the next room join.
 *
 * These pins mechanize both exit criteria: the dead setters stay
 * deleted (resurrecting one without a caller is a failing test, and
 * with a caller is a decision that edits this file), and the declared
 * semantics stay rendered.
 */

const src = (rel: string) =>
  readFileSync(join(__dirname, '..', rel), 'utf8');

const DEAD_SETTER_NAMES = [
  'setTurnUrl(',
  'setTurnUsername(',
  'setTurnCredential(',
  'setSignalDelay(',
];

describe('the dead settings setters stay deleted', () => {
  it('streams-store exposes no uncalled TURN/signal-delay setters', () => {
    const text = src('streams-store.ts');
    for (const name of DEAD_SETTER_NAMES) {
      expect(
        text.includes(name),
        `${name} was deleted as a zero-caller dead path (item 6); reintroduce it only WITH its caller and update this pin`,
      ).toBe(false);
    }
  });

  // The TURN/ICE settings concern moved off streams-store.ts into
  // MediaSettings (store-decomposition round two, owner-extraction,
  // 2026-09-03) — the store-only scan above is blind to a setter
  // resurrected there. Same four names, same absence assertion.
  it('media-settings exposes no uncalled TURN/signal-delay setters', () => {
    const text = src('media-settings.ts');
    for (const name of DEAD_SETTER_NAMES) {
      expect(
        text.includes(name),
        `${name} was deleted as a zero-caller dead path (item 6); reintroduce it only WITH its caller and update this pin`,
      ).toBe(false);
    }
  });
});

describe('the panel declares the knob-timing semantics', () => {
  it('TURN inputs state that edits apply to new connections', () => {
    expect(src('presence-app.ts')).toContain(
      'Applies to connections established after the change'
    );
  });

  it('signal delay states that it takes effect on the next room join', () => {
    expect(src('presence-app.ts')).toContain(
      'Takes effect on the next room join'
    );
  });
});
