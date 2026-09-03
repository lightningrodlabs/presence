import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Phase 2's invariant, pinned mechanically and widened by the 2026-08 retro
 * (§7.5 item 1): the pinned files read time only through a `Clock`
 * (`this.clock` / `systemClock` / the `PassivePresenceTracker`) — never
 * `Date.now()`, ambient `new Date()`, or a bare `setTimeout`/`setInterval`.
 *
 * Why a source-grep test and not prose: the invariant nearly regressed on
 * the first branch that raced it. The Phase 2b branch was cut one commit
 * before Phase 2 merged, and its two conflict hunks carried three
 * `Date.now()` calls back into the file — caught only because the
 * adversarial review ran the trial merge (working agreement 9). CLAUDE.md
 * already said what this test says; prose demonstrably does not hold the
 * line, a failing gate does (working agreement 5).
 *
 * Which files are pinned and why: `streams-store.ts` (Phase 2's original
 * subject), and the three files where the retro found unowned liveness
 * work regrowing outside the pin's sight — the two former copies of the
 * passive presence model (`presence-app.ts`, `lobby/room-online-agents.ts`,
 * both now on `passive-presence.ts`, itself pinned) and the stats panel
 * whose flow window silently disagreed with the media-flowing predicate.
 *
 * Deliberate reach of the patterns: the scan includes comments (code moving
 * into or out of a comment cannot fool it — write `clock.setTimeout` in
 * prose, not the call syntax), and it does NOT flag `window.setTimeout`/
 * `window.setInterval` — an explicitly window-qualified timer is a declared
 * paint-timer idiom in the view files, visible in review. `presence-app.ts`
 * alone is allowed *argument-taking* `new Date(ts)` (timestamp formatting
 * for display — not a clock read); no-arg `new Date()` stays banned there.
 * `room/elements/agent-connection-status-icon.ts` is allowed exactly ONE
 * `Date.now()`, and only as the second argument of `lastSeenBucket(...)`:
 * that fallback compares a REMOTE peer's wire timestamp against local wall
 * clock, which is the declared-correct timebase for cross-peer comparisons
 * (CLAUDE.md, Phase 2 facts) — the store clock would be wrong there. The
 * dedicated describe at the bottom holds that count to one, so the
 * relaxation cannot quietly widen into general ambient time reads.
 *
 * If this test failed for you: route the new call through the file's clock.
 */

