import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { SIMPLE_EVENT_TAXONOMY } from '../logging';

/**
 * Phase 5 item 1: the wire-contract pattern applied to the event stream.
 *
 * The diagnostic pipeline's primary consumer is an LLM reading gathered
 * JSON, and what that consumer needs is a *trustworthy* taxonomy: every
 * declared event type either provably has an emission site (`emitted`)
 * or provably has none (`historical`, retained for capture continuity).
 * Taxonomy drift — types that read as live but are dead, or dead types
 * silently resurrected — is the defect this test exists to catch.
 *
 * Enforcement is a source grep, same mechanism as
 * `no-ambient-clock.test.ts`: an emission site is a line containing both
 * `event:` and the quoted type name. That shape covers every real site —
 * direct literals (`event: 'Connected'`), ternaries
 * (`event: x ? 'ConnectionAborted' : 'IceNeverConnected'`), and the
 * action tables in `rtc-message-policy.ts` whose `event:` fields are
 * consumed via `action.event`. Indirection through a variable would dodge
 * the grep — `streams-store.ts`'s one former case (`errLabel`) was
 * inlined when this test landed; keep emission sites literal.
 *
 * Scope: all of `ui/src` except tests, `logging.ts` itself (declaration,
 * not emission), and `room/logs-graph.ts` (a demoted render-only
 * courtesy view — Phase 5 item 4).
 *
 * The inline snapshot pins the full table so adding, deleting, or
 * reclassifying a type is always a visible, reviewed diff.
 */

const SRC_ROOT = fileURLToPath(new URL('..', import.meta.url));

const EXCLUDED = [
  join(SRC_ROOT, 'logging.ts'),
  join(SRC_ROOT, 'room', 'logs-graph.ts'),
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name === '__tests__' || name === 'node_modules') continue;
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (
      name.endsWith('.ts') &&
      !name.endsWith('.test.ts') &&
      !EXCLUDED.includes(path)
    ) {
      out.push(path);
    }
  }
  return out;
}

const sources = sourceFiles(SRC_ROOT).map(path => ({
  path,
  lines: readFileSync(path, 'utf8').split('\n'),
}));

/**
 * An emission-shaped line: contains `event:` and the type name in
 * quotes. Both quote styles are matched — verify runs no formatter
 * (package.json has no prettier/eslint step), so single quotes are
 * convention only, and `event: "Pong"` must not dodge the historical
 * assertion (review F1). Event names are alphanumeric; no escaping.
 */
function lineHasEmission(line: string, eventType: string): boolean {
  return line.includes('event:') && new RegExp(`['"]${eventType}['"]`).test(line);
}

function emissionSites(eventType: string): string[] {
  const sites: string[] = [];
  for (const { path, lines } of sources) {
    lines.forEach((line, i) => {
      if (lineHasEmission(line, eventType)) {
        sites.push(`${path.slice(SRC_ROOT.length)}:${i + 1}`);
      }
    });
  }
  return sites;
}

describe('SimpleEvent taxonomy', () => {
  const entries = Object.entries(SIMPLE_EVENT_TAXONOMY);

  it.each(entries.filter(([, status]) => status === 'emitted'))(
    "'%s' is declared emitted and has an emission site",
    eventType => {
      expect(emissionSites(eventType)).not.toEqual([]);
    },
  );

  it.each(entries.filter(([, status]) => status === 'historical'))(
    "'%s' is declared historical and has no emission site",
    eventType => {
      expect(emissionSites(eventType)).toEqual([]);
    },
  );

  it('negative control: the grep can find a real emission site', () => {
    // The historical-status assertions pass vacuously if the
    // emission-shape heuristic stops matching anything (e.g. a reformat
    // splits `event:` from its literal repo-wide). This pins that the
    // heuristic still finds a known-real site, so "no emission site"
    // keeps meaning what it claims.
    expect(
      emissionSites('Connected').some(site =>
        site.startsWith('streams-store.ts:'),
      ),
    ).toBe(true);
  });

  it('negative control: both quote styles count as emission sites', () => {
    // Closes the quote-style dodge (review F1): a double-quoted
    // resurrection must be caught by the historical assertions, not
    // slip past a single-quote-only needle.
    expect(lineHasEmission("      event: 'Pong',", 'Pong')).toBe(true);
    expect(lineHasEmission('      event: "Pong",', 'Pong')).toBe(true);
    // And the ternary shape stays covered.
    expect(
      lineHasEmission(
        "      event: ok ? 'ConnectionAborted' : 'IceNeverConnected',",
        'IceNeverConnected',
      ),
    ).toBe(true);
    expect(lineHasEmission("      event: action.event,", 'Pong')).toBe(false);
  });

  it('the declared taxonomy is pinned', () => {
    expect(SIMPLE_EVENT_TAXONOMY).toMatchInlineSnapshot(`
      {
        "AudibilityOutageEnd": "emitted",
        "AudibilityOutageStart": "emitted",
        "CarrierSwitch": "emitted",
        "ChangeMyAudioInput": "emitted",
        "ChangeMyVideoInput": "emitted",
        "Connected": "emitted",
        "ConnectionAborted": "emitted",
        "FsmClose": "emitted",
        "FsmError": "emitted",
        "FsmEstablishmentTimeline": "emitted",
        "FsmTransition": "emitted",
        "IceEstablishment": "emitted",
        "IceNeverConnected": "emitted",
        "InitAccept": "emitted",
        "InitRequest": "emitted",
        "MyAudioOff": "emitted",
        "MyAudioOn": "emitted",
        "MyVideoOff": "emitted",
        "MyVideoOn": "emitted",
        "MyWebrtcDisable": "emitted",
        "MyWebrtcEnable": "emitted",
        "PeerAudioOffSignal": "emitted",
        "PeerAudioOnSignal": "emitted",
        "PeerChangeAudioInput": "emitted",
        "PeerChangeVideoInput": "emitted",
        "PeerLeave": "emitted",
        "PeerVideoOffSignal": "emitted",
        "PeerVideoOnSignal": "emitted",
        "Pong": "historical",
        "PresenceAdd": "emitted",
        "PresenceRemove": "emitted",
        "QualityBucketChange": "emitted",
        "ReconcileAudio": "emitted",
        "ReconcileStream": "emitted",
        "ReconcileVideo": "emitted",
        "RemoteTrack": "emitted",
        "SdpData": "emitted",
        "SenderParams": "emitted",
        "StaleCleanup": "emitted",
        "StreamReceived": "emitted",
        "Superseded": "emitted",
        "SupersededClose": "emitted",
        "SupersededConnect": "emitted",
        "SupersededError": "emitted",
        "TrackArrivedMuted": "emitted",
        "TrackUnmuteTimeout": "emitted",
        "TrackUnmuted": "emitted",
      }
    `);
  });
});
