import { describe, it, expect, vi, afterEach } from 'vitest';

import { TokenExchanger } from '../../src/auth/token-exchange';
import { MemoryStore } from '../../src/shared-store';
import { collectMetrics } from './metric-reader';

/**
 * Token exchange is what replaced forwarding the client's token upstream. Two properties matter
 * here: the client's token never leaves as a credential, and a failure is reported as the thing
 * the MCP client has to do about it.
 */
describe('TokenExchanger', () => {
  const CONFIG = {
    tokenEndpoint: 'https://api.gremlin.com/v1/oauth2/token',
    clientId: 'gremlin_oid_mcp',
    clientSecret: 'shhh',
    targetResource: 'https://api.gremlin.com',
  };
  const SUBJECT = 'gremlin_oat_user_token';

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(
    responder: (url: string, init: RequestInit) => { status: number; body: unknown },
  ) {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      const { status, body } = responder(url, init);
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('records the exchange under its own url.template, and nothing of the token', async () => {
    const collected = collectMetrics();
    try {
      stubFetch(() => ({ status: 200, body: { access_token: 'gremlin_oat_api', expires_in: 300 } }));

      await new TokenExchanger(CONFIG).exchange(SUBJECT);

      expect(await collected.attributes()).toEqual([
        {
          'http.request.method': 'POST',
          'server.address': 'api.gremlin.com',
          'server.port': 443,
          'url.template': '/v1/oauth2/token',
          'http.response.status_code': 200,
        },
      ]);
    } finally {
      await collected.stop();
    }
  });

  it('sends the subject token as a parameter and authenticates as itself', async () => {
    // The whole point. The client's token is in the body, where it is data; the Authorization
    // header carries this server's own credentials. If those were ever swapped, this would be the
    // passthrough the MCP specification forbids.
    const fetchMock = stubFetch(() => ({
      status: 200,
      body: { access_token: 'gremlin_oat_api', expires_in: 300 },
    }));

    const result = await new TokenExchanger(CONFIG).exchange(SUBJECT);

    expect(result).toEqual({ ok: true, accessToken: 'gremlin_oat_api', expiresAt: expect.any(Number) });
    const [, init] = fetchMock.mock.calls[0]!;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Basic /);
    expect(headers.Authorization).not.toContain(SUBJECT);

    const body = (init.body as URLSearchParams).toString();
    expect(body).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange');
    expect(body).toContain(`subject_token=${SUBJECT}`);
    expect(body).toContain('resource=https%3A%2F%2Fapi.gremlin.com');
  });

  it('reuses a live token rather than exchanging on every call', async () => {
    // Without the cache every tool call is preceded by a round trip to the authorization server.
    const fetchMock = stubFetch(() => ({
      status: 200,
      body: { access_token: 'gremlin_oat_api', expires_in: 300 },
    }));
    const exchanger = new TokenExchanger(CONFIG);

    await exchanger.exchange(SUBJECT);
    await exchanger.exchange(SUBJECT);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('exchanges again once the cached token is close to expiry', async () => {
    // A token that dies mid-flight surfaces as a broken tool call, so the margin has to cover a
    // request's round trip.
    let now = 1_000_000;
    const fetchMock = stubFetch(() => ({
      status: 200,
      body: { access_token: 'gremlin_oat_api', expires_in: 300 },
    }));
    const exchanger = new TokenExchanger(CONFIG, new MemoryStore(() => now), () => now);

    await exchanger.exchange(SUBJECT);
    now += 280_000;
    await exchanger.exchange(SUBJECT);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports a rejected subject token as invalid, so the client reconnects', async () => {
    // Expired, revoked, or minted for somewhere other than this server. Claude must run the OAuth
    // flow again, which only a 401 triggers.
    stubFetch(() => ({ status: 400, body: { error: 'invalid_grant' } }));

    expect(await new TokenExchanger(CONFIG).exchange(SUBJECT)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('reports a token minted for another resource as invalid', async () => {
    stubFetch(() => ({ status: 400, body: { error: 'invalid_target' } }));

    expect(await new TokenExchanger(CONFIG).exchange(SUBJECT)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('reports the organization AI switch as forbidden, not as a bad token', async () => {
    // Nothing the user can fix by reconnecting. Mapped to invalid it would produce an endless
    // reconnect loop against a setting only an administrator can change.
    stubFetch(() => ({ status: 400, body: { error: 'access_denied' } }));

    expect(await new TokenExchanger(CONFIG).exchange(SUBJECT)).toEqual({
      ok: false,
      reason: 'forbidden',
    });
  });

  it('reports an authorization server outage as unavailable', async () => {
    // A 5xx says nothing about the token. Reporting it as invalid would disconnect every working
    // connector for the duration of a blip.
    stubFetch(() => ({ status: 503, body: {} }));

    expect(await new TokenExchanger(CONFIG).exchange(SUBJECT)).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });

  it('reports a transport failure as unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );

    expect(await new TokenExchanger(CONFIG).exchange(SUBJECT)).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });

  it('does not cache a failure', async () => {
    // A failed exchange must not pin the user out for the cache lifetime, especially when the
    // failure was the authorization server being briefly unreachable.
    const fetchMock = stubFetch(() => ({ status: 503, body: {} }));
    const store = new MemoryStore();
    const exchanger = new TokenExchanger(CONFIG, store);

    await exchanger.exchange(SUBJECT);
    await exchanger.exchange(SUBJECT);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(store.size()).toBe(0);
  });

  it('keys the cache per subject token', async () => {
    // One user's exchanged token must never be handed to another. The key is a hash of the
    // subject token, so distinct users cannot collide.
    stubFetch((_url, init) => ({
      status: 200,
      body: {
        access_token: `api-for-${(init.body as URLSearchParams).get('subject_token')}`,
        expires_in: 300,
      },
    }));
    const exchanger = new TokenExchanger(CONFIG);

    const a = await exchanger.exchange('gremlin_oat_a');
    const b = await exchanger.exchange('gremlin_oat_b');

    expect(a).toMatchObject({ ok: true, accessToken: 'api-for-gremlin_oat_a' });
    expect(b).toMatchObject({ ok: true, accessToken: 'api-for-gremlin_oat_b' });
  });

  it('reclaims entries whose tokens have expired', async () => {
    // A cached entry is only replaced when its own key is asked for again, and a client's token
    // changes on every refresh -- so without a sweep the map grows by one per rotation per user
    // and nothing reclaims the old ones.
    let now = 1_000_000;
    stubFetch((_url, init) => ({
      status: 200,
      body: {
        access_token: `api-for-${(init.body as URLSearchParams).get('subject_token')}`,
        expires_in: 300,
      },
    }));
    const store = new MemoryStore(() => now);
    const exchanger = new TokenExchanger(CONFIG, store, () => now);

    await exchanger.exchange('gremlin_oat_before_refresh');
    await exchanger.exchange('gremlin_oat_after_refresh');
    expect(store.size()).toBe(2);

    now += 301_000;
    store.sweep();

    expect(store.size()).toBe(0);
  });

  it('keeps entries that are still live when sweeping', async () => {
    let now = 1_000_000;
    stubFetch(() => ({
      status: 200,
      body: { access_token: 'gremlin_oat_api', expires_in: 300 },
    }));
    const store = new MemoryStore(() => now);
    const exchanger = new TokenExchanger(CONFIG, store, () => now);

    await exchanger.exchange(SUBJECT);
    now += 60_000;
    store.sweep();

    expect(store.size()).toBe(1);
  });

  it('forgets a token on request', async () => {
    const fetchMock = stubFetch(() => ({
      status: 200,
      body: { access_token: 'gremlin_oat_api', expires_in: 300 },
    }));
    const exchanger = new TokenExchanger(CONFIG);

    await exchanger.exchange(SUBJECT);
    await exchanger.forget(SUBJECT);
    await exchanger.exchange(SUBJECT);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  describe('with a shared store', () => {
    function apiToken() {
      return stubFetch(() => ({ status: 200, body: { access_token: 'gremlin_oat_api_secret', expires_in: 300 } }));
    }

    it('exchanges once for every exchanger sharing the store', async () => {
      // Several instances behind a load balancer: without sharing, each one exchanges the same
      // client token, multiplying load on the authorization server by the instance count.
      const fetchMock = apiToken();
      const store = new MemoryStore();

      const first = await new TokenExchanger(CONFIG, store).exchange(SUBJECT);
      const second = await new TokenExchanger(CONFIG, store).exchange(SUBJECT);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(second).toEqual(first);
    });

    it('stores neither the exchanged token nor the client token in readable form', async () => {
      // With Redis these entries leave the process. Whoever can read the store must not get a
      // live API credential out of it.
      apiToken();
      const store = new MemoryStore();
      const set = vi.spyOn(store, 'set');

      await new TokenExchanger(CONFIG, store).exchange(SUBJECT);

      expect(set).toHaveBeenCalledTimes(1);
      const [key, value] = set.mock.calls[0];
      for (const stored of [key, value, Buffer.from(value, 'base64').toString('latin1')]) {
        expect(stored).not.toContain('gremlin_oat_api_secret');
        expect(stored).not.toContain(SUBJECT);
      }
    });

    it('expires the stored entry before the token it holds', async () => {
      // Redis drops the entry on its own, so its TTL is the only thing keeping a stale token out.
      apiToken();
      const store = new MemoryStore();
      const set = vi.spyOn(store, 'set');

      await new TokenExchanger(CONFIG, store).exchange(SUBJECT);

      const ttl = set.mock.calls[0][2];
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThan(300_000);
    });

    it('reads the store once per token, not once per API call', async () => {
      // Every upstream API call resolves the token, and with Redis each read is a round trip plus
      // an unseal. A tool making ten calls should not make ten of each.
      apiToken();
      const store = new MemoryStore();
      const get = vi.spyOn(store, 'get');
      const writer = new TokenExchanger(CONFIG, store);
      const reader = new TokenExchanger(CONFIG, store);

      await writer.exchange(SUBJECT);
      await writer.exchange(SUBJECT);
      for (let i = 0; i < 3; i++) await reader.exchange(SUBJECT);

      // The writer's one miss, and the reader's one fill from the store.
      expect(get).toHaveBeenCalledTimes(2);
    });

    it('does not serve a locally held token past its expiry', async () => {
      // The local copy's own TTL is wall-clock and knows nothing of the token's.
      let now = 1_000_000;
      const fetchMock = stubFetch(() => ({ status: 200, body: { access_token: 'gremlin_oat_api', expires_in: 60 } }));
      const exchanger = new TokenExchanger(CONFIG, new MemoryStore(() => now), () => now);

      await exchanger.exchange(SUBJECT);
      now += 31_000;
      await exchanger.exchange(SUBJECT);

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('treats an entry it cannot open as a miss', async () => {
      // Corruption, or a value written by something else. Either way it must not surface as a token.
      const fetchMock = apiToken();
      const store = new MemoryStore();
      const set = vi.spyOn(store, 'set');
      await new TokenExchanger(CONFIG, store).exchange(SUBJECT);
      const key = set.mock.calls[0][0];

      for (const junk of ['', 'not base64 at all', Buffer.alloc(64).toString('base64')]) {
        await store.set(key, junk, 60_000);
        // A fresh exchanger, i.e. another instance, so the read reaches the store.
        expect(await new TokenExchanger(CONFIG, store).exchange(SUBJECT)).toMatchObject({
          ok: true,
          accessToken: 'gremlin_oat_api_secret',
        });
      }
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });
  });
});
