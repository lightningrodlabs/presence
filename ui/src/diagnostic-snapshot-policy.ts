import type { CustomLog, SimpleEvent } from './logging';
import type { DiagnosticSnapshot } from './types';

/**
 * Phase 5 item 2: the truncation decision for outgoing
 * `DiagnosticResponse` payloads, extracted pure so the size guard is
 * table-testable (working agreement 4; template:
 * `transport/media-event-policy.ts`).
 *
 * A gathered snapshot travels as a remote signal, so it must fit the
 * signal-size budget. When it doesn't, the tail is kept and the drop is
 * DECLARED in `truncated` — an LLM reasoning over gathered evidence must
 * be able to tell "nothing happened" from "the record has a hole"
 * (MAINTAINABILITY_ASSESSMENT.md Phase 5). `truncated` absent means
 * complete; the field is additive, so old parsers ignore it.
 */

/**
 * Character budget for the JSON payload of one DiagnosticResponse
 * signal. Serves the wire snapshot only (`buildDiagnosticSnapshot`);
 * comfortably under Holochain remote-signal limits. Not a liveness
 * threshold — it names a size, not a clock (working agreement 2 does
 * not apply).
 */
export const DIAGNOSTIC_PAYLOAD_BUDGET_CHARS = 60_000;

/** Newest agent events kept when the payload exceeds the budget. */
export const DIAGNOSTIC_TRUNCATED_EVENTS_KEPT = 200;

/** Newest custom logs kept when the payload exceeds the budget. */
export const DIAGNOSTIC_TRUNCATED_CUSTOM_LOGS_KEPT = 100;

export type DiagnosticSnapshotInput = {
  fromAgent: string;
  sessionId: string;
  /** Flattened recent events, oldest first (truncation keeps the tail). */
  agentEvents: SimpleEvent[];
  customLogs: CustomLog[];
  /** This node's wall clock at gather time (`DiagnosticSnapshot.generatedAt`). */
  generatedAt: number;
};

/**
 * Build the snapshot that goes on the wire. If the serialized payload
 * exceeds `DIAGNOSTIC_PAYLOAD_BUDGET_CHARS`, keep the newest
 * `DIAGNOSTIC_TRUNCATED_EVENTS_KEPT` events and
 * `DIAGNOSTIC_TRUNCATED_CUSTOM_LOGS_KEPT` custom logs and declare the
 * per-collection drop counts in `truncated`. Returns the snapshot and
 * its serialized form — the caller sends `payload` as-is and must not
 * re-serialize.
 */
export function buildDiagnosticSnapshot(input: DiagnosticSnapshotInput): {
  snapshot: DiagnosticSnapshot;
  payload: string;
} {
  const complete: DiagnosticSnapshot = {
    fromAgent: input.fromAgent,
    sessionId: input.sessionId,
    agentEvents: input.agentEvents,
    customLogs: input.customLogs,
    generatedAt: input.generatedAt,
  };
  const completePayload = JSON.stringify(complete);
  if (completePayload.length <= DIAGNOSTIC_PAYLOAD_BUDGET_CHARS) {
    return { snapshot: complete, payload: completePayload };
  }

  const keptEvents = input.agentEvents.slice(-DIAGNOSTIC_TRUNCATED_EVENTS_KEPT);
  const keptCustomLogs = input.customLogs.slice(
    -DIAGNOSTIC_TRUNCATED_CUSTOM_LOGS_KEPT,
  );
  const truncated: DiagnosticSnapshot = {
    ...complete,
    agentEvents: keptEvents,
    customLogs: keptCustomLogs,
    truncated: {
      events: input.agentEvents.length - keptEvents.length,
      customLogs: input.customLogs.length - keptCustomLogs.length,
    },
  };
  return { snapshot: truncated, payload: JSON.stringify(truncated) };
}
