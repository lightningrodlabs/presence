import { describe, it, expect } from 'vitest';
import {
  audioSourceRefusalOf,
  decideMicOutput,
  decideSystemAudioRequest,
  isLiveTrack,
  type MicOutputInput,
  type SystemAudioRequestInput,
} from '../mic-output-policy';

/** Identity plus readyState: both the device and the mixin are read for liveness. */
const track = (readyState: 'live' | 'ended' = 'live') =>
  ({ readyState } as unknown as MediaStreamTrack);

describe('decideMicOutput', () => {
  const dev = track();
  const dev2 = track();
  const mix = track();
  const mix2 = track();

  const rows: Array<[string, MicOutputInput, ReturnType<typeof decideMicOutput>]> = [
    ['no sources, nothing installed', { device: null, mixin: null, current: null }, { kind: 'none', reason: 'no-source' }],
    ['no sources but a device output installed: clear it', { device: null, mixin: null, current: { mode: 'device' } }, { kind: 'clear-output', reason: 'no-source' }],
    ['a mixin with no microphone is a one-source mix, not a refusal', { device: null, mixin: mix, current: null }, { kind: 'build-mix', reason: 'mixin-added' }],
    ['the microphone closes under a mix: drop its node, keep the share', { device: null, mixin: mix, current: { mode: 'mixed', device: dev, mixin: mix } }, { kind: 'sync-mix-device', reason: 'device-removed' }],
    ['the microphone opens under a mic-less mix: add its node', { device: dev, mixin: mix, current: { mode: 'mixed', device: null, mixin: mix } }, { kind: 'sync-mix-device', reason: 'device-added' }],
    ['already mixed with no microphone', { device: null, mixin: mix, current: { mode: 'mixed', device: null, mixin: mix } }, { kind: 'none', reason: 'already-mixed' }],
    ['device opened, no mixin', { device: dev, mixin: null, current: null }, { kind: 'use-device', reason: 'device-only' }],
    ['device only, already on device', { device: dev, mixin: null, current: { mode: 'device' } }, { kind: 'none', reason: 'already-device' }],
    ['mixin arrives on a device-only output', { device: dev, mixin: mix, current: { mode: 'device' } }, { kind: 'build-mix', reason: 'mixin-added' }],
    ['mixin arrives before any output exists', { device: dev, mixin: mix, current: null }, { kind: 'build-mix', reason: 'mixin-added' }],
    ['same device, same mixin, already mixed', { device: dev, mixin: mix, current: { mode: 'mixed', device: dev, mixin: mix } }, { kind: 'none', reason: 'already-mixed' }],
    ['device changed under a mix', { device: dev2, mixin: mix, current: { mode: 'mixed', device: dev, mixin: mix } }, { kind: 'sync-mix-device', reason: 'device-changed' }],
    ['mixin changed under a mix', { device: dev, mixin: mix2, current: { mode: 'mixed', device: dev, mixin: mix } }, { kind: 'build-mix', reason: 'mixin-changed' }],
    ['mixin removed', { device: dev, mixin: null, current: { mode: 'mixed', device: dev, mixin: mix } }, { kind: 'tear-mix', reason: 'mixin-removed' }],
    ['mixin ended (the host or platform stopped it)', { device: dev, mixin: track('ended'), current: { mode: 'mixed', device: dev, mixin: mix } }, { kind: 'tear-mix', reason: 'mixin-ended' }],
    ['an ended mixin offered to a device-only output is ignored', { device: dev, mixin: track('ended'), current: { mode: 'device' } }, { kind: 'none', reason: 'already-device' }],
    ['a dead device (ended without its event) is no device, but a mixin still mixes', { device: track('ended'), mixin: mix, current: { mode: 'device' } }, { kind: 'build-mix', reason: 'mixin-added' }],
    ['a dead device under a mix drops its node, it does not tear the share', { device: track('ended'), mixin: mix, current: { mode: 'mixed', device: dev, mixin: mix } }, { kind: 'sync-mix-device', reason: 'device-removed' }],
    ['a dead device and no mixin, with a device output installed: clear it', { device: track('ended'), mixin: null, current: { mode: 'device' } }, { kind: 'clear-output', reason: 'no-source' }],
    ['the mixin goes while the microphone is closed: nothing is left to carry', { device: null, mixin: null, current: { mode: 'mixed', device: null, mixin: mix } }, { kind: 'tear-mix', reason: 'mixin-removed' }],
  ];

  it.each(rows)('%s', (_name, input, expected) => {
    expect(decideMicOutput(input)).toEqual(expected);
  });
});

describe('isLiveTrack', () => {
  it('null → false, ended → false, live → true', () => {
    expect(isLiveTrack(null)).toBe(false);
    expect(isLiveTrack(track('ended'))).toBe(false);
    expect(isLiveTrack(track('live'))).toBe(true);
  });
});

describe('decideSystemAudioRequest', () => {
  const base: SystemAudioRequestInput = {
    seamAvailable: true, active: false, pending: false,
  };
  const rows: Array<[string, Partial<SystemAudioRequestInput>, ReturnType<typeof decideSystemAudioRequest>]> = [
    ['everything in place', {}, { ok: true }],
    ['no host seam (older Moss)', { seamAvailable: false }, { ok: false, reason: 'no-seam' }],
    ['a capture is held', { active: true }, { ok: false, reason: 'already-active' }],
    ['the picker is up', { pending: true }, { ok: false, reason: 'request-pending' }],
    // The host refused the last request before any picker opened.
    ['this machine cannot capture: blocked for the session', { hostRefused: 'unsupported' },
      { ok: false, reason: 'host-refused', hostRefused: 'unsupported' }],
    ['Audio Sources went off in Moss: a click retries, and the decision carries why', { hostRefused: 'disabled' },
      { ok: true, hostRefused: 'disabled' }],
    ['no seam beats a refusal', { seamAvailable: false, hostRefused: 'unsupported' }, { ok: false, reason: 'no-seam' }],
    ['the picker is up beats a retryable refusal', { pending: true, hostRefused: 'disabled' },
      { ok: false, reason: 'request-pending' }],
  ];
  it.each(rows)('%s', (_name, patch, expected) => {
    expect(decideSystemAudioRequest({ ...base, ...patch })).toEqual(expected);
  });
});

describe('audioSourceRefusalOf (the host refusal, told from every other failure)', () => {
  /** What the host iframe's copy of `@theweave/api` throws: its own class, so only the shape crosses. */
  const refusal = (reason: unknown, name = 'AudioSourceUnavailableError') => {
    const e = new Error(`The host cannot capture audio sources: ${String(reason)}`);
    e.name = name;
    (e as { reason?: unknown }).reason = reason;
    return e;
  };
  const rows: Array<[string, unknown, ReturnType<typeof audioSourceRefusalOf>]> = [
    ['unsupported', refusal('unsupported'), 'unsupported'],
    ['disabled', refusal('disabled'), 'disabled'],
    ['a reason this build does not know', refusal('quota'), null],
    ['no reason', refusal(undefined), null],
    ['another error carrying a reason', refusal('unsupported', 'Error'), null],
    ['a plain error', new Error('nope'), null],
    ['a non-Error with the same fields', { name: 'AudioSourceUnavailableError', reason: 'disabled' }, null],
    ['a string', 'unsupported', null],
    ['null', null, null],
  ];
  it.each(rows)('%s', (_name, thrown, expected) => {
    expect(audioSourceRefusalOf(thrown)).toBe(expected);
  });
});
