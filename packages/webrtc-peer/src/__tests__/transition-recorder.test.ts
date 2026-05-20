import { describe, it, expect } from 'vitest';
import { TransitionRecorder } from '../transition-recorder';
import type { FSMTransitionEntry } from '../types';

const makeEntry = (
  overrides: Partial<FSMTransitionEntry> = {},
): FSMTransitionEntry => ({
  timestamp: Date.now(),
  connectionId: 'conn-1',
  remoteAgent: 'agent-A',
  fromState: 'idle',
  toState: 'signaling',
  trigger: 'connect',
  ...overrides,
});

describe('TransitionRecorder', () => {
  it('starts empty with the default capacity', () => {
    const r = new TransitionRecorder();
    expect(r.size).toBe(0);
    expect(r.capacity).toBe(1000);
    expect(r.dump()).toEqual([]);
  });

  it('honors a custom capacity', () => {
    const r = new TransitionRecorder({ capacity: 50 });
    expect(r.capacity).toBe(50);
  });

  it('rejects non-positive or non-integer capacity', () => {
    expect(() => new TransitionRecorder({ capacity: 0 })).toThrow();
    expect(() => new TransitionRecorder({ capacity: -1 })).toThrow();
    expect(() => new TransitionRecorder({ capacity: 1.5 })).toThrow();
  });

  it('records entries in order', () => {
    const r = new TransitionRecorder({ capacity: 10 });
    const a = makeEntry({ trigger: 'a' });
    const b = makeEntry({ trigger: 'b' });
    r.record(a);
    r.record(b);
    expect(r.size).toBe(2);
    expect(r.dump()).toEqual([a, b]);
  });

  it('drops the oldest entries when capacity is exceeded', () => {
    const r = new TransitionRecorder({ capacity: 3 });
    for (let i = 0; i < 5; i++) r.record(makeEntry({ trigger: `t${i}` }));
    expect(r.size).toBe(3);
    expect(r.dump().map(e => e.trigger)).toEqual(['t2', 't3', 't4']);
  });

  it('dump() returns a copy that does not mutate the buffer', () => {
    const r = new TransitionRecorder({ capacity: 10 });
    r.record(makeEntry());
    const snapshot = r.dump();
    snapshot.push(makeEntry({ trigger: 'extra' }));
    expect(r.size).toBe(1);
  });

  it('dumpForConnection() filters by connectionId', () => {
    const r = new TransitionRecorder();
    r.record(makeEntry({ connectionId: 'A' }));
    r.record(makeEntry({ connectionId: 'B' }));
    r.record(makeEntry({ connectionId: 'A' }));
    const a = r.dumpForConnection('A');
    expect(a).toHaveLength(2);
    expect(a.every(e => e.connectionId === 'A')).toBe(true);
  });

  it('dumpForAgent() filters by remoteAgent', () => {
    const r = new TransitionRecorder();
    r.record(makeEntry({ remoteAgent: 'agent-A' }));
    r.record(makeEntry({ remoteAgent: 'agent-B' }));
    r.record(makeEntry({ remoteAgent: 'agent-A' }));
    expect(r.dumpForAgent('agent-A')).toHaveLength(2);
    expect(r.dumpForAgent('agent-B')).toHaveLength(1);
    expect(r.dumpForAgent('nobody')).toEqual([]);
  });

  it('clear() empties the buffer', () => {
    const r = new TransitionRecorder();
    r.record(makeEntry());
    r.record(makeEntry());
    r.clear();
    expect(r.size).toBe(0);
    expect(r.dump()).toEqual([]);
  });

  it('toJSON() produces a parseable record with capacity, size and entries', () => {
    const r = new TransitionRecorder({ capacity: 5 });
    r.record(makeEntry({ trigger: 'one' }));
    r.record(makeEntry({ trigger: 'two' }));
    const parsed = JSON.parse(r.toJSON());
    expect(parsed.capacity).toBe(5);
    expect(parsed.size).toBe(2);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0].trigger).toBe('one');
  });

  it('integrates as an onTransition sink', () => {
    const r = new TransitionRecorder({ capacity: 100 });
    // simulate the contract: someone wires `(e) => r.record(e)` into onTransition.
    const sink: (e: FSMTransitionEntry) => void = e => r.record(e);
    sink(makeEntry({ trigger: 'from-fsm' }));
    expect(r.size).toBe(1);
    expect(r.dump()[0].trigger).toBe('from-fsm');
  });
});