const FULL_PATTERNS: Array<[name: string, re: RegExp]> = [
  // No /g flag: RegExp.test with /g is stateful across calls.
  ['Date.now()', /\bDate\.now\s*\(/],
  ['new Date()', /\bnew\s+Date\s*\(/],
  // A leading dot or word char means it's a method on something
  // (this.clock.setTimeout, window.setTimeout).
  ['bare setTimeout()', /(?<![.\w])setTimeout\s*\(/],
  ['bare setInterval()', /(?<![.\w])setInterval\s*\(/],
];

// presence-app formats stored expiry timestamps for display with
// `new Date(expiry).toLocaleString()` — deterministic construction, not an
// ambient time read. Only the no-arg form is a clock read.
const DISPLAY_FORMATTING_PATTERNS: Array<[name: string, re: RegExp]> = [
  ['Date.now()', /\bDate\.now\s*\(/],
  ['no-arg new Date()', /\bnew\s+Date\s*\(\s*\)/],
  ['bare setTimeout()', /(?<![.\w])setTimeout\s*\(/],
  ['bare setInterval()', /(?<![.\w])setInterval\s*\(/],
];

// agent-connection-status-icon's ONE sanctioned Date.now (see header) —
// everything else ambient stays banned in that file.
const WIRE_TIMEBASE_PATTERNS: Array<[name: string, re: RegExp]> = [
  ['new Date()', /\bnew\s+Date\s*\(/],
  ['bare setTimeout()', /(?<![.\w])setTimeout\s*\(/],
  ['bare setInterval()', /(?<![.\w])setInterval\s*\(/],
];

const PINNED_FILES: Array<{
  relPath: string;
  patterns: Array<[string, RegExp]>;
}> = [
  { relPath: '../streams-store.ts', patterns: FULL_PATTERNS },
  { relPath: '../passive-presence.ts', patterns: FULL_PATTERNS },
  { relPath: '../lobby/room-online-agents.ts', patterns: FULL_PATTERNS },
  {
    relPath: '../room/elements/peer-stats-panel.ts',
    patterns: FULL_PATTERNS,
  },
  { relPath: '../presence-app.ts', patterns: DISPLAY_FORMATTING_PATTERNS },
  {
    relPath: '../room/elements/agent-connection-status-icon.ts',
    patterns: WIRE_TIMEBASE_PATTERNS,
  },
  // The cross-pane ownership protocol: its ack window runs on the clock
  // seam. (AbortSignal.timeout is deliberately outside the patterns'
  // reach — see the module doc — but a bare timer creeping in is not.)
  { relPath: '../room-ownership.ts', patterns: FULL_PATTERNS },
  // Task 2 (capture lifecycle): both sources gained a `now: () => number`
  // binding specifically so `_setLifecycle`'s timestamps have no excuse
  // for ambient time.
  { relPath: '../mic-source.ts', patterns: FULL_PATTERNS },
  { relPath: '../camera-source.ts', patterns: FULL_PATTERNS },
  // Task 3 (capture reconciler): takes `clock` via bindings and stamps
  // every retry attempt through it — no ambient time.
  { relPath: '../capture-reconciler.ts', patterns: FULL_PATTERNS },
  // Store-decomposition round two, Task 1 (PeerAudioLevels): no timing at
  // all in this owner, but pinned per the round's pattern.
  { relPath: '../peer-audio-levels.ts', patterns: FULL_PATTERNS },
  // Store-decomposition round two, Task 2 (MediaSettings): takes `now` via
  // bindings; storage/mediaDevices reads stay live per-call, not snapshotted.
  { relPath: '../media-settings.ts', patterns: FULL_PATTERNS },
  // Store-decomposition round two, Task 3 (DiagnosticsHub): the retry
  // timer stamps `startedAt` and schedules its timeout through the
  // `now`/`setTimeout` bindings, both late-bound onto the clock.
  { relPath: '../diagnostics-hub.ts', patterns: FULL_PATTERNS },
  // Store-decomposition round two, Task 4 (TrackHealthMonitor): the
  // reconcile cooldown and every peer-record timestamp write route
  // through the `now` binding, late-bound onto the clock.
  { relPath: '../track-health.ts', patterns: FULL_PATTERNS },
];

for (const { relPath, patterns } of PINNED_FILES) {
  const fileName = relPath.replace('../', '');
  describe(`${fileName} reads time only through a Clock`, () => {
    const source = readFileSync(
      fileURLToPath(new URL(relPath, import.meta.url)),
      'utf8'
    );

    it.each(patterns)('contains no %s', (_name, re) => {
      const lines = source
        .split('\n')
        .flatMap((line, i) =>
          re.test(line) ? [`${i + 1}: ${line.trim()}`] : []
        );
      expect(lines).toEqual([]);
    });
  });
}

describe('agent-connection-status-icon: the wire-timebase relaxation stays exactly one call', () => {
  const source = readFileSync(
    fileURLToPath(
      new URL(
        '../room/elements/agent-connection-status-icon.ts',
        import.meta.url
      )
    ),
    'utf8'
  );

  it('contains exactly one Date.now(), as the lastSeenBucket wall-clock argument', () => {
    const occurrences = source.match(/\bDate\.now\s*\(/g) ?? [];
    expect(occurrences).toHaveLength(1);
    // The sanctioned shape: a remote wire timestamp bucketed against
    // local wall clock. Any other placement is a new ambient read.
    expect(source).toMatch(
      /lastSeenBucket\(this\.lastSeen,\s*Date\.now\(\)\)/
    );
  });
});
