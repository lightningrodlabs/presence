import { describe, expect, it } from 'vitest';
import { decideSignalsMediaCadence, SIGNALS_RTT_DEGRADED_MS, SIGNALS_RTT_COLLAPSED_MS } from '../signals-cadence-policy';

describe('decideSignalsMediaCadence', () => {
  const cases: Array<[string, Parameters<typeof decideSignalsMediaCadence>[0], ReturnType<typeof decideSignalsMediaCadence>]> = [
    ['healthy',            { carrierDown: false, bestRttEwmaMs: 300,   prevMode: 'full' },      { mode: 'full', reason: 'healthy' }],
    ['no sample yet',      { carrierDown: false, bestRttEwmaMs: undefined, prevMode: 'full' },  { mode: 'full', reason: 'no-sample' }],
    ['degraded sheds filmstrip', { carrierDown: false, bestRttEwmaMs: 2500, prevMode: 'full' }, { mode: 'voice-only', reason: 'rtt-degraded' }],
    ['collapsed pauses',   { carrierDown: false, bestRttEwmaMs: 6000, prevMode: 'voice-only' }, { mode: 'paused', reason: 'rtt-collapsed' }],
    ['carrier down pauses regardless of rtt', { carrierDown: true, bestRttEwmaMs: 100, prevMode: 'full' }, { mode: 'paused', reason: 'carrier-down' }],
    // hysteresis: recovery requires dropping below half the threshold
    ['no flap at threshold edge', { carrierDown: false, bestRttEwmaMs: 1900, prevMode: 'voice-only' }, { mode: 'voice-only', reason: 'rtt-degraded' }],
    ['recovers below half threshold', { carrierDown: false, bestRttEwmaMs: 900, prevMode: 'voice-only' }, { mode: 'full', reason: 'healthy' }],
    ['paused recovers one level',     { carrierDown: false, bestRttEwmaMs: 2200, prevMode: 'paused' },   { mode: 'voice-only', reason: 'rtt-degraded' }],
  ];
  it.each(cases)('%s', (_n, input, expected) => {
    expect(decideSignalsMediaCadence(input)).toEqual(expected);
  });

  it('exports the named thresholds the table above assumes', () => {
    expect(SIGNALS_RTT_DEGRADED_MS).toBe(2_000);
    expect(SIGNALS_RTT_COLLAPSED_MS).toBe(5_000);
  });
});
