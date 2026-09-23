import { describe, expect, it } from 'vitest';
import type { AgentPubKeyB64 } from '@holochain/client';
import type { ModuleStateEnvelope } from '../../../types';
import { isTranscribing, transcribingAgents } from '../transcribing-policy';

function envelope(payload: unknown, active = true): ModuleStateEnvelope {
  return { moduleId: 'transcription', active, payload: JSON.stringify(payload), updatedAt: 0 };
}

const ME = 'me' as AgentPubKeyB64;
const ALICE = 'alice' as AgentPubKeyB64;
const BOB = 'bob' as AgentPubKeyB64;

describe('isTranscribing', () => {
  const cases: Array<{ name: string; states: Record<string, ModuleStateEnvelope> | undefined; want: boolean }> = [
    { name: 'enabled true', states: { transcription: envelope({ enabled: true, requested: false }) }, want: true },
    { name: 'requested but not enabled', states: { transcription: envelope({ enabled: false, requested: true }) }, want: false },
    { name: 'module inactive', states: { transcription: envelope({ enabled: true, requested: false }, false) }, want: false },
    { name: 'no transcription entry', states: { wal: envelope({}) }, want: false },
    { name: 'malformed payload JSON', states: { transcription: { moduleId: 'transcription', active: true, payload: '{not json', updatedAt: 0 } }, want: false },
    { name: 'undefined states map', states: undefined, want: false },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(isTranscribing(c.states)).toBe(c.want);
    });
  }
});

describe('transcribingAgents', () => {
  it('self on, no peers', () => {
    const myStates = { transcription: envelope({ enabled: true, requested: false }) };
    expect(transcribingAgents(ME, myStates, {})).toEqual([ME]);
  });

  it('peer on, self off', () => {
    const myStates = { transcription: envelope({ enabled: false, requested: false }) };
    const peerStates = { [ALICE]: { transcription: envelope({ enabled: true, requested: false }) } };
    expect(transcribingAgents(ME, myStates, peerStates)).toEqual([ALICE]);
  });

  it('peerStates carrying an entry keyed by myKey is not double-counted', () => {
    const myStates = { transcription: envelope({ enabled: true, requested: false }) };
    const peerStates: Record<AgentPubKeyB64, Record<string, ModuleStateEnvelope>> = {
      [ME]: { transcription: envelope({ enabled: true, requested: false }) },
      [ALICE]: { transcription: envelope({ enabled: true, requested: false }) },
    };
    expect(transcribingAgents(ME, myStates, peerStates)).toEqual([ME, ALICE]);
  });

  it('self and peers both on, self first, peer order preserved', () => {
    const myStates = { transcription: envelope({ enabled: true, requested: false }) };
    const peerStates: Record<AgentPubKeyB64, Record<string, ModuleStateEnvelope>> = {
      [BOB]: { transcription: envelope({ enabled: true, requested: false }) },
      [ALICE]: { transcription: envelope({ enabled: true, requested: false }) },
    };
    expect(transcribingAgents(ME, myStates, peerStates)).toEqual([ME, BOB, ALICE]);
  });

  it('module inactive for a peer excludes them', () => {
    const peerStates = { [ALICE]: { transcription: envelope({ enabled: true, requested: false }, false) } };
    expect(transcribingAgents(ME, undefined, peerStates)).toEqual([]);
  });

  it('requested but not enabled does not count', () => {
    const myStates = { transcription: envelope({ enabled: false, requested: true }) };
    const peerStates = { [ALICE]: { transcription: envelope({ enabled: false, requested: true }) } };
    expect(transcribingAgents(ME, myStates, peerStates)).toEqual([]);
  });

  it('malformed payload JSON is treated as not transcribing', () => {
    const peerStates = {
      [ALICE]: { transcription: { moduleId: 'transcription', active: true, payload: '{broken', updatedAt: 0 } },
    };
    expect(transcribingAgents(ME, undefined, peerStates)).toEqual([]);
  });

  it('undefined maps yield an empty list', () => {
    expect(transcribingAgents(ME, undefined, undefined)).toEqual([]);
  });
});
