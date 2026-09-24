// @vitest-environment jsdom
/**
 * Task 6 — the intent-diff UX surfaces (buttons, tile copy, carrier
 * banner). room-view has no full jsdom mount harness (see
 * view-teardown-symmetry.test.ts's standing rationale), so these pins
 * drive the render-authority methods the template consumes directly on a
 * constructed element with a fake store — the same style as the
 * screen-share-maximize-key and idToLayout pins.
 *
 * The pure decisions (`describeIntentDiffs`, `describeLinkEstablishment`)
 * are table-tested in intent-diff-policy.test.ts; here we pin that
 * room-view derives the button on/off from `localIntent`, badges from the
 * store's `intentDiffs`, the tile copy from the policy authority, and the
 * banner from the carrier diff — and that the copy strings live in exactly
 * one source file.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// logs-graph pulls plotly.js, which does not survive jsdom import; see
// view-teardown-symmetry.test.ts for the standing rationale.
vi.mock('../room/logs-graph', () => ({}));

import { render } from 'lit';
import '../room/room-view';
import type { IntentDiff } from '../intent-diff-policy';
import type { SystemAudioRequestDecision } from '../mic-output-policy';

type FakeStore = {
  clock: { now: () => number };
  peerReconnecting: (p: string) => boolean;
  disconnect: ReturnType<typeof vi.fn>;
  systemAudioRequest: SystemAudioRequestDecision;
  systemAudioOn: () => Promise<void>;
  systemAudioOff: () => void;
};

function makeRoomView(overrides?: {
  intent?: unknown;
  diffs?: IntentDiff[];
  now?: number;
  reconnecting?: (p: string) => boolean;
  systemAudioRequest?: SystemAudioRequestDecision;
  systemAudio?: { label: string; canExcludeSelf: boolean } | null;
}): any {
  const el = document.createElement('room-view') as any;
  const store: FakeStore = {
    clock: { now: () => overrides?.now ?? 0 },
    peerReconnecting: overrides?.reconnecting ?? (() => false),
    disconnect: vi.fn(),
    systemAudioRequest: overrides?.systemAudioRequest ?? { ok: true },
    systemAudioOn: vi.fn(async () => {}),
    systemAudioOff: vi.fn(),
  };
  el.streamsStore = store;
  // The StoreSubscriber fields read only `.value`; overwrite them with
  // plain value holders (never mounted, so they never subscribed).
  el._localIntent = { value: overrides?.intent };
  el._intentDiffs = { value: overrides?.diffs ?? [] };
  el._systemAudio = { value: overrides?.systemAudio ?? null };
  return el;
}

const INTENT = (
  mic: { wanted: boolean; muted: boolean; includeSystemAudio: boolean },
  cameraWanted: boolean
) => ({
  mic,
  camera: { wanted: cameraWanted },
  screenShare: { wanted: false },
  webrtc: { enabled: true, disabledWith: new Set() },
});

describe('toggle buttons render intent (surface 1)', () => {
  it('mic on = wanted && !muted; camera on = wanted', () => {
    const on = makeRoomView({
      intent: INTENT({ wanted: true, muted: false, includeSystemAudio: false }, true),
    });
    expect(on._micOn).toBe(true);
    expect(on._cameraOn).toBe(true);

    const muted = makeRoomView({
      intent: INTENT({ wanted: true, muted: true, includeSystemAudio: false }, false),
    });
    expect(muted._micOn).toBe(false);
    expect(muted._cameraOn).toBe(false);
  });

  it('an undefined intent (pre-subscription) reads as off, never throws', () => {
    const el = makeRoomView({ intent: undefined });
    expect(el._micOn).toBe(false);
    expect(el._cameraOn).toBe(false);
  });
});

describe('toggle-button badge tracks the matching diff (surface 1)', () => {
  const micPending: IntentDiff = {
    scope: 'mic',
    severity: 'pending',
    since: 0,
    reason: 'mic-failed',
    copy: 'Microphone unavailable — retrying…',
  };
  const micFailed: IntentDiff = {
    scope: 'mic',
    severity: 'failed',
    since: 0,
    reason: 'mic-attempts-exhausted',
    copy: 'Microphone unavailable',
  };

  it('a pending mic diff → pulsing badge class and title = the diff copy', () => {
    const el = makeRoomView({ diffs: [micPending] });
    expect(el._badgeClassFor('mic')).toBe('intent-badge intent-badge-pending');
    expect(el._intentDiff('mic')?.copy).toBe('Microphone unavailable — retrying…');
  });

  it('a failed mic diff → static red badge class', () => {
    const el = makeRoomView({ diffs: [micFailed] });
    expect(el._badgeClassFor('mic')).toBe('intent-badge intent-badge-failed');
  });

  it('no diff → no badge class and an empty title', () => {
    const el = makeRoomView({ diffs: [] });
    expect(el._badgeClassFor('mic')).toBe('');
    expect(el._badgeClassFor('camera')).toBe('');
    expect(el._intentDiff('mic')).toBeUndefined();
  });

  it('a mic diff does not badge the camera button', () => {
    const el = makeRoomView({ diffs: [micPending] });
    expect(el._badgeClassFor('camera')).toBe('');
  });
});

describe('the "Include audio from…" row renders the store\'s one request gate', () => {
  // Rendered into a detached container: the row is a template method, and
  // its disabled/title states come from `streamsStore.systemAudioRequest`
  // (`decideSystemAudioRequest`), the same decision `systemAudioOn` refuses
  // on — so this is what fails if the row stops reading it.
  function renderRow(overrides: Parameters<typeof makeRoomView>[0]) {
    const el = makeRoomView(overrides);
    const host = document.createElement('div');
    render(el._renderSystemAudioRow(), host);
    const row = host.querySelector('.audio-source') as HTMLElement;
    return { el, row };
  }

  it('mic not wanted → disabled, "Turn your microphone on first"', () => {
    const { row } = renderRow({ systemAudioRequest: { ok: false, reason: 'mic-not-wanted' } });
    expect(row.classList.contains('disabled')).toBe(true);
    expect(row.title).toBe('Turn your microphone on first');
    expect(row.textContent).toContain('Include audio from…');
  });

  it('mic wanted but not live → disabled, "Waiting for your microphone"', () => {
    const { row } = renderRow({ systemAudioRequest: { ok: false, reason: 'mic-not-live' } });
    expect(row.classList.contains('disabled')).toBe(true);
    expect(row.title).toBe('Waiting for your microphone');
  });

  it('the picker is up → disabled with no title (the store refuses a second request too)', () => {
    const { row } = renderRow({ systemAudioRequest: { ok: false, reason: 'request-pending' } });
    expect(row.classList.contains('disabled')).toBe(true);
    expect(row.title).toBe('');
  });

  it('request ok → enabled, no title; a click is the on gesture', async () => {
    const { el, row } = renderRow({ systemAudioRequest: { ok: true } });
    expect(row.classList.contains('disabled')).toBe(false);
    expect(row.title).toBe('');
    row.click();
    await Promise.resolve();
    expect(el.streamsStore.systemAudioOn).toHaveBeenCalledTimes(1);
    expect(el.streamsStore.systemAudioOff).not.toHaveBeenCalled();
  });

  it('a disabled row swallows the click', async () => {
    const { el, row } = renderRow({ systemAudioRequest: { ok: false, reason: 'mic-not-live' } });
    row.click();
    await Promise.resolve();
    expect(el.streamsStore.systemAudioOn).not.toHaveBeenCalled();
  });

  it('active → enabled whatever the gate says (the store reports already-active), label carries the source and the echo note; a click is the off gesture', async () => {
    const { el, row } = renderRow({
      systemAudioRequest: { ok: false, reason: 'already-active' },
      systemAudio: { label: 'Firefox', canExcludeSelf: false },
    });
    expect(row.classList.contains('disabled')).toBe(false);
    expect(row.title).toBe('');
    expect(row.textContent).toContain('Including: Firefox');
    expect(row.textContent).toContain('(may echo)');
    row.click();
    await Promise.resolve();
    expect(el.streamsStore.systemAudioOff).toHaveBeenCalledTimes(1);
  });
});

describe('carrier banner (surface 3)', () => {
  const carrierDiff: IntentDiff = {
    scope: 'carrier',
    severity: 'pending',
    since: 1000,
    reason: 'carrier-down',
    copy: 'Your connection dropped — reconnecting…',
  };

  it('renders the copy plus whole elapsed seconds since the diff opened', () => {
    const el = makeRoomView({ diffs: [carrierDiff], now: 46_000 });
    expect(el._carrierBannerText()).toBe('Your connection dropped — reconnecting… 45s');
  });

  it('is absent when no carrier diff exists', () => {
    const el = makeRoomView({ diffs: [], now: 46_000 });
    expect(el._carrierBannerText()).toBeUndefined();
  });
});

describe('tile establishment copy via the policy authority (surface 2)', () => {
  it('first establishment vs reconnection is chosen by peerReconnecting', () => {
    const fresh = makeRoomView({ reconnecting: () => false });
    expect(fresh._tileEstablishmentCopy('peerA', false)).toBe(
      'establishing WebRTC carrier…'
    );

    const rejoin = makeRoomView({ reconnecting: () => true });
    expect(rejoin._tileEstablishmentCopy('peerA', false)).toBe(
      'connection lost — reconnecting…'
    );
  });

  it('a connected link shows no establishment copy', () => {
    const el = makeRoomView({ reconnecting: () => true });
    expect(el._tileEstablishmentCopy('peerA', true)).toBeUndefined();
  });
});

describe('copy-singleton pin: policy strings live in exactly one source file', () => {
  // The whole point of routing through intent-diff-policy.ts is that the
  // render layer holds no copy of these strings. This walks ui/src and
  // asserts each render-copy literal appears in exactly one production
  // file (the policy), and that NONE of the policy copy is re-embedded in
  // room-view. The ellipsis is U+2026 and the em dash U+2014 — matched
  // byte-exact.
  // vitest runs with cwd = the ui workspace root.
  const srcRoot = join(process.cwd(), 'src');

  function productionFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === '__tests__' || entry === 'node_modules') continue;
        out.push(...productionFiles(full));
      } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
        out.push(full);
      }
    }
    return out;
  }

  const files = productionFiles(srcRoot);
  const contents = new Map(files.map(f => [f, readFileSync(f, 'utf8')]));
  const policyFile = files.find(f => f.endsWith('intent-diff-policy.ts'))!;
  const roomViewFile = files.find(f => f.endsWith('room/room-view.ts'))!;

  // Copy that is pure render text — must exist ONLY in the policy.
  const renderOnly = [
    'establishing WebRTC carrier…',
    'connection lost — reconnecting…',
    'Your connection dropped — reconnecting…',
  ];

  // All policy copy — capture `.failed` variants ('Microphone unavailable',
  // 'Camera unavailable') are ALSO emitted by capture-reconciler.ts as
  // error strings, so those are pinned absent-from-room-view rather than
  // exactly-one-file; room-view must never carry any of it.
  const allCopy = [
    ...renderOnly,
    'Microphone unavailable — retrying…',
    'Microphone unavailable',
    'Camera unavailable — retrying…',
    'Camera unavailable',
  ];

  it('policy file exists and is discovered', () => {
    expect(policyFile).toBeTruthy();
    expect(roomViewFile).toBeTruthy();
  });

  it('each render-copy string appears in exactly one production file — the policy', () => {
    for (const str of renderOnly) {
      const holders = files.filter(f => contents.get(f)!.includes(str));
      expect(holders, `"${str}" should live in exactly one file`).toEqual([
        policyFile,
      ]);
    }
  });

  it('room-view re-embeds none of the policy copy', () => {
    const room = contents.get(roomViewFile)!;
    for (const str of allCopy) {
      expect(room.includes(str), `room-view must not embed "${str}"`).toBe(false);
    }
  });
});
