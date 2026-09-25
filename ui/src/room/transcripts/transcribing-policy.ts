import type { AgentPubKeyB64 } from '@holochain/client';
import type { ModuleStateEnvelope } from '../../types';
import { parseTranscriptionPayload } from '../modules/transcription';

/**
 * Whether the given agent's module-state map shows them actively
 * transcribing their own mic right now. `requested` (asking others to
 * transcribe) does not count — only `enabled` does. The one predicate
 * shared by the transcription pane's title list and the per-tile icon.
 */
export function isTranscribing(states: Record<string, ModuleStateEnvelope> | undefined): boolean {
  return !!parseTranscriptionPayload(states?.['transcription'] ?? null)?.enabled;
}

/**
 * Agents currently transcribing, self first (when applicable), then
 * peers in `peerStates` key order.
 */
export function transcribingAgents(
  myKey: AgentPubKeyB64,
  myStates: Record<string, ModuleStateEnvelope> | undefined,
  peerStates: Record<AgentPubKeyB64, Record<string, ModuleStateEnvelope>> | undefined,
): AgentPubKeyB64[] {
  const result: AgentPubKeyB64[] = [];
  if (isTranscribing(myStates)) result.push(myKey);
  for (const pk of Object.keys(peerStates ?? {})) {
    if (pk === myKey) continue;
    if (isTranscribing(peerStates?.[pk])) result.push(pk);
  }
  return result;
}
