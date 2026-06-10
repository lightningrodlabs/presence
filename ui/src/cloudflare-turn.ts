/**
 * Cloudflare Realtime TURN credential generation.
 *
 * Cloudflare issues short-lived TURN credentials from a TURN key (a key ID +
 * API token pair created in the Cloudflare dashboard). The
 * `generate-ice-servers` endpoint returns a single ICE-server object scoped to
 * the requested TTL:
 *
 *   curl -H "Authorization: Bearer <API_TOKEN>" \
 *        -H "Content-Type: application/json" -d '{"ttl": 86400}' \
 *        https://rtc.live.cloudflare.com/v1/turn/keys/<KEY_ID>/credentials/generate-ice-servers
 *
 * Response shape:
 *   { "iceServers": { "urls": [...], "username": "...", "credential": "..." } }
 *
 * We extract only the turn:/turns: URLs (the stun: entries are already covered
 * by DEFAULT_ICE_SERVERS) plus the username/credential, and surface the TTL so
 * the caller can schedule a refresh before the credentials lapse.
 */

export interface CloudflareTurnCredentials {
  /** turn:/turns: relay URLs from the issued ICE server. */
  urls: string[];
  username: string;
  credential: string;
  /** TTL in seconds that was requested (and that the credentials are valid for). */
  ttl: number;
}

const ENDPOINT = 'https://rtc.live.cloudflare.com/v1/turn/keys';

export async function fetchCloudflareTurnCredentials(
  keyId: string,
  apiToken: string,
  ttl: number = 86400
): Promise<CloudflareTurnCredentials> {
  if (!keyId.trim()) throw new Error('Missing Cloudflare TURN key ID');
  if (!apiToken.trim()) throw new Error('Missing Cloudflare API token');

  const url = `${ENDPOINT}/${encodeURIComponent(
    keyId.trim()
  )}/credentials/generate-ice-servers`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken.trim()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl }),
    });
  } catch (e) {
    // Network/CORS failures surface here as a TypeError with an opaque message.
    throw new Error(
      `Cloudflare TURN request failed (network/CORS): ${
        e instanceof Error ? e.message : String(e)
      }`
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Cloudflare TURN request failed: ${res.status} ${res.statusText}${
        body ? ` — ${body}` : ''
      }`
    );
  }

  type IceEntry = {
    urls?: string | string[];
    username?: string;
    credential?: string;
  };
  const data = (await res.json()) as {
    iceServers?: IceEntry | IceEntry[];
  };

  const raw = data.iceServers;
  if (!raw) throw new Error('Cloudflare TURN response missing iceServers');

  // `iceServers` may be a single RTCIceServer object or an array of them
  // (Cloudflare's generate-ice-servers returns an array: a stun entry plus a
  // turn entry carrying username/credential). Normalize to an array and pull
  // the turn:/turns: URLs and the credentials from whichever entry has them.
  const entries: IceEntry[] = Array.isArray(raw) ? raw : [raw];
  const turnUrls: string[] = [];
  let username = '';
  let credential = '';
  for (const entry of entries) {
    const urls = Array.isArray(entry.urls)
      ? entry.urls
      : entry.urls
      ? [entry.urls]
      : [];
    const turns = urls.filter(
      u => u.startsWith('turn:') || u.startsWith('turns:')
    );
    if (turns.length > 0) {
      turnUrls.push(...turns);
      if (!username && entry.username) username = entry.username;
      if (!credential && entry.credential) credential = entry.credential;
    }
  }

  // We specifically need relay (turn:/turns:) URLs — a STUN-only response would
  // populate an ICE entry that can never relay, silently defeating force-TURN.
  // Surface it (with the raw shape) as an error rather than a bogus success.
  if (turnUrls.length === 0) {
    throw new Error(
      `Cloudflare TURN response had no turn:/turns: URLs (raw: ${JSON.stringify(
        raw
      ).slice(0, 300)})`
    );
  }

  return { urls: turnUrls, username, credential, ttl };
}
