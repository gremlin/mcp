import { describe, it, expect, vi, afterEach } from 'vitest';

import { TokenExchanger } from '../../src/auth/token-exchange';

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
    const exchanger = new TokenExchanger(CONFIG, () => now);

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
    const exchanger = new TokenExchanger(CONFIG);

    await exchanger.exchange(SUBJECT);
    await exchanger.exchange(SUBJECT);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(exchanger.size()).toBe(0);
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

  it('forgets a token on request', async () => {
    const fetchMock = stubFetch(() => ({
      status: 200,
      body: { access_token: 'gremlin_oat_api', expires_in: 300 },
    }));
    const exchanger = new TokenExchanger(CONFIG);

    await exchanger.exchange(SUBJECT);
    exchanger.forget(SUBJECT);
    await exchanger.exchange(SUBJECT);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
