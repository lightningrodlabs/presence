import { describe, it, expect } from 'vitest';
import { decideMicOutput, isUsableMixin, type MicOutputInput } from '../mic-output-policy';

/** Identity is all the policy reads; readyState only for the mixin. */
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
  ];

  it.each(rows)('%s', (_name, input, expected) => {
    expect(decideMicOutput(input)).toEqual(expected);
  });
});

describe('isUsableMixin', () => {
  it('null → false, ended → false, live → true', () => {
    expect(isUsableMixin(null)).toBe(false);
    expect(isUsableMixin(track('ended'))).toBe(false);
    expect(isUsableMixin(track('live'))).toBe(true);
  });
});
