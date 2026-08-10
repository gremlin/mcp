import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GremlinApi, GremlinApiError, isJsonContentTypeHeader } from '../../src/client/gremlin';

function mockResponse(status: number, body: string, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => body,
  };
}

describe('isJsonContentTypeHeader', () => {
  it('is true for application/json', () => {
    expect(isJsonContentTypeHeader('application/json')).toBe(true);
  });

  it('is true for application/json with a charset parameter', () => {
    expect(isJsonContentTypeHeader('application/json; charset=utf-8')).toBe(true);
  });

  it('is true for +json media-type suffixes', () => {
    expect(isJsonContentTypeHeader('application/problem+json')).toBe(true);
  });

  it('is false for text/plain', () => {
    expect(isJsonContentTypeHeader('text/plain')).toBe(false);
  });

  it('is false for null', () => {
    expect(isJsonContentTypeHeader(null)).toBe(false);
  });
});

describe('GremlinApi#execute (execute_gremlin_api)', () => {
  let api: GremlinApi;

  beforeEach(() => {
    api = new GremlinApi();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses a JSON body and reports isJsonBody: true', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResponse(200, '{"id":"abc-123"}', { 'content-type': 'application/json' }),
    );

    const result = await api.execute('GET', 'services/abc-123');

    expect(result).toEqual({
      status: 200,
      contentType: 'application/json',
      isJsonBody: true,
      body: { id: 'abc-123' },
    });
  });

  // The exact bug being fixed: creating a Service/Scenario/ScenarioRun returns
  // a bare-text ID, not JSON. Previously this crashed with an opaque
  // SyntaxError instead of surfacing the ID.
  it('returns the raw text body and isJsonBody: false for a non-JSON success response', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResponse(201, 'f47ac10b-58cc-4372-a567-0e02b2c3d479', { 'content-type': 'text/plain' }),
    );

    const result = await api.execute('POST', 'scenarios');

    expect(result).toEqual({
      status: 201,
      contentType: 'text/plain',
      isJsonBody: false,
      body: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    });
  });

  it('falls back to raw text when content-type claims JSON but the body does not parse', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResponse(200, 'not actually json', { 'content-type': 'application/json' }),
    );

    const result = await api.execute('GET', 'services/abc-123');

    expect(result.isJsonBody).toBe(false);
    expect(result.body).toBe('not actually json');
  });

  it('treats a missing content-type header as non-JSON', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse(204, ''));

    const result = await api.execute('DELETE', 'services/abc-123');

    expect(result).toEqual({ status: 204, contentType: null, isJsonBody: false, body: '' });
  });

  it('does not retry and rejects with a clear message on a 4xx response', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse(400, 'bad request'));

    await expect(api.execute('POST', 'scenarios')).rejects.toThrow(/HTTP 400: bad request/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('labels a 4xx error as something the caller can fix by changing arguments', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse(422, 'invalid teamId'));

    await expect(api.execute('POST', 'scenarios')).rejects.toThrow(
      /Check the arguments you provided and retry with corrected input/,
    );
  });

  it('labels a 5xx error as not fixable by retrying with different arguments', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse(500, 'boom'));

    await expect(api.execute('GET', 'services')).rejects.toThrow(
      /server-side error, not a problem with your input.*do not retry/,
    );
  });

  it('labels a 401/403/429 error as not fixable by changing arguments', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse(429, 'rate limited'));

    await expect(api.execute('GET', 'services')).rejects.toThrow(
      /authentication, authorization, billing, or rate-limit error/,
    );
  });

  // Confirmed against the real Gremlin API spec: 402 appears on POST
  // /scenarios (among others) as "Payment Required" — a billing/plan issue,
  // not something fixable by changing the call's arguments.
  it('labels a 402 error as not fixable by changing arguments', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse(402, 'Payment Required'));

    await expect(api.execute('POST', 'scenarios')).rejects.toThrow(
      /authentication, authorization, billing, or rate-limit error/,
    );
  });

  it('classifies a body-read failure on an otherwise-successful response as not an input error', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => { throw new Error('connection reset'); },
    });

    const error: unknown = await api.execute('GET', 'services').catch(e => e);

    expect(error).toBeInstanceOf(GremlinApiError);
    expect((error as GremlinApiError).isInputError).toBe(false);
    expect((error as Error).message).toMatch(/Failed to read the Gremlin API response body: connection reset/);
  });
});

