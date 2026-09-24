import { describe, it, expect } from 'vitest';
import {
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
    ['no device, nothing current', { device: null, mixin: null, current: null }, { kind: 'none', reason: 'no-device' }],
    ['no device but a mixin: v1 needs the mic held', { device: null, mixin: mix, current: null }, { kind: 'none', reason: 'no-device' }],
    ['device closed while mixed', { device: null, mixin: mix, current: { mode: 'mixed', device: dev, mixin: mix } }, { kind: 'tear-mix', reason: 'device-closed' }],
    ['device opened, no mixin', { device: dev, mixin: null, current: null }, { kind: 'use-device', reason: 'device-only' }],
    ['device only, already on device', { device: dev, mixin: null, current: { mode: 'device' } }, { kind: 'none', reason: 'already-device' }],
    ['mixin arrives on a device-only output', { device: dev, mixin: mix, current: { mode: 'device' } }, { kind: 'build-mix', reason: 'mixin-added' }],
    ['mixin arrives before any output exists', { device: dev, mixin: mix, current: null }, { kind: 'build-mix', reason: 'mixin-added' }],
    ['same device, same mixin, already mixed', { device: dev, mixin: mix, current: { mode: 'mixed', device: dev, mixin: mix } }, { kind: 'none', reason: 'already-mixed' }],
    ['device changed under a mix', { device: dev2, mixin: mix, current: { mode: 'mixed', device: dev, mixin: mix } }, { kind: 'build-mix', reason: 'device-changed' }],
    ['mixin changed under a mix', { device: dev, mixin: mix2, current: { mode: 'mixed', device: dev, mixin: mix } }, { kind: 'build-mix', reason: 'mixin-changed' }],
    ['mixin removed', { device: dev, mixin: null, current: { mode: 'mixed', device: dev, mixin: mix } }, { kind: 'tear-mix', reason: 'mixin-removed' }],
    ['mixin ended (the host or platform stopped it)', { device: dev, mixin: track('ended'), current: { mode: 'mixed', device: dev, mixin: mix } }, { kind: 'tear-mix', reason: 'mixin-ended' }],
    ['an ended mixin offered to a device-only output is ignored', { device: dev, mixin: track('ended'), current: { mode: 'device' } }, { kind: 'none', reason: 'already-device' }],
    ['a dead device (ended without its event) is no device: the share is refused', { device: track('ended'), mixin: mix, current: { mode: 'device' } }, { kind: 'none', reason: 'no-device' }],
    ['a dead device under a mix tears it', { device: track('ended'), mixin: mix, current: { mode: 'mixed', device: dev, mixin: mix } }, { kind: 'tear-mix', reason: 'device-closed' }],
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
    seamAvailable: true, micWanted: true, micLifecycle: 'live', active: false, pending: false,
  };
  const rows: Array<[string, Partial<SystemAudioRequestInput>, ReturnType<typeof decideSystemAudioRequest>]> = [
    ['everything in place', {}, { ok: true }],
    ['no host seam (older Moss)', { seamAvailable: false }, { ok: false, reason: 'no-seam' }],
    ['mic not wanted', { micWanted: false }, { ok: false, reason: 'mic-not-wanted' }],
    ['mic wanted, still acquiring', { micLifecycle: 'acquiring' }, { ok: false, reason: 'mic-not-live' }],
    ['mic wanted, ended', { micLifecycle: 'ended' }, { ok: false, reason: 'mic-not-live' }],
    ['mic wanted, failed', { micLifecycle: 'failed' }, { ok: false, reason: 'mic-not-live' }],
    ['a capture is held', { active: true }, { ok: false, reason: 'already-active' }],
    ['the picker is up', { pending: true }, { ok: false, reason: 'request-pending' }],
    ['not wanted beats not live (the row says which to fix first)', { micWanted: false, micLifecycle: 'failed' }, { ok: false, reason: 'mic-not-wanted' }],
  ];
  it.each(rows)('%s', (_name, patch, expected) => {
    expect(decideSystemAudioRequest({ ...base, ...patch })).toEqual(expected);
  });
});
