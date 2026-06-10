import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchCloudflareTurnCredentials } from '../cloudflare-turn';

function mockFetch(body: unknown, ok = true, status = 200) {
  const fn = vi.fn().mockResolvedValue({
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response);
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchCloudflareTurnCredentials', () => {
  // The real generate-ice-servers response: iceServers is an ARRAY — a
  // stun-only entry plus a turn entry carrying username/credential.
  const realResponse = {
    iceServers: [
      { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
      {
        urls: [
          'turn:turnv2.realtime.cloudflare.com:3478?transport=udp',
          'turn:turn.cloudflare.com:3478?transport=tcp',
          'turns:turn.cloudflare.com:5349?transport=tcp',
          'turn:turn.cloudflare.com:53?transport=udp',
          'turn:turn.cloudflare.com:80?transport=tcp',
          'turns:turn.cloudflare.com:443?transport=tcp',
        ],
        username: 'g093ca72ecfca46f8e2f95db753c758a1845bb112f141cec4eff182fabf6a07c',
        credential: '0fad99105b2b0356f9ff703755581227dfabd47b32b51d12b8d55542895a1f58',
      },
    ],
  };

  it('extracts turn/turns URLs and credentials from the array response', async () => {
    mockFetch(realResponse);
    const creds = await fetchCloudflareTurnCredentials('KEY', 'TOKEN', 86400);
    expect(creds.urls).toEqual([
      'turn:turnv2.realtime.cloudflare.com:3478?transport=udp',
      'turn:turn.cloudflare.com:3478?transport=tcp',
      'turns:turn.cloudflare.com:5349?transport=tcp',
      'turn:turn.cloudflare.com:53?transport=udp',
      'turn:turn.cloudflare.com:80?transport=tcp',
      'turns:turn.cloudflare.com:443?transport=tcp',
    ]);
    expect(creds.urls.every(u => u.startsWith('turn:') || u.startsWith('turns:'))).toBe(true);
    expect(creds.username).toBe(realResponse.iceServers[1].username);
    expect(creds.credential).toBe(realResponse.iceServers[1].credential);
    expect(creds.ttl).toBe(86400);
  });

  it('posts ttl and bearer token to the generate-ice-servers endpoint', async () => {
    const fn = mockFetch(realResponse);
    await fetchCloudflareTurnCredentials('MY_KEY', 'MY_TOKEN', 3600);
    expect(fn).toHaveBeenCalledTimes(1);
    const [url, init] = fn.mock.calls[0];
    expect(url).toBe(
      'https://rtc.live.cloudflare.com/v1/turn/keys/MY_KEY/credentials/generate-ice-servers'
    );
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer MY_TOKEN');
    expect(JSON.parse(init.body)).toEqual({ ttl: 3600 });
  });

  it('also accepts a single iceServers object (non-array)', async () => {
    mockFetch({
      iceServers: {
        urls: ['stun:stun.cloudflare.com:3478', 'turn:turn.cloudflare.com:3478?transport=udp'],
        username: 'u',
        credential: 'c',
      },
    });
    const creds = await fetchCloudflareTurnCredentials('KEY', 'TOKEN');
    expect(creds.urls).toEqual(['turn:turn.cloudflare.com:3478?transport=udp']);
    expect(creds.username).toBe('u');
    expect(creds.credential).toBe('c');
  });

  it('throws when the response has no turn:/turns: URLs', async () => {
    mockFetch({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }] });
    await expect(
      fetchCloudflareTurnCredentials('KEY', 'TOKEN')
    ).rejects.toThrow(/no turn:\/turns: URLs/);
  });

  it('throws on a non-ok HTTP response', async () => {
    mockFetch({ error: 'bad token' }, false, 401);
    await expect(
      fetchCloudflareTurnCredentials('KEY', 'TOKEN')
    ).rejects.toThrow(/401/);
  });

  it('requires both key id and api token', async () => {
    await expect(fetchCloudflareTurnCredentials('', 'TOKEN')).rejects.toThrow(/key ID/);
    await expect(fetchCloudflareTurnCredentials('KEY', '')).rejects.toThrow(/API token/);
  });
});