describe('GremlinApi typed methods (JSON-only endpoints)', () => {
  let api: GremlinApi;

  beforeEach(() => {
    api = new GremlinApi();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses a normal JSON response', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResponse(200, '[{"identifier":"team-1","name":"Team One"}]', {
        'content-type': 'application/json',
      }),
    );

    const teams = await api.listTeams();
    expect(teams).toEqual([{ identifier: 'team-1', name: 'Team One' }]);
  });

  // jsonRequestWithRetry delegates to fetchWithRetry for the actual network
  // attempt(s), so a 5xx (or a network-level failure — see the equivalent
  // test on execute() above) must retry through a typed method exactly the
  // same way it does through execute(). There's only one retry loop now, but
  // this confirms delegation actually wires it through rather than silently
  // swallowing maxRetries.
  it('retries a 5xx through a typed method and eventually succeeds', async () => {
    (fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(mockResponse(500, 'boom'))
      .mockResolvedValueOnce(
        mockResponse(200, '[{"identifier":"team-1","name":"Team One"}]', {
          'content-type': 'application/json',
        }),
      );

    const teams = await api.listTeams();

    expect(teams).toEqual([{ identifier: 'team-1', name: 'Team One' }]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 4xx through a typed method', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse(404, 'not found'));

    await expect(api.listTeams()).rejects.toThrow(/HTTP 404: not found/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  // Guards against the opaque `Unexpected token ... in JSON` SyntaxError this
  // used to throw — the message must disclose the actual response and make
  // clear this isn't something the caller's arguments can fix.
  it('throws a clear, non-cryptic error when the body is not valid JSON', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse(200, '<html>oops</html>'));

    await expect(api.listTeams()).rejects.toThrow(
      /Expected a JSON response body.*HTTP 200.*<html>oops<\/html>.*not caused by your input/,
    );
  });

  // jsonRequestWithRetry deliberately does not retry a parse failure — it
  // delegates a single attempt to fetchWithRetry (which retries network/HTTP
  // failures) and parses once, matching psyduck's reference implementation
  // (jsonRequestWithRetry = fetchWithRetry + one parseJsonBody call). A
  // successfully-received-but-unparseable body isn't a transient condition a
  // fresh request would fix, and the thrown error already tells the caller
  // not to retry — so retrying it internally would just be two wasted
  // round-trips before reaching the same conclusion.
  it('does not retry on a malformed JSON body — fails on the first attempt even if a later one would have succeeded', async () => {
    (fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(mockResponse(200, 'not json'))
      .mockResolvedValueOnce(
        mockResponse(200, '[{"identifier":"team-1","name":"Team One"}]', {
          'content-type': 'application/json',
        }),
      );

    await expect(api.listTeams()).rejects.toThrow(/Expected a JSON response body/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

// These exercise the structural marker directly (not just message text), since
// that's what any future programmatic consumer — e.g. structuredContent, or a
// central catch block — would actually read. Every GremlinApi failure mode
// should surface as a GremlinApiError with isInputError explicitly set.
describe('GremlinApiError classification', () => {
  let api: GremlinApi;

  beforeEach(() => {
    api = new GremlinApi();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function catchError(promise: Promise<unknown>): Promise<unknown> {
    try {
      await promise;
    } catch (error) {
      return error;
    }
    throw new Error('expected promise to reject');
  }

  it('classifies a 4xx response as an input error, carrying the status code', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse(422, 'invalid teamId'));

    const error = await catchError(api.execute('POST', 'scenarios'));

    expect(error).toBeInstanceOf(GremlinApiError);
    expect((error as GremlinApiError).isInputError).toBe(true);
    expect((error as GremlinApiError).statusCode).toBe(422);
  });

  it('classifies a 5xx response as not an input error', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse(500, 'boom'));

    const error = await catchError(api.execute('GET', 'services'));

    expect(error).toBeInstanceOf(GremlinApiError);
    expect((error as GremlinApiError).isInputError).toBe(false);
    expect((error as GremlinApiError).statusCode).toBe(500);
  });

  it('classifies 401/403/429 as not an input error even though they are 4xx', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse(401, 'unauthorized'));

    const error = await catchError(api.execute('GET', 'services'));

    expect(error).toBeInstanceOf(GremlinApiError);
    expect((error as GremlinApiError).isInputError).toBe(false);
  });

  it('classifies an unparseable JSON body as not an input error', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse(200, '<html>oops</html>'));

    const error = await catchError(api.listTeams());

    expect(error).toBeInstanceOf(GremlinApiError);
    expect((error as GremlinApiError).isInputError).toBe(false);
    expect((error as GremlinApiError).statusCode).toBe(200);
  });

  it('classifies a missing required argument as an input error', async () => {
    const error = await catchError(api.getTeam(''));

    expect(error).toBeInstanceOf(GremlinApiError);
    expect((error as GremlinApiError).isInputError).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  // The gap called out in review: a transport failure (DNS, connection reset)
  // never reaches api.gremlin.com, so it's not the caller's fault either — but
  // fetch() throws a bare, unclassified error here, not a GremlinApiError.
  // Without wrapping it, it would reach the tool-calling model indistinguishable
  // from any other error, with no signal that retrying can't help.
  it('wraps a raw network failure (fetch itself throwing) into a classified, non-input error', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new TypeError('fetch failed'));

    const error = await catchError(api.execute('GET', 'services'));

    expect(error).toBeInstanceOf(GremlinApiError);
    expect((error as GremlinApiError).isInputError).toBe(false);
    expect((error as Error).message).toMatch(/Network error calling the Gremlin API: fetch failed/);
    // Transport failures are still worth retrying (a request that errors,
    // rather than one where the call never went out, is not — see the 4xx
    // noRetry test above), so this should exhaust all 3 attempts.
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
