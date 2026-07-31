import { describe, it, expect } from 'vitest';
import {
  buildDiagnosticSnapshot,
  DIAGNOSTIC_PAYLOAD_BUDGET_CHARS,
  DIAGNOSTIC_TRUNCATED_EVENTS_KEPT,
  DIAGNOSTIC_TRUNCATED_CUSTOM_LOGS_KEPT,
} from '../diagnostic-snapshot-policy';
import type { SimpleEvent, CustomLog } from '../logging';

/**
 * Phase 5 item 2: a gathered snapshot must be distinguishable from a
 * complete one by its reader. These tables pin the size guard and the
 * self-declaring `truncated` field.
 */

const AGENT = 'uhCAk-test-agent';

function events(n: number, detailLen = 0): SimpleEvent[] {
  return Array.from({ length: n }, (_, i) => ({
    agent: AGENT,
    timestamp: 1_000 + i,
    event: 'Connected' as const,
    ...(detailLen > 0 ? { detail: 'x'.repeat(detailLen) } : {}),
  }));
}

function customLogs(n: number): CustomLog[] {
  return Array.from({ length: n }, (_, i) => ({
    timestamp: 2_000 + i,
    log: `log ${i}`,
  }));
}

function input(overrides: Partial<Parameters<typeof buildDiagnosticSnapshot>[0]> = {}) {
  return {
    fromAgent: AGENT,
    sessionId: 'sess01',
    agentEvents: [] as SimpleEvent[],
    customLogs: [] as CustomLog[],
    generatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('buildDiagnosticSnapshot', () => {
  it('small snapshot passes through complete, with no truncated field', () => {
    const { snapshot, payload } = buildDiagnosticSnapshot(
      input({ agentEvents: events(5), customLogs: customLogs(3) }),
    );
    expect(snapshot.agentEvents).toHaveLength(5);
    expect(snapshot.customLogs).toHaveLength(3);
    expect(snapshot.truncated).toBeUndefined();
    // Absent means absent on the wire too — a reader keys on the field.
    expect(payload.includes('"truncated"')).toBe(false);
    expect(JSON.parse(payload)).toEqual(snapshot);
  });

  it('a payload at exactly the budget is NOT truncated (boundary)', () => {
    // Grow a filler detail until the serialized form lands exactly on
    // the budget, then assert pass-through.
    const base = input({ agentEvents: events(1, 0) });
    const overhead = JSON.stringify({
      ...base,
      agentEvents: [{ ...base.agentEvents[0], detail: '' }],
    }).length;
    const filler = DIAGNOSTIC_PAYLOAD_BUDGET_CHARS - overhead;
    const { snapshot, payload } = buildDiagnosticSnapshot(
      input({ agentEvents: events(1, filler) }),
    );
    expect(payload.length).toBe(DIAGNOSTIC_PAYLOAD_BUDGET_CHARS);
    expect(snapshot.truncated).toBeUndefined();
  });

  it('an oversized payload keeps the newest tail and declares the drops', () => {
    const nEvents = 1_000; // ~70 chars each -> far over budget
    const nLogs = 150;
    const { snapshot, payload } = buildDiagnosticSnapshot(
      input({ agentEvents: events(nEvents), customLogs: customLogs(nLogs) }),
    );
    expect(snapshot.agentEvents).toHaveLength(DIAGNOSTIC_TRUNCATED_EVENTS_KEPT);
    expect(snapshot.customLogs).toHaveLength(DIAGNOSTIC_TRUNCATED_CUSTOM_LOGS_KEPT);
    expect(snapshot.truncated).toEqual({
      events: nEvents - DIAGNOSTIC_TRUNCATED_EVENTS_KEPT,
      customLogs: nLogs - DIAGNOSTIC_TRUNCATED_CUSTOM_LOGS_KEPT,
    });
    // Tail, not head: newest timestamps survive.
    expect(snapshot.agentEvents[0].timestamp).toBe(
      1_000 + (nEvents - DIAGNOSTIC_TRUNCATED_EVENTS_KEPT),
    );
    expect(snapshot.customLogs[0].timestamp).toBe(
      2_000 + (nLogs - DIAGNOSTIC_TRUNCATED_CUSTOM_LOGS_KEPT),
    );
    // The returned payload is the truncated serialization, ready to send.
    expect(JSON.parse(payload)).toEqual(snapshot);
  });

  it('oversized with few custom logs declares zero drops for that collection', () => {
    const { snapshot } = buildDiagnosticSnapshot(
      input({ agentEvents: events(1_000), customLogs: customLogs(2) }),
    );
    expect(snapshot.truncated).toEqual({
      events: 1_000 - DIAGNOSTIC_TRUNCATED_EVENTS_KEPT,
      customLogs: 0,
    });
    expect(snapshot.customLogs).toHaveLength(2);
  });

  it('inherited edge, pinned as fact: truncation trusts the kept-counts, not re-measurement', () => {
    // A single enormous event (bigger than the whole budget) still
    // yields a "truncated" payload over the budget — the guard slices
    // by count, it does not re-check size after slicing. Inherited from
    // the pre-Phase-5 inline guard; declared here so the reader of
    // `truncated` knows the bound is by-count, not by-bytes.
    const { snapshot, payload } = buildDiagnosticSnapshot(
      input({ agentEvents: events(1, DIAGNOSTIC_PAYLOAD_BUDGET_CHARS + 1_000) }),
    );
    expect(snapshot.truncated).toEqual({ events: 0, customLogs: 0 });
    expect(payload.length).toBeGreaterThan(DIAGNOSTIC_PAYLOAD_BUDGET_CHARS);
  });
});
