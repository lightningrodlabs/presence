import { describe, expect, it } from 'vitest';
import type { AgentPubKeyB64 } from '@holochain/client';
import { SpeakerLabels } from '../speaker-labels';

type Answer = string | undefined | Error;

/** In-memory fetcher: answers from a table, records calls, resolves on demand. */
function fetcher(answers: Record<AgentPubKeyB64, Answer>) {
  const calls: AgentPubKeyB64[] = [];
  const pending: Array<() => void> = [];
  let held = false;
  const fetch = (pk: AgentPubKeyB64): Promise<string | undefined> => {
    calls.push(pk);
    const settle = (resolve: (v: string | undefined) => void, reject: (e: unknown) => void) => {
      const a = answers[pk];
      if (a instanceof Error) reject(a);
      else resolve(a);
    };
    return new Promise((resolve, reject) => {
      if (held) pending.push(() => settle(resolve, reject));
      else settle(resolve, reject);
    });
  };
  return {
    fetch,
    calls,
    hold: () => {
      held = true;
    },
    release: () => {
      held = false;
      for (const p of pending.splice(0)) p();
    },
  };
}

describe('SpeakerLabels', () => {
  const cases: Array<{
    name: string;
    answers: Record<AgentPubKeyB64, Answer>;
    refresh: AgentPubKeyB64[];
    labels: Record<AgentPubKeyB64, string | undefined>;
  }> = [
    { name: 'labels every key with a nickname', answers: { a: 'Ann', b: 'Bob' }, refresh: ['a', 'b'], labels: { a: 'Ann', b: 'Bob' } },
    { name: 'a key without a nickname stays unlabelled', answers: { a: 'Ann', b: undefined }, refresh: ['a', 'b'], labels: { a: 'Ann', b: undefined } },
    { name: 'a failed key stays unlabelled and does not block others', answers: { a: new Error('down'), b: 'Bob' }, refresh: ['a', 'b'], labels: { a: undefined, b: 'Bob' } },
    { name: 'nothing requested', answers: {}, refresh: [], labels: {} },
  ];
  for (const c of cases) {
    it(c.name, async () => {
      const f = fetcher(c.answers);
      const s = new SpeakerLabels(f.fetch);
      await s.refresh(c.refresh);
      for (const [pk, want] of Object.entries(c.labels)) {
        expect(s.get(pk)).toBe(want);
        expect(s.has(pk)).toBe(want !== undefined);
      }
    });
  }

  it('does not refetch a key that is already labelled', async () => {
    const f = fetcher({ a: 'Ann' });
    const s = new SpeakerLabels(f.fetch);
    await s.refresh(['a']);
    await s.refresh(['a']);
    expect(f.calls).toEqual(['a']);
  });

  it('does not refetch a key whose lookup is in flight', async () => {
    const f = fetcher({ a: 'Ann' });
    const s = new SpeakerLabels(f.fetch);
    f.hold();
    const first = s.refresh(['a']);
    const second = s.refresh(['a', 'a']);
    f.release();
    await Promise.all([first, second]);
    expect(f.calls).toEqual(['a']);
    expect(s.get('a')).toBe('Ann');
  });

  it('does not refetch a key that answered without a nickname', async () => {
    const f = fetcher({ a: undefined });
    const s = new SpeakerLabels(f.fetch);
    await s.refresh(['a']);
    await s.refresh(['a']);
    expect(f.calls).toEqual(['a']);
  });

  it('a failure leaves an existing label untouched', async () => {
    const answers: Record<AgentPubKeyB64, Answer> = { a: 'Ann' };
    const f = fetcher(answers);
    const s = new SpeakerLabels(f.fetch);
    await s.refresh(['a']);
    answers.b = new Error('down');
    await s.refresh(['a', 'b']);
    expect(s.get('a')).toBe('Ann');
    expect(s.has('b')).toBe(false);
  });

  const failedCases: Array<{ name: string; retryFailed: boolean | undefined; calls: AgentPubKeyB64[]; label: string | undefined }> = [
    { name: 'failed key skipped on a plain refresh', retryFailed: undefined, calls: ['a'], label: undefined },
    { name: 'failed key skipped with retryFailed false', retryFailed: false, calls: ['a'], label: undefined },
    { name: 'failed key retried with retryFailed', retryFailed: true, calls: ['a', 'a'], label: 'Ann' },
  ];
  for (const c of failedCases) {
    it(c.name, async () => {
      const answers: Record<AgentPubKeyB64, Answer> = { a: new Error('down') };
      const f = fetcher(answers);
      const s = new SpeakerLabels(f.fetch);
      await s.refresh(['a']);
      answers.a = 'Ann';
      await s.refresh(['a'], c.retryFailed === undefined ? undefined : { retryFailed: c.retryFailed });
      expect(f.calls).toEqual(c.calls);
      expect(s.get('a')).toBe(c.label);
    });
  }

  it('retryFailed does not refetch answered keys', async () => {
    const f = fetcher({ a: 'Ann', b: undefined });
    const s = new SpeakerLabels(f.fetch);
    await s.refresh(['a', 'b']);
    await s.refresh(['a', 'b'], { retryFailed: true });
    expect(f.calls).toEqual(['a', 'b']);
  });

  it('a key that fails again after a retry stays failed', async () => {
    const f = fetcher({ a: new Error('down') });
    const s = new SpeakerLabels(f.fetch);
    await s.refresh(['a']);
    await s.refresh(['a'], { retryFailed: true });
    await s.refresh(['a']);
    expect(f.calls).toEqual(['a', 'a']);
  });

  it('fetches distinct keys in parallel', async () => {
    const f = fetcher({ a: 'Ann', b: 'Bob' });
    const s = new SpeakerLabels(f.fetch);
    f.hold();
    const done = s.refresh(['a', 'b']);
    expect(f.calls).toEqual(['a', 'b']);
    f.release();
    await done;
  });
});
