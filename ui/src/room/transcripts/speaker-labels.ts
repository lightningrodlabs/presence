import { decodeHashFromBase64, type AgentPubKeyB64 } from '@holochain/client';
import type { ProfilesStore } from '@holochain-open-dev/profiles';

/** Looks up one agent's display name; undefined when it has none. */
export type SpeakerLabelFetcher = (pk: AgentPubKeyB64) => Promise<string | undefined>;

export interface RefreshOptions {
  /** Also re-ask keys whose earlier lookup threw. */
  retryFailed?: boolean;
}

/**
 * Cached pubkey to nickname map for transcript speakers. A key is looked
 * up once: while its lookup is in flight or after it has answered (with
 * or without a nickname) it is skipped. A lookup that throws marks the key
 * failed; a plain `refresh` skips failed keys too, so a caller that
 * refreshes on every render never hammers a degraded conductor, and only
 * `refresh(pks, { retryFailed: true })` asks for them again.
 */
export class SpeakerLabels {
  private readonly labels = new Map<AgentPubKeyB64, string>();
  /** Keys in flight or already answered (with or without a nickname). */
  private readonly requested = new Set<AgentPubKeyB64>();
  /** Keys whose last lookup threw. */
  private readonly failed = new Set<AgentPubKeyB64>();

  constructor(private readonly fetch: SpeakerLabelFetcher) {}

  get(pk: AgentPubKeyB64): string | undefined {
    return this.labels.get(pk);
  }

  has(pk: AgentPubKeyB64): boolean {
    return this.labels.has(pk);
  }

  async refresh(pks: AgentPubKeyB64[], opts: RefreshOptions = {}): Promise<void> {
    const fresh: AgentPubKeyB64[] = [];
    for (const pk of pks) {
      if (this.labels.has(pk) || this.requested.has(pk)) continue;
      if (this.failed.has(pk)) {
        if (!opts.retryFailed) continue;
        this.failed.delete(pk);
      }
      this.requested.add(pk);
      fresh.push(pk);
    }
    await Promise.all(
      fresh.map(async (pk) => {
        try {
          const nickname = await this.fetch(pk);
          if (nickname) this.labels.set(pk, nickname);
        } catch {
          this.requested.delete(pk);
          this.failed.add(pk);
        }
      }),
    );
  }
}

/**
 * Reads the nickname with a direct zome call rather than through the
 * lazy `profilesStore.profiles.get()` readable: that store only starts
 * fetching on first subscription, so a transient read while nothing
 * else subscribes can return a pending value. The direct call always
 * returns the current DHT value.
 */
export function profileNicknameFetcher(profilesStore: ProfilesStore): SpeakerLabelFetcher {
  return async (pk) => {
    const record = await profilesStore.client.getAgentProfile(decodeHashFromBase64(pk));
    return record?.entry?.nickname;
  };
}
